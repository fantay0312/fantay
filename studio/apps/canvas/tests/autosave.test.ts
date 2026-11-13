// SPDX-License-Identifier: Apache-2.0
/** Autosave (06 §3.8) with fake timers: debounce, max wait, single flight, re-save, conflict halt, read-only, errors. */
import { DesignBridgeFailure, type DesignSaveRequest, type DesignSaveResult } from '@open-design/contracts/runtime/design-editor-bridge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTOSAVE_DEBOUNCE_MS, AUTOSAVE_MAX_WAIT_MS, createAutosave } from '../src/fx/editor/autosave';

interface Harness {
  saves: DesignSaveRequest[];
  autosave: ReturnType<typeof createAutosave>;
  readOnly: { value: boolean };
  respond(result?: Partial<DesignSaveResult> | Error): void;
  pending(): number;
}

function harness(options: { manual?: boolean } = {}): Harness {
  const saves: DesignSaveRequest[] = [];
  const queue: Array<{ resolve(result: DesignSaveResult): void; reject(error: unknown): void }> = [];
  const readOnly = { value: false };
  let counter = 0;
  const autosave = createAutosave({
    serialize: async () => new Uint8Array([1, 2, 3]),
    save: (request) => {
      saves.push(request);
      if (!options.manual) {
        counter += 1;
        return Promise.resolve({ path: 'designs/a.fig', sha256: `sha-${counter}`, size: 3, savedAt: Date.now() });
      }
      return new Promise((resolve, reject) => queue.push({ resolve, reject }));
    },
    isReadOnly: () => readOnly.value,
    now: () => Date.now(),
    onForbidden: () => {
      readOnly.value = true;
    },
  });
  return {
    saves,
    autosave,
    readOnly,
    respond(result) {
      const next = queue.shift();
      if (!next) throw new Error('no save in flight');
      counter += 1;
      if (result instanceof Error) next.reject(result);
      else next.resolve({ path: 'designs/a.fig', sha256: `sha-${counter}`, size: 3, savedAt: Date.now(), ...result });
    },
    pending: () => queue.length,
  };
}

