// SPDX-License-Identifier: Apache-2.0
// Shared fixtures of the board engine tests (W2-board-engine-core): contract boards built with the real
// `applyBoardOps`, a fake 04 `BoardDataStore` (optimistic apply + inverse-based undo/redo like 04 §7.2), and
// manual clocks for frames and timers.
import { vi } from 'vitest';
import {
  boardPagesOf,
  applyBoardChangeSet,
  applyBoardOps,
  emptyBoardDocument,
  isEmptyBoardChangeSet,
  type BoardDocument,
  type BoardNodeDraft,
  type BoardOp,
  type BoardOpResult,
  type BoardViewport,
} from '@open-design/contracts';

import type {
  BoardApplyOptions,
  BoardDataStore,
  BoardDataValue,
  BoardFocusIntent,
  BoardHostBindings,
  BoardStoreState,
} from '../../../src/fantay/board/data/types';

export const PROJECT_ID = 'p_board_test';

let idCounter = 0;
export function testId(prefix: 'n' | 'e' = 'n'): string {
  idCounter += 1;
  return `${prefix}_t${idCounter.toString(36).padStart(4, '0')}`;
}

/** A board document holding the given drafts (and edges), built through the contract op engine. */
export function makeBoard(drafts: BoardNodeDraft[], extraOps: BoardOp[] = [], projectId = PROJECT_ID): BoardDocument {
  const base = emptyBoardDocument(projectId);
  const ops: BoardOp[] = [...drafts.map((node) => ({ op: 'add', node }) as BoardOp), ...extraOps];
  if (ops.length === 0) return base;
  const outcome = applyBoardOps(base, ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'agent' },
    now: 1_000,
    newId: (prefix) => testId(prefix),
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(`fixture board invalid: ${JSON.stringify(outcome)}`);
  return { ...base, ...outcome.content, revision: 1, updatedAt: 1_000 };
}

export function frameDraft(id: string, x: number, y: number, path: string, size = { w: 1440, h: 900 }): BoardNodeDraft {
  return { kind: 'frame', id, x, y, w: size.w, h: size.h, ref: { path }, device: 'desktop' } as BoardNodeDraft;
}

export function noteDraft(id: string, x: number, y: number, text = 'hello'): BoardNodeDraft {
  return { kind: 'note', id, x, y, w: 280, h: 220, text } as BoardNodeDraft;
}

export function shapeDraft(id: string, x: number, y: number, w = 160, h = 120): BoardNodeDraft {
  return { kind: 'shape', id, x, y, w, h, shape: 'rect', fill: 'gray' } as BoardNodeDraft;
}

export function groupDraft(id: string, x: number, y: number, w: number, h: number, extra: Record<string, unknown> = {}): BoardNodeDraft {
  return { kind: 'group', id, x, y, w, h, role: 'section', layout: 'free', ...extra } as BoardNodeDraft;
}

export interface FakeDataStore extends BoardDataStore {
  readonly applyCalls: Array<{ ops: BoardOp[]; options: BoardApplyOptions | undefined }>;
  readonly viewports: BoardViewport[];
  setBoard(board: BoardDocument | null, patch?: Partial<BoardStoreState>): void;
  apply: BoardDataStore['apply'] & ReturnType<typeof vi.fn>;
  undo: BoardDataStore['undo'] & ReturnType<typeof vi.fn>;
  redo: BoardDataStore['redo'] & ReturnType<typeof vi.fn>;
  setViewport: BoardDataStore['setViewport'] & ReturnType<typeof vi.fn>;
}

