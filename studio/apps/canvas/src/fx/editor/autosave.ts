// SPDX-License-Identifier: Apache-2.0
/**
 * Autosave and dirty state (06 §3.8).
 *
 * - Changes during a load are ignored (`markLoaded` records the loaded scene version).
 * - A save starts 1200 ms after the last change, and at most 10 s after the first unsaved one
 *   while editing continues; saves run one at a time, and a change during a save schedules
 *   another.
 * - Read-only documents never save (they still show as dirty).
 * - CONFLICT halts autosave until the host resolves it (`markLoaded` after `document.open`, or a
 *   successful copy/force save). TOO_LARGE waits for the next change; FORBIDDEN and READ_ONLY
 *   make the document read-only; NETWORK retries after 2 s, 4 s and 8 s, then waits for the next
 *   change. Every error is surfaced through `state`.
 */
import { shallowRef, type ShallowRef } from 'vue';
import {
  DesignBridgeFailure,
  toDesignBridgeError,
  type DesignBridgeError,
  type DesignDocumentFormat,
  type DesignFlushResult,
  type DesignSaveRequest,
  type DesignSaveResult,
} from '@open-design/contracts/runtime/design-editor-bridge';

export interface AutosaveState {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  sha256: string | null;
  error: DesignBridgeError | null;
}

export type AutosaveReason = 'manual' | 'flush' | 'convert' | 'copy' | 'force';

export interface AutosaveSaveOptions {
  targetPath?: string;
  baseSha256?: string | null;
}

export interface AutosaveController {
  readonly state: Readonly<ShallowRef<AutosaveState>>;
  /** Stops tracking changes while another document loads (until `markLoaded`). */
  suspend(): void;
  markLoaded(sha256: string | null, sceneVersion: number): void;
  onSceneChange(sceneVersion: number): void;
  flush(reason: AutosaveReason, opts?: AutosaveSaveOptions): Promise<DesignFlushResult>;
  /** Saves now even when clean (copy / force / convert); resolves the host's result or rejects with a DesignBridgeFailure. */
  save(reason: AutosaveReason, opts?: AutosaveSaveOptions): Promise<DesignSaveResult>;
  /** True while a CONFLICT stops autosave. */
  readonly halted: boolean;
  dispose(): void;
}

export interface AutosaveDeps {
  serialize(): Promise<Uint8Array>;
  save(req: DesignSaveRequest): Promise<DesignSaveResult>;
  isReadOnly(): boolean;
  now(): number;
  format?(): DesignDocumentFormat;
  /** Called when the host answers FORBIDDEN / READ_ONLY: the document becomes read-only. */
  onForbidden?(): void;
  debounceMs?: number;
  maxWaitMs?: number;
}

export const AUTOSAVE_DEBOUNCE_MS = 1200;
export const AUTOSAVE_MAX_WAIT_MS = 10_000;
export const AUTOSAVE_NETWORK_RETRY_MS = [2000, 4000, 8000] as const;

type SaveReason = DesignSaveRequest['reason'];

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  if (bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength && bytes.buffer instanceof ArrayBuffer) {
    return bytes.buffer;
  }
  return bytes.slice().buffer as ArrayBuffer;
}

