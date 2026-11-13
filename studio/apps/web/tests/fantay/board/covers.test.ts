// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import type { BoardCoverRef, BoardNodeDraft, ChatMessage } from '@open-design/contracts';

import {
  captureLiveCover,
  COVER_MAX_EDGE,
  createCaptureQueue,
  isCoverFresh,
  needsCoverCapture,
  resolveCover,
  saveNodeCover,
  type CaptureLiveCoverDeps,
} from '../../../src/fantay/board/engine/covers';
import { toEngineNode } from '../../../src/fantay/board/model/contract-adapter';
import type { EngineNode } from '../../../src/fantay/board/model/types';
import { makeBoard } from './engine-fixtures';

const PROJECT = 'p_covers';

function boardCover(sourceMtime?: number): BoardCoverRef {
  return {
    source: 'board-cover',
    digest: 'a'.repeat(64),
    mime: 'image/webp',
    width: 768,
    height: 480,
    capturedAt: 1_000,
    ...(sourceMtime !== undefined ? { sourceMtime } : {}),
  };
}

function engineNode(draft: BoardNodeDraft): EngineNode {
  const board = makeBoard([draft], [], PROJECT);
  return toEngineNode(board.nodes[0]!);
}

function frame(cover?: BoardCoverRef, path = 'index.html'): EngineNode {
  return engineNode({ kind: 'frame', id: 'n_f', x: 0, y: 0, w: 1440, h: 900, ref: { path }, device: 'desktop', ...(cover ? { cover } : {}) } as BoardNodeDraft);
}

function snapshotMessage(label: string, url: string): ChatMessage {
  return {
    id: 'm1',
    role: 'assistant',
    content: '',
    artifactRefs: [{ id: 'a1', label, kind: 'html', displayPolicy: 'immutable_snapshot', snapshotUrl: url, snapshotState: 'ready' }],
  } as unknown as ChatMessage;
}

const input = (node: EngineNode, extra: Partial<Parameters<typeof resolveCover>[0]> = {}) => ({
  node,
  messages: [] as ChatMessage[],
  projectId: PROJECT,
  workspaceContext: null,
  ...extra,
});

describe('cover freshness (plan R1)', () => {
  it('is fresh up to sourceMtime + 1000; unknown file mtime counts as fresh; a cover without sourceMtime is stale', () => {
    expect(isCoverFresh(boardCover(5_000), 6_000)).toBe(true);
    expect(isCoverFresh(boardCover(5_000), 6_001)).toBe(false);
    expect(isCoverFresh(boardCover(5_000), undefined)).toBe(true);
    expect(isCoverFresh(boardCover(), 5_000)).toBe(false);
    expect(isCoverFresh(undefined, 5_000)).toBe(false);
  });

  it('asks for a capture only for a known file without a fresh cover', () => {
    expect(needsCoverCapture(frame(), 5_000)).toBe(true);
    expect(needsCoverCapture(frame(boardCover(5_000)), 5_500)).toBe(false);
    expect(needsCoverCapture(frame(boardCover(5_000)), 9_000)).toBe(true);
    expect(needsCoverCapture(frame(), undefined)).toBe(false);
  });
});

describe('cover precedence (03 §3.6): fresh board > chat snapshot > stale board > kind source > none', () => {
  const chat = [snapshotMessage('index.html', '/snap/1.png')];

  it('prefers a fresh board cover over a chat snapshot', () => {
    const cover = resolveCover(input(frame(boardCover(5_000)), { file: { mtime: 5_200 }, messages: chat }));
    expect(cover).toMatchObject({ stale: false, source: 'board' });
    expect(cover?.url).toContain('a'.repeat(64));
  });

  it('uses the chat snapshot when the board cover is stale', () => {
    expect(resolveCover(input(frame(boardCover(5_000)), { file: { mtime: 9_000 }, messages: chat }))).toEqual({
      url: '/snap/1.png',
      stale: true,
      source: 'chat-snapshot',
    });
  });

  it('falls back to the stale board cover, then the design export, then nothing', () => {
    expect(resolveCover(input(frame(boardCover(5_000)), { file: { mtime: 9_000 } }))).toMatchObject({ stale: true, source: 'board' });
    const design = engineNode({ kind: 'design', id: 'n_d', x: 0, y: 0, w: 800, h: 600, ref: { path: 'designs/a.fig' }, format: 'fig' } as BoardNodeDraft);
    expect(resolveCover(input(design, { designCoverUrl: '/design/a.png' }))).toEqual({ url: '/design/a.png', stale: false, source: 'design-export' });
    expect(resolveCover(input(frame()))).toBeUndefined();
  });

  it('matches chat snapshots by file label only', () => {
    expect(resolveCover(input(frame(undefined, 'other.html'), { messages: chat }))).toBeUndefined();
  });
});