/** Fake 04 store: applies ops optimistically with `applyBoardOps`, keeps server-style inverses for undo/redo. */
export function createFakeDataStore(initial: BoardDocument | null, init: Partial<BoardStoreState> = {}): FakeDataStore {
  let state: BoardStoreState = {
    status: initial ? 'ready' : 'loading',
    board: initial,
    serverRevision: initial?.revision ?? 0,
    initialViewport: null,
    pages: initial ? boardPagesOf(initial) : boardPagesOf({}),
    activePageId: (initial ? boardPagesOf(initial) : boardPagesOf({}))[0]!.id,
    pendingOps: 0,
    lastError: null,
    canUndo: false,
    canRedo: false,
    ...init,
  };
  const listeners = new Set<() => void>();
  const undoStack: BoardOp[][] = [];
  const redoStack: BoardOp[][] = [];
  const applyCalls: Array<{ ops: BoardOp[]; options: BoardApplyOptions | undefined }> = [];
  const viewports: BoardViewport[] = [];
  let clock = 2_000;

  const emit = (): void => {
    for (const listener of [...listeners]) listener();
  };

  function run(ops: BoardOp[]): { ok: boolean; results?: BoardOpResult[]; inverse?: BoardOp[] } {
    const board = state.board;
    if (!board) return { ok: false };
    clock += 1;
    const outcome = applyBoardOps(board, ops, {
      baseRevision: board.revision,
      nextRevision: board.revision + 1,
      actor: { kind: 'user', clientId: 'test-client' },
      now: clock,
      newId: (prefix) => testId(prefix),
      checkConflicts: false,
    });
    if (!outcome.ok) return { ok: false };
    if (isEmptyBoardChangeSet(outcome.changes)) return { ok: true, results: outcome.results, inverse: [] };
    // like the 04 store: the change set keeps unchanged nodes' identity
    state = { ...state, board: { ...applyBoardChangeSet(board, outcome.changes), updatedAt: clock } };
    return { ok: true, results: outcome.results, inverse: outcome.inverse };
  }

  const store = {
    applyCalls,
    viewports,
    getState: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: vi.fn(async () => {}),
    apply: vi.fn(async (ops: BoardOp[], options?: BoardApplyOptions) => {
      applyCalls.push({ ops, options });
      const result = run(ops);
      if (result.ok && result.inverse && result.inverse.length > 0 && options?.undoable !== false) {
        undoStack.push(result.inverse);
        redoStack.length = 0;
      }
      state = { ...state, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
      emit();
      return { ok: result.ok, ...(result.results ? { results: result.results } : {}) };
    }),
    sync: vi.fn(async () => null),
    setViewport: vi.fn((viewport: BoardViewport) => {
      viewports.push(viewport);
    }),
    undo: vi.fn(async () => {
      const inverse = undoStack.pop();
      if (!inverse) return false;
      const result = run(inverse);
      if (result.inverse && result.inverse.length > 0) redoStack.push(result.inverse);
      state = { ...state, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
      emit();
      return result.ok;
    }),
    redo: vi.fn(async () => {
      const inverse = redoStack.pop();
      if (!inverse) return false;
      const result = run(inverse);
      if (result.inverse && result.inverse.length > 0) undoStack.push(result.inverse);
      state = { ...state, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 };
      emit();
      return result.ok;
    }),
    handleBusEvent: vi.fn(),
    pageViewport: () => null,
    setActivePage(pageId: string) {
      state = { ...state, activePageId: pageId };
      emit();
    },
    dispose: vi.fn(),
    setBoard(board: BoardDocument | null, patch: Partial<BoardStoreState> = {}) {
      state = { ...state, board, status: board ? 'ready' : state.status, ...patch };
      emit();
    },
  };
  return store as unknown as FakeDataStore;
}

export function hostBindings(overrides: Partial<BoardHostBindings> = {}): BoardHostBindings {
  return {
    projectId: PROJECT_ID,
    projectDir: null,
    active: true,
    readOnly: false,
    files: [],
    filesGeneration: 0,
    liveArtifacts: [],
    messages: [],
    activeConversationId: null,
    runInFlight: false,
    openRequest: null,
    onActiveContextChange: () => {},
    onUnplaceableOpenRequest: () => {},
    ...overrides,
  };
}

export function dataValue(
  store: BoardDataStore,
  overrides: { host?: Partial<BoardHostBindings>; focusIntent?: BoardFocusIntent | null; ack?: (nonce: number) => void; note?: () => void } = {},
): BoardDataValue {
  return {
    store,
    host: hostBindings(overrides.host),
    focusIntent: overrides.focusIntent ?? null,
    ackFocusIntent: overrides.ack ?? (() => {}),
    noteCameraInteraction: overrides.note ?? (() => {}),
    willHandleOpenRequest: () => false,
  };
}

/** Manual animation frames: callbacks run only on `flush()`. */
export function createFrameQueue() {
  let next = 1;
  const queue = new Map<number, () => void>();
  return {
    requestFrame(callback: () => void): number {
      const id = next;
      next += 1;
      queue.set(id, callback);
      return id;
    },
    cancelFrame(id: number): void {
      queue.delete(id);
    },
    /** runs every queued frame (and frames queued by them) up to `rounds` times */
    flush(rounds = 8): void {
      for (let round = 0; round < rounds && queue.size > 0; round += 1) {
        const callbacks = [...queue.values()];
        queue.clear();
        for (const callback of callbacks) callback();
      }
    },
    size: () => queue.size,
  };
}

/** Manual timers + clock. */
export function createManualTimers(start = 10_000) {
  let now = start;
  let next = 1;
  const timers = new Map<number, { at: number; callback: () => void }>();
  return {
    now: () => now,
    setTimer(callback: () => void, ms: number): number {
      const id = next;
      next += 1;
      timers.set(id, { at: now + ms, callback });
      return id;
    },
    clearTimer(id: unknown): void {
      timers.delete(id as number);
    },
    /** advances the clock, firing due timers in time order */
    advance(ms: number): void {
      const target = now + ms;
      for (;;) {
        let dueId: number | null = null;
        let dueAt = Infinity;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = Math.max(now, timer.at);
        timer.callback();
      }
      now = target;
    },
    pending: () => timers.size,
  };
}