/** Lets the promise chain run (serialize → save) without moving the clock. */
async function settle() {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createAutosave', () => {
  it('ignores changes before the document is loaded, and the load itself', async () => {
    const { autosave, saves } = harness();
    autosave.onSceneChange(1);
    autosave.markLoaded('sha-base', 5);
    autosave.onSceneChange(5);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(saves).toHaveLength(0);
    expect(autosave.state.value.dirty).toBe(false);
  });

  it('debounces 1200 ms after the last change and sends the base sha', async () => {
    const { autosave, saves } = harness();
    autosave.markLoaded('sha-base', 0);
    autosave.onSceneChange(1);
    expect(autosave.state.value.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    autosave.onSceneChange(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS - 1);
    expect(saves).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({ reason: 'autosave', baseSha256: 'sha-base', format: 'fig' });
    expect(saves[0]!.bytes).toBeInstanceOf(ArrayBuffer);
    expect(autosave.state.value).toMatchObject({ dirty: false, saving: false, sha256: 'sha-1', error: null });
  });

  it('saves at most 10 s after the first unsaved change while edits continue', async () => {
    const { autosave, saves } = harness();
    autosave.markLoaded('sha-base', 0);
    for (let version = 1; version <= 30; version += 1) {
      autosave.onSceneChange(version);
      await vi.advanceTimersByTimeAsync(500);
      await settle();
      if (saves.length > 0) break;
    }
    expect(saves).toHaveLength(1);
    expect(Date.now()).toBe(AUTOSAVE_MAX_WAIT_MS);
  });

  it('keeps one save in flight and saves again when the scene moved during it', async () => {
    const h = harness({ manual: true });
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    expect(h.saves).toHaveLength(1);
    expect(h.autosave.state.value.saving).toBe(true);
    h.autosave.onSceneChange(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS * 3);
    await settle();
    expect(h.saves).toHaveLength(1);
    h.respond();
    await settle();
    expect(h.autosave.state.value.dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    expect(h.saves).toHaveLength(2);
    expect(h.saves[1]!.baseSha256).toBe('sha-1');
    h.respond();
    await settle();
    expect(h.autosave.state.value.dirty).toBe(false);
  });

  it('halts on CONFLICT until the host resolves it', async () => {
    const h = harness({ manual: true });
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    h.respond(new DesignBridgeFailure('CONFLICT', 'changed elsewhere', { currentSha256: 'sha-other' }));
    await settle();
    expect(h.autosave.halted).toBe(true);
    expect(h.autosave.state.value.error).toMatchObject({ code: 'CONFLICT', details: { currentSha256: 'sha-other' } });
    h.autosave.onSceneChange(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saves).toHaveLength(1);
    // "Overwrite": force with the sha now on disk resumes autosave.
    const forced = h.autosave.save('force', { baseSha256: 'sha-other' });
    await settle();
    expect(h.saves[1]).toMatchObject({ reason: 'force', baseSha256: 'sha-other' });
    h.respond();
    await expect(forced).resolves.toMatchObject({ sha256: 'sha-2' });
    expect(h.autosave.halted).toBe(false);
    expect(h.autosave.state.value.error).toBeNull();
  });

  it('never saves a read-only document but still reports it dirty', async () => {
    const h = harness();
    h.readOnly.value = true;
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saves).toHaveLength(0);
    expect(h.autosave.state.value.dirty).toBe(true);
    const flushed = await h.autosave.flush('flush');
    expect(flushed).toMatchObject({ saved: false, dirty: true, error: { code: 'READ_ONLY' } });
  });

  it('becomes read-only on FORBIDDEN and waits for the next change after TOO_LARGE', async () => {
    const h = harness({ manual: true });
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    h.respond(new DesignBridgeFailure('TOO_LARGE', 'over 64 MB'));
    await settle();
    expect(h.autosave.state.value.error?.code).toBe('TOO_LARGE');
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS);
    expect(h.saves).toHaveLength(1);
    h.autosave.onSceneChange(2);
    expect(h.autosave.state.value.error).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    expect(h.saves).toHaveLength(2);
    h.respond(new DesignBridgeFailure('FORBIDDEN', 'no write access'));
    await settle();
    expect(h.readOnly.value).toBe(true);
  });

  it('retries NETWORK failures after 2 s, 4 s and 8 s, then waits for a change', async () => {
    const h = harness({ manual: true });
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    for (const delay of [2000, 4000, 8000]) {
      h.respond(new DesignBridgeFailure('NETWORK', 'offline'));
      await settle();
      const before = h.saves.length;
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(h.saves).toHaveLength(before);
      await vi.advanceTimersByTimeAsync(1);
      await settle();
      expect(h.saves).toHaveLength(before + 1);
    }
    h.respond(new DesignBridgeFailure('NETWORK', 'offline'));
    await settle();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.saves).toHaveLength(4);
  });

  it('a flush queued behind a save in flight writes nothing more once that save covered every change', async () => {
    const h = harness({ manual: true });
    h.autosave.markLoaded('sha-base', 0);
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    expect(h.saves).toHaveLength(1);
    // The host's flush on close and the page's own visibilitychange / pagehide flushes arrive together.
    const flushes = [h.autosave.flush('flush'), h.autosave.flush('flush'), h.autosave.flush('manual')];
    await settle();
    h.respond();
    await settle();
    expect(h.saves).toHaveLength(1);
    expect(h.pending()).toBe(0);
    for (const flushed of await Promise.all(flushes)) expect(flushed).toEqual({ saved: true, dirty: false, sha256: 'sha-1' });
    // A change made while that save ran is still written by the flush behind it.
    h.autosave.onSceneChange(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    const behind = h.autosave.flush('flush');
    h.autosave.onSceneChange(3);
    h.respond();
    await settle();
    expect(h.saves).toHaveLength(3);
    h.respond();
    await expect(behind).resolves.toEqual({ saved: true, dirty: false, sha256: 'sha-3' });
  });

  it('flush saves pending changes, and reports a clean document as saved', async () => {
    const h = harness();
    h.autosave.markLoaded('sha-base', 0);
    expect(await h.autosave.flush('flush')).toEqual({ saved: true, dirty: false, sha256: 'sha-base' });
    expect(h.saves).toHaveLength(0);
    h.autosave.onSceneChange(1);
    const result = await h.autosave.flush('flush');
    expect(h.saves).toHaveLength(1);
    expect(h.saves[0]!.reason).toBe('flush');
    expect(result).toEqual({ saved: true, dirty: false, sha256: 'sha-1' });
  });

  it('creates new documents and copies with a null base', async () => {
    const h = harness();
    h.autosave.markLoaded(null, 0);
    await h.autosave.flush('convert', { baseSha256: null });
    expect(h.saves[0]).toMatchObject({ reason: 'convert', baseSha256: null });
    expect(h.saves[0]).not.toHaveProperty('targetPath');
    const copy = await h.autosave.save('copy', { targetPath: 'designs/a-2.fig', baseSha256: null });
    expect(h.saves[1]).toMatchObject({ reason: 'copy', baseSha256: null, targetPath: 'designs/a-2.fig' });
    expect(copy.sha256).toBe('sha-2');
    // Later saves are based on the latest result.
    h.autosave.onSceneChange(1);
    await h.autosave.flush('manual');
    expect(h.saves[2]).toMatchObject({ reason: 'manual', baseSha256: 'sha-2' });
  });

  it('stops tracking while another document loads', async () => {
    const h = harness();
    h.autosave.markLoaded('sha-a', 0);
    h.autosave.suspend();
    h.autosave.onSceneChange(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_MAX_WAIT_MS * 2);
    expect(h.saves).toHaveLength(0);
    h.autosave.markLoaded('sha-b', 1);
    h.autosave.onSceneChange(2);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_DEBOUNCE_MS);
    await settle();
    expect(h.saves[0]!.baseSha256).toBe('sha-b');
  });
});