export function createAutosave(deps: AutosaveDeps): AutosaveController {
  const debounceMs = deps.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  const maxWaitMs = deps.maxWaitMs ?? AUTOSAVE_MAX_WAIT_MS;
  const state = shallowRef<AutosaveState>({ dirty: false, saving: false, lastSavedAt: null, sha256: null, error: null });

  let baseSha256: string | null = null;
  let loaded = false;
  let savedVersion = 0;
  let currentVersion = 0;
  let firstUnsavedAt: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  let pendingSaves = 0;
  let halted = false;
  let networkAttempt = 0;
  let disposed = false;

  const patch = (next: Partial<AutosaveState>) => {
    state.value = { ...state.value, ...next };
  };
  const unsaved = () => currentVersion !== savedVersion;

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function schedule(delay?: number) {
    clearTimer();
    if (disposed || halted || !loaded || deps.isReadOnly() || !unsaved()) return;
    const now = deps.now();
    firstUnsavedAt ??= now;
    const untilMaxWait = Math.max(0, firstUnsavedAt + maxWaitMs - now);
    timer = setTimeout(() => {
      timer = null;
      void enqueue('autosave').catch(() => undefined);
    }, delay ?? Math.min(debounceMs, untilMaxWait));
  }

  async function perform(reason: SaveReason, opts: AutosaveSaveOptions): Promise<DesignSaveResult | null> {
    if (disposed) throw new DesignBridgeFailure('CANCELLED', 'The editor closed');
    if (reason === 'autosave' && (!unsaved() || halted)) return null;
    // A flush or manual save queued behind a save that already wrote every change has nothing left.
    if ((reason === 'flush' || reason === 'manual') && !unsaved() && !state.value.dirty) return null;
    if (deps.isReadOnly()) throw new DesignBridgeFailure('READ_ONLY', 'This design is read-only');
    clearTimer();
    const version = currentVersion;
    patch({ saving: true });
    try {
      const bytes = await deps.serialize();
      const request: DesignSaveRequest = {
        bytes: toArrayBuffer(bytes),
        format: deps.format?.() ?? 'fig',
        baseSha256: opts.baseSha256 !== undefined ? opts.baseSha256 : baseSha256,
        reason,
        ...(opts.targetPath ? { targetPath: opts.targetPath } : {}),
      };
      const result = await deps.save(request);
      baseSha256 = result.sha256;
      savedVersion = Math.max(savedVersion, version);
      networkAttempt = 0;
      if (reason === 'copy' || reason === 'force' || reason === 'convert') halted = false;
      const dirty = unsaved();
      firstUnsavedAt = dirty ? deps.now() : null;
      patch({ saving: false, dirty, lastSavedAt: result.savedAt, sha256: result.sha256, error: null });
      if (dirty) schedule();
      return result;
    } catch (thrown) {
      const error = toDesignBridgeError(thrown);
      patch({ saving: false, error, dirty: unsaved() || reason === 'convert' || reason === 'copy' });
      if (error.code === 'CONFLICT') {
        halted = true;
        clearTimer();
      } else if (error.code === 'FORBIDDEN' || error.code === 'READ_ONLY') {
        clearTimer();
        deps.onForbidden?.();
      } else if (error.code === 'NETWORK' && reason === 'autosave' && networkAttempt < AUTOSAVE_NETWORK_RETRY_MS.length) {
        schedule(AUTOSAVE_NETWORK_RETRY_MS[networkAttempt++]);
      }
      throw new DesignBridgeFailure(error.code, error.message, error.details);
    }
  }

  /** Saves run strictly one after another. */
  function enqueue(reason: SaveReason, opts: AutosaveSaveOptions = {}): Promise<DesignSaveResult | null> {
    pendingSaves += 1;
    const task = chain.then(() => perform(reason, opts));
    chain = task.then(
      () => undefined,
      () => undefined,
    );
    void chain.then(() => {
      pendingSaves -= 1;
    });
    return task;
  }

  return {
    state,
    get halted() {
      return halted;
    },
    suspend() {
      clearTimer();
      loaded = false;
      firstUnsavedAt = null;
    },
    markLoaded(sha256, sceneVersion) {
      clearTimer();
      baseSha256 = sha256;
      loaded = true;
      savedVersion = sceneVersion;
      currentVersion = sceneVersion;
      firstUnsavedAt = null;
      halted = false;
      networkAttempt = 0;
      patch({ dirty: false, sha256, error: null });
    },
    onSceneChange(sceneVersion) {
      if (!loaded || sceneVersion === currentVersion) return;
      currentVersion = sceneVersion;
      if (!unsaved()) return;
      networkAttempt = 0;
      // A new change retries after TOO_LARGE / NETWORK; CONFLICT and READ_ONLY keep their error.
      const retryable = state.value.error?.code === 'TOO_LARGE' || state.value.error?.code === 'NETWORK';
      if (!state.value.dirty || retryable) patch({ dirty: true, ...(retryable ? { error: null } : {}) });
      schedule();
    },
    async flush(reason, opts = {}) {
      const force = reason === 'convert' || reason === 'copy' || reason === 'force' || !!opts.targetPath;
      if (!force && !unsaved() && pendingSaves === 0) {
        return { saved: !state.value.dirty, dirty: state.value.dirty, sha256: baseSha256 };
      }
      try {
        const result = await enqueue(force ? reason : unsaved() ? reason : 'autosave', opts);
        return { saved: !state.value.dirty, dirty: state.value.dirty, sha256: result?.sha256 ?? baseSha256 };
      } catch (thrown) {
        return { saved: false, dirty: state.value.dirty, sha256: baseSha256, error: toDesignBridgeError(thrown) };
      }
    },
    async save(reason, opts = {}) {
      const result = await enqueue(reason, opts);
      if (!result) throw new DesignBridgeFailure('INTERNAL', 'Nothing was saved');
      return result;
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