describe('cover capture', () => {
  function deps(overrides: Partial<CaptureLiveCoverDeps> = {}): CaptureLiveCoverDeps {
    return {
      hostAvailable: () => true,
      captureHost: vi.fn(async () => ({ dataUrl: 'data:host', w: 800, h: 500 })),
      requestSnapshot: vi.fn(async () => ({ dataUrl: 'data:bridge', w: 1440, h: 900 })),
      downscale: vi.fn(async (src: Blob | string) => ({ blob: new Blob([String(src)]), width: 768, height: 480 })),
      viewport: () => ({ width: 1600, height: 1000 }),
      ...overrides,
    };
  }
  const iframe = (rect: { left: number; top: number; width: number; height: number }) =>
    ({ getBoundingClientRect: () => ({ ...rect, right: rect.left + rect.width, bottom: rect.top + rect.height }) }) as unknown as HTMLIFrameElement;

  it('uses the host compositor when it is present, preferred, on screen and drawn at ≥ 50 %', async () => {
    const d = deps();
    await captureLiveCover({ iframe: iframe({ left: 10, top: 10, width: 720, height: 450 }), preferHost: true, onScreenScale: 0.5 }, d);
    expect(d.captureHost).toHaveBeenCalledTimes(1);
    expect(d.requestSnapshot).not.toHaveBeenCalled();
    expect(d.downscale).toHaveBeenCalledWith('data:host', COVER_MAX_EDGE);
  });

  it('uses the snapshot bridge when the frame is selected/covered, partly off screen, small or without a host', async () => {
    for (const [preferHost, scale, rect, host] of [
      [false, 1, { left: 0, top: 0, width: 400, height: 300 }, true],
      [true, 0.4, { left: 0, top: 0, width: 400, height: 300 }, true],
      [true, 1, { left: -20, top: 0, width: 400, height: 300 }, true],
      [true, 1, { left: 0, top: 0, width: 400, height: 300 }, false],
    ] as const) {
      const d = deps({ hostAvailable: () => host });
      const image = await captureLiveCover({ iframe: iframe(rect), preferHost, onScreenScale: scale }, d);
      expect(d.captureHost).not.toHaveBeenCalled();
      expect(d.requestSnapshot).toHaveBeenCalledTimes(1);
      expect(image).toMatchObject({ width: 768, height: 480 });
    }
  });

  it('runs captures one at a time, in order', async () => {
    const queue = createCaptureQueue();
    const events: string[] = [];
    let release: () => void = () => {};
    const first = queue.run(
      () =>
        new Promise<string>((resolve) => {
          events.push('first:start');
          release = () => {
            events.push('first:end');
            resolve('a');
          };
        }),
    );
    const second = queue.run(async () => {
      events.push('second:start');
      return 'b';
    });
    await Promise.resolve();
    expect(queue.size()).toBe(2);
    expect(events).toEqual(['first:start']);
    release();
    await expect(first).resolves.toBe('a');
    await expect(second).resolves.toBe('b');
    expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    expect(queue.size()).toBe(0);
    // a failing task does not stall the queue
    await expect(queue.run(async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    await expect(queue.run(async () => 'c')).resolves.toBe('c');
  });

  it('uploads the cover (uploadBoardCover) and writes it with update {cover}', async () => {
    const cover = { ...boardCover(5_000) } as Extract<BoardCoverRef, { source: 'board-cover' }>;
    const upload = vi.fn(async () => ({ cover }));
    const update = vi.fn();
    const blob = new Blob(['x'], { type: 'image/webp' });
    const saved = await saveNodeCover(
      { projectId: PROJECT, nodeId: 'n_f', image: { blob, width: 768, height: 480 }, sourceMtime: 5_000, workspaceContext: null, update },
      { upload: upload as never },
    );
    expect(upload).toHaveBeenCalledWith(PROJECT, blob, { width: 768, height: 480, sourceMtime: 5_000 }, { workspaceContext: null });
    expect(update).toHaveBeenCalledWith('n_f', cover);
    expect(saved).toBe(cover);
    // an upload failure leaves the node alone
    const failing = vi.fn(async () => {
      throw new Error('offline');
    });
    const untouched = vi.fn();
    await expect(
      saveNodeCover({ projectId: PROJECT, nodeId: 'n_f', image: { blob, width: 1, height: 1 }, workspaceContext: null, update: untouched }, { upload: failing as never }),
    ).resolves.toBeNull();
    expect(untouched).not.toHaveBeenCalled();
  });
});
