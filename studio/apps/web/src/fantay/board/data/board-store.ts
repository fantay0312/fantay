// SPDX-License-Identifier: AGPL-3.0-only
// Board web store (spec 04 §7.1–§7.2, plan R1, amendment B13): the web source of truth for the board document.
//
// - Optimistic: `apply` fills draft ids, applies the ops locally with the contracts' `applyBoardOps`
//   (`checkConflicts: false`) and queues them; the view is always `acked server doc + pending ops`.
// - One PATCH in flight; queued applies are flushed in one microtask batch (≤ 200 ops). Undoable applies are
//   never mixed with other applies in one PATCH unless they share a `coalesceKey`, so every undo entry is exactly
//   one server inverse (or a composition of them, `undo-compose.ts`).
// - Conflicts: every op captures the `rev` of the entities it is checked against (the rev the user saw). Our own
//   acks advance those captures; remote changes (GET after `board-changed`, sync responses, 409) drop the ops
//   whose captures no longer match (remote wins). A local preflight against the acked doc (`checkConflicts: true`)
//   drops what the daemon would reject before sending.
// - Network/5xx: queue kept, retry with backoff 1 s → 30 s (`lastError: offline`). 403: queue dropped (`read-only`).
// - Undo/redo replay the daemon's inverses with fresh `expectRev`, only while this client is the last writer of
//   every touched entity.
// - B13: optimistic adds/connects/groups get `createdAt = max(now, last + 1) + k`; the server's value wins on commit.
import {
  applyBoardChangeSet,
  applyBoardOps,
  boardNodePageId,
  boardPagesOf,
  isEmptyBoardChangeSet,
  resolveBoardPageId,
  type BoardActor,
  type BoardApplyOutcome,
  type BoardChangeSet,
  type BoardContent,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
  type BoardOp,
  type BoardOpResult,
  type BoardPage,
  type BoardPatchRequest,
  type BoardPatchResponse,
  type BoardSyncReason,
  type BoardSyncRequest,
  type BoardSyncResponse,
  type BoardViewport,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { BackoffController } from '../../../lib/backoff';
import * as boardApi from './board-api';
import { BoardRequestError, isBoardOfflineError } from './board-api';
import { createBoardEntityId } from './client-id';
import {
  BOARD_OFFLINE_BACKOFF_INITIAL_MS,
  BOARD_OFFLINE_BACKOFF_MAX_MS,
  BOARD_PATCH_BATCH_MAX_OPS,
  BOARD_PATCH_RETRY_LIMIT,
  BOARD_REMOTE_REFETCH_COALESCE_MS,
  BOARD_SYNC_COALESCE_MS,
  BOARD_UNDO_COALESCE_MS,
  BOARD_UNDO_DEPTH,
  BOARD_VIEWPORT_SAVE_DEBOUNCE_MS,
} from './constants';
import {
  boardChangeRemovedIds,
  boardChangeTouchedIds,
  boardContentOf,
  boardCreatedIdsInOpOrder,
  boardOpRevTargets,
  boardWithContent,
  fillBoardOpIds,
  maxBoardCreatedAt,
  opIndexOfIssuePath,
  restampBoardCreatedAt,
  sanitizeBoardRefIdentities,
  withActivePage,
  withBoardExpectRev,
} from './op-model';
import type {
  BoardApplyOptions,
  BoardDataStore,
  BoardProjectBusEvent,
  BoardStoreErrorCode,
  BoardStoreState,
  BoardUndoEntry,
} from './types';
import { composeBoardInverses } from './undo-compose';

export type {
  BoardApplyOptions,
  BoardDataStore,
  BoardProjectBusEvent,
  BoardStore,
  BoardStoreErrorCode,
  BoardStoreState,
  BoardUndoEntry,
} from './types';

type BoardApiModule = typeof boardApi;
type TimerHandle = ReturnType<typeof setTimeout>;

export interface CreateBoardStoreDeps {
  projectId: string;
  clientId: string;
  workspaceContext: WorkspaceCollabContext | null;
  readOnly: boolean;
  api?: Partial<BoardApiModule>;
  now?: () => number;
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
  newId?: (prefix: 'n' | 'e') => string;
}

/** Undo/redo stack entry with the bookkeeping the last-writer check and coalescing need. */
interface StackEntry extends BoardUndoEntry {
  /** Entities the committed change removed (still allowed when absent later). */
  removedIds: string[];
  /** Apply time of the first apply in the entry (coalescing window). */
  firstAt: number;
  /** Parts of one oversized apply always merge into one entry. */
  undoGroup: string | null;
}

interface ApplyHandle {
  partsLeft: number;
  ok: boolean;
  results: BoardOpResult[];
  settle(ok: boolean, results: BoardOpResult[]): void;
}

type NormalizedApplyOptions = { undoable: boolean; silentConflict: boolean; label?: string; coalesceKey?: string };

interface PendingApply {
  /** Ops to send (ids filled), in order. */
  ops: BoardOp[];
  /** `ops[i]` came from the caller's op `callerIndex[i]`. */
  callerIndex: number[];
  /** Per op: entity id → rev captured from the acked doc (null: not acked yet, filled at send time). */
  captured: Array<Map<string, number | null>>;
  dropped: boolean[];
  options: NormalizedApplyOptions;
  at: number;
  /** B13 optimistic createdAt of the entities this apply creates (reused when the view is recomputed). */
  stamps: Map<string, number>;
  undoGroup: string | null;
  history: { kind: 'undo' | 'redo'; entry: StackEntry } | null;
  /** Read-only store: kept only in the local view until the next GET. */
  localOnly: boolean;
  inFlight: boolean;
  serverResults: Map<number, BoardOpResult>;
  handle: ApplyHandle;
}

interface InFlightBatch {
  applies: PendingApply[];
  /** PATCH op k = op `entries[k].opIndex` of `entries[k].apply`. */
  entries: Array<{ apply: PendingApply; opIndex: number }>;
  ops: BoardOp[];
}

type PrepareResult = { kind: 'send'; batch: InFlightBatch } | { kind: 'progress' } | { kind: 'refetch' };

const SYNC_REASON_PRIORITY: readonly BoardSyncReason[] = [
  'manual', 'open', 'files-changed', 'media', 'run-started', 'run-finished', 'focus',
];
const MAX_SYNC_FOCUS_NAMES = 100;
const KEEPALIVE_BODY_LIMIT = 60_000;

const INITIAL_STATE: BoardStoreState = {
  status: 'idle',
  board: null,
  serverRevision: 0,
  initialViewport: null,
  pages: boardPagesOf({}),
  activePageId: boardPagesOf({})[0]!.id,
  pendingOps: 0,
  lastError: null,
  canUndo: false,
  canRedo: false,
};

/** Merges two sync requests (spec 04 §7.2): reason by priority, focus names unioned, the latest turn hint wins. */
export function mergeBoardSyncRequests(a: BoardSyncRequest, b: BoardSyncRequest): BoardSyncRequest {
  const reason = SYNC_REASON_PRIORITY.indexOf(b.reason) >= SYNC_REASON_PRIORITY.indexOf(a.reason) ? b.reason : a.reason;
  const conversationId = b.conversationId ?? a.conversationId;
  const turn = b.turn ?? a.turn;
  let focus: BoardSyncRequest['focus'];
  if (a.focus || b.focus) {
    const names = [...new Set([...(a.focus?.names ?? []), ...(b.focus?.names ?? [])])].slice(0, MAX_SYNC_FOCUS_NAMES);
    const primary = b.focus?.primary ?? a.focus?.primary;
    const near = b.focus?.near ?? a.focus?.near;
    focus = { names, ...(primary !== undefined ? { primary } : {}), ...(near !== undefined ? { near } : {}) };
  }
  return {
    reason,
    ...(conversationId !== undefined ? { conversationId } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(focus && focus.names.length > 0 ? { focus } : {}),
  };
}

function errorMessage(error: unknown): string | undefined {
  return error instanceof Error && error.message ? error.message : undefined;
}

function outcomeMessage(outcome: Extract<BoardApplyOutcome, { ok: false }>): string {
  if (outcome.reason === 'invalid') return outcome.issues[0]?.message ?? 'invalid board change';
  if (outcome.reason === 'limit') return `board limit ${outcome.details.limit} exceeded`;
  return 'board change conflicts with the current board';
}

function sameSettings(a: BoardDocument['settings'], b: BoardDocument['settings']): boolean {
  return a.background === b.background && a.autoPlace === b.autoPlace;
}

function samePages(a: readonly BoardPage[] | undefined, b: readonly BoardPage[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  return a.every((page, index) => page.id === b[index]!.id && page.title === b[index]!.title);
}

/**
 * A fetched document with the previous objects reused where `(id, rev)` did not change (a rev bump accompanies
 * every committed change), so unchanged nodes keep their identity for the engine's per-node memoization.
 */
function reconcileBoardDocument(previous: BoardDocument | null, next: BoardDocument): BoardDocument {
  if (!previous) return next;
  const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
  let nodesSame = previous.nodes.length === next.nodes.length;
  const nodes = next.nodes.map((node, index) => {
    const old = oldNodes.get(node.id);
    if (old && old.rev === node.rev && old.kind === node.kind) {
      if (previous.nodes[index] !== old) nodesSame = false;
      return old;
    }
    nodesSame = false;
    return node;
  });
  const oldEdges = new Map(previous.edges.map((edge) => [edge.id, edge]));
  let edgesSame = previous.edges.length === next.edges.length;
  const edges = next.edges.map((edge, index) => {
    const old = oldEdges.get(edge.id);
    if (old && old.rev === edge.rev) {
      if (previous.edges[index] !== old) edgesSame = false;
      return old;
    }
    edgesSame = false;
    return edge;
  });
  const settingsSame = sameSettings(previous.settings, next.settings);
  const pagesSame = samePages(previous.pages, next.pages);
  if (
    nodesSame && edgesSame && settingsSame && pagesSame
    && previous.title === next.title && previous.revision === next.revision
  ) {
    return previous;
  }
  return {
    ...next,
    nodes: nodesSame ? previous.nodes : nodes,
    edges: edgesSame ? previous.edges : edges,
    settings: settingsSame ? previous.settings : next.settings,
    ...(pagesSame && previous.pages ? { pages: previous.pages } : {}),
  };
}

export function createBoardStore(deps: CreateBoardStoreDeps): BoardDataStore {
  const { projectId, clientId, workspaceContext } = deps;
  const api: BoardApiModule = { ...boardApi, ...(deps.api ?? {}) } as BoardApiModule;
  const now = deps.now ?? (() => Date.now());
  const setT = deps.setTimeoutFn ?? setTimeout;
  const clearT = deps.clearTimeoutFn ?? clearTimeout;
  const newId = deps.newId ?? createBoardEntityId;
  const actor: BoardActor = { kind: 'user', clientId };

  const abort = new AbortController();
  const listeners = new Set<() => void>();
  const backoff = new BackoffController({
    initialMs: BOARD_OFFLINE_BACKOFF_INITIAL_MS,
    maxMs: BOARD_OFFLINE_BACKOFF_MAX_MS,
    factor: 2,
    jitter: false,
  });

  let state: BoardStoreState = INITIAL_STATE;
  let status: BoardStoreState['status'] = 'idle';
  let lastError: BoardStoreState['lastError'] = null;
  let serverDoc: BoardDocument | null = null;
  let nodeIndex = new Map<string, BoardNode>();
  let edgeIndex = new Map<string, BoardEdge>();
  let serverMaxCreatedAt = 0;
  let view: BoardDocument | null = null;
  let initialViewport: BoardViewport | null = null;
  let activePageId = INITIAL_STATE.activePageId;
  const pageViewports = new Map<string, BoardViewport>();

  const queue: PendingApply[] = [];
  let inflight: InFlightBatch | null = null;
  let seqCounter = 0;
  let lastStamp = 0;
  let conflictRounds = 0;
  let forbidden = false;
  let disposed = false;

  const undoStack: StackEntry[] = [];
  const redoStack: StackEntry[] = [];
  /** The entry the last undoable commit pushed or merged into (coalescing target); null after undo/redo. */
  let lastPushed: StackEntry | null = null;
  const removedByMe = new Set<string>();

  let flushScheduled = false;
  let retryTimer: TimerHandle | null = null;

  let fetchPromise: Promise<void> | null = null;
  let refetchWanted = false;
  let refetchTimer: TimerHandle | null = null;
  /**
   * A response revealed commits the acked doc lacks (a gap). Until the next full GET, a later change set may be one
   * the doc can no longer take (our own PATCH overtaken by a sync response), so queued ops are not preflighted
   * against it: a successful PATCH re-reads the board before sending more.
   */
  let ackedIncomplete = false;

  let viewportTimer: TimerHandle | null = null;
  let pendingViewport: BoardViewport | null = null;
  let lastSavedViewport: BoardViewport | null = null;
  /** Page `pendingViewport` / `lastSavedViewport` belong to. */
  let viewportPageId = activePageId;
  let pageHideBound = false;

  let syncPending: { request: BoardSyncRequest; waiters: Array<(response: BoardSyncResponse | null) => void> } | null = null;
  let syncTimer: TimerHandle | null = null;
  let syncInFlight = false;

  let idleWaiters: Array<() => void> = [];

  const readOnly = (): boolean => deps.readOnly || forbidden;
  const fetching = (): boolean => fetchPromise !== null;

  // ---- state ------------------------------------------------------------------------------------------

  function pendingOpCount(): number {
    let count = 0;
    for (const apply of queue) {
      if (apply.localOnly) continue;
      apply.dropped.forEach((dropped) => {
        if (!dropped) count += 1;
      });
    }
    return count;
  }

  function currentPages(): readonly BoardPage[] {
    return view ? boardPagesOf(view) : INITIAL_STATE.pages;
  }

  function publish(): void {
    if (disposed) return;
    const pages = currentPages();
    // The shown page can disappear (undo, another client): fall back to the first one.
    activePageId = resolveBoardPageId(pages, activePageId);
    const next: BoardStoreState = {
      status,
      board: view,
      serverRevision: serverDoc?.revision ?? 0,
      initialViewport,
      pages: samePages(state.pages, pages) ? state.pages : pages,
      activePageId,
      pendingOps: pendingOpCount(),
      lastError,
      canUndo: !readOnly() && undoStack.length > 0,
      canRedo: !readOnly() && redoStack.length > 0,
    };
    const prev = state;
    if (
      prev.status === next.status && prev.board === next.board && prev.serverRevision === next.serverRevision
      && prev.initialViewport === next.initialViewport && prev.pendingOps === next.pendingOps
      && prev.pages === next.pages && prev.activePageId === next.activePageId
      && prev.lastError === next.lastError && prev.canUndo === next.canUndo && prev.canRedo === next.canRedo
    ) {
      return;
    }
    state = next;
    for (const listener of [...listeners]) listener();
  }

  function setError(code: BoardStoreErrorCode, message?: string): void {
    lastError = { code, ...(message ? { message } : {}), at: now() };
  }

  function clearError(...codes: BoardStoreErrorCode[]): void {
    if (lastError && codes.includes(lastError.code)) lastError = null;
  }

  function guarded(label: string, run: () => void): void {
    try {
      run();
    } catch (error) {
      if (typeof console !== 'undefined') console.warn(`[fantay-board] ${label} failed`, error);
    }
  }

  // ---- acked server doc -------------------------------------------------------------------------------

  function setServerDoc(doc: BoardDocument): void {
    serverDoc = doc;
    nodeIndex = new Map(doc.nodes.map((node) => [node.id, node]));
    edgeIndex = new Map(doc.edges.map((edge) => [edge.id, edge]));
    serverMaxCreatedAt = Math.max(serverMaxCreatedAt, maxBoardCreatedAt(doc));
  }

  function ackedRev(id: string): number | undefined {
    return nodeIndex.get(id)?.rev ?? edgeIndex.get(id)?.rev;
  }

  function localContext(at: number): Parameters<typeof applyBoardOps>[2] {
    const revision = serverDoc?.revision ?? 0;
    return { baseRevision: revision, nextRevision: revision + 1, actor, now: at, newId, checkConflicts: false };
  }

  function liveOps(apply: PendingApply): BoardOp[] {
    return apply.ops.filter((_, index) => !apply.dropped[index]);
  }

  /** view = acked doc + every pending apply (B13 stamps reused). */
  function recomputeView(): void {
    if (!serverDoc) {
      view = null;
      return;
    }
    let content: BoardContent = boardContentOf(serverDoc);
    for (const apply of queue) {
      const ops = liveOps(apply);
      if (ops.length === 0) continue;
      const outcome = applyBoardOps(content, ops, localContext(apply.at));
      if (!outcome.ok || outcome.inverse.length === 0) continue;
      content = restampBoardCreatedAt(outcome.content, apply.stamps);
    }
    view = boardWithContent(serverDoc, content);
  }

  /**
   * Applies a committed change set to the acked doc. Returns true when the daemon has commits this store has not
   * seen (gap): the caller refetches.
   */
  function applyServerChanges(changes: BoardChangeSet, revision: number, own: { updatedAt: number } | null): boolean {
    if (!serverDoc) return false;
    const current = serverDoc.revision;
    if (changes.toRevision <= current) return revision > current;
    const gap = changes.fromRevision !== current || revision > changes.toRevision;
    let next = applyBoardChangeSet(serverDoc, changes);
    if (own) next = { ...next, updatedAt: own.updatedAt, updatedBy: actor };
    setServerDoc(next);
    return gap;
  }

  /**
   * Our own commit changed these entities: queued ops that were based on the same rev as the committed batch (or
   * on the pre-commit acked rev) now expect the new rev; ops on entities the batch created get their first rev.
   */
  function advanceCaptured(
    changes: BoardChangeSet,
    batchCaptured: ReadonlyMap<string, number>,
    before: { nodes: ReadonlyMap<string, BoardNode>; edges: ReadonlyMap<string, BoardEdge> },
    skip: ReadonlySet<PendingApply>,
  ): void {
    const newRevs = new Map<string, number>();
    for (const node of changes.upsertNodes) newRevs.set(node.id, node.rev);
    for (const edge of changes.upsertEdges) newRevs.set(edge.id, edge.rev);
    if (newRevs.size === 0) return;
    for (const apply of queue) {
      if (skip.has(apply) || apply.inFlight || apply.localOnly) continue;
      for (const captured of apply.captured) {
        for (const [id, rev] of captured) {
          const next = newRevs.get(id);
          if (next === undefined) continue;
          const basis = batchCaptured.get(id) ?? before.nodes.get(id)?.rev ?? before.edges.get(id)?.rev;
          if (rev === null || rev === basis) captured.set(id, next);
        }
      }
    }
  }

  // ---- settling and dropping applies ----------------------------------------------------------------------

  function removeFromQueue(apply: PendingApply): void {
    const index = queue.indexOf(apply);
    if (index >= 0) queue.splice(index, 1);
  }

  function settleApply(apply: PendingApply, committed: boolean): void {
    removeFromQueue(apply);
    const handle = apply.handle;
    for (const [callerIndex, result] of apply.serverResults) handle.results[callerIndex] = result;
    apply.dropped.forEach((dropped, index) => {
      if (!dropped) return;
      const callerIndex = apply.callerIndex[index]!;
      handle.results[callerIndex] = { index: callerIndex, status: 'skipped', ids: [] };
    });
    if (!committed || apply.dropped.some(Boolean)) handle.ok = false;
    handle.partsLeft -= 1;
    if (handle.partsLeft <= 0) handle.settle(handle.ok, handle.results);
  }

  /** Marks ops dropped (conflict). Returns the error the drop should surface: none for silent applies. */
  function dropOps(apply: PendingApply, indexes: Iterable<number>): BoardStoreErrorCode | null {
    let any = false;
    for (const index of indexes) {
      if (apply.dropped[index]) continue;
      apply.dropped[index] = true;
      any = true;
    }
    if (!any) return null;
    if (apply.history) return 'undo-blocked';
    return apply.options.silentConflict ? null : 'conflict';
  }

  function strongerError(current: BoardStoreErrorCode | null, next: BoardStoreErrorCode | null): BoardStoreErrorCode | null {
    if (next === null) return current;
    if (current === null) return next;
    return current === 'conflict' ? next : current;
  }

  /** Settles applies with nothing left to send; a history replay fails as a whole when any op was dropped. */
  function settleExhausted(): void {
    for (const apply of [...queue]) {
      if (apply.inFlight || apply.localOnly) continue;
      if (apply.dropped.every(Boolean) || (apply.history !== null && apply.dropped.some(Boolean))) settleApply(apply, false);
    }
  }

  /** Drops whole applies. `code` overrides the surfaced error (read-only / save-failed); null = conflict rule. */
  function dropApplies(applies: readonly PendingApply[], code: BoardStoreErrorCode | null, message?: string): void {
    let surface: BoardStoreErrorCode | null = null;
    for (const apply of applies) {
      surface = strongerError(surface, dropOps(apply, apply.ops.keys()));
      settleApply(apply, false);
    }
    if (applies.length > 0 && code !== null) surface = code;
    if (surface) setError(surface, surface === 'save-failed' ? message : undefined);
  }

  /** Remote change: queued ops whose captured revs no longer match the acked doc are dropped (remote wins). */
  function rebaseQueued(): void {
    let surface: BoardStoreErrorCode | null = null;
    for (const apply of queue) {
      if (apply.inFlight || apply.localOnly) continue;
      const stale: number[] = [];
      apply.captured.forEach((captured, index) => {
        if (apply.dropped[index]) return;
        for (const [id, rev] of captured) {
          if (rev !== null && ackedRev(id) !== rev) {
            stale.push(index);
            return;
          }
        }
      });
      surface = strongerError(surface, dropOps(apply, stale));
    }
    settleExhausted();
    if (surface) setError(surface);
  }

  // ---- idle waiters (undo/redo wait for the queue to drain) ------------------------------------------------

  function isIdle(): boolean {
    return !inflight && !fetching() && queue.every((apply) => apply.localOnly);
  }

  function resolveIdleWaiters(force = false): void {
    if (!force && !isIdle()) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  // ---- network lane: flush / PATCH ------------------------------------------------------------------------

  function hasSendable(): boolean {
    return queue.some((apply) => !apply.localOnly && !apply.inFlight && apply.dropped.some((dropped) => !dropped));
  }

  function canSend(): boolean {
    return serverDoc !== null && !inflight && !fetching() && retryTimer === null && !readOnly();
  }

  function scheduleFlush(): void {
    if (flushScheduled) return;
    flushScheduled = true;
    queueMicrotask(() => {
      flushScheduled = false;
      flush(false);
    });
  }

  function compatible(batch: readonly PendingApply[], next: PendingApply): boolean {
    const first = batch[0]!;
    const last = batch[batch.length - 1]!;
    if (first.history || next.history || first.undoGroup || next.undoGroup) return false;
    if (!first.options.undoable && !next.options.undoable) return true;
    return first.options.undoable && next.options.undoable
      && first.options.coalesceKey !== undefined && first.options.coalesceKey === next.options.coalesceKey
      && next.at - last.at <= BOARD_UNDO_COALESCE_MS;
  }

  function takeBatch(): PendingApply[] {
    const batch: PendingApply[] = [];
    let count = 0;
    for (const apply of queue) {
      if (apply.localOnly || apply.inFlight) continue;
      const live = liveOps(apply).length;
      if (live === 0) continue;
      if (batch.length === 0) {
        batch.push(apply);
        count = live;
        continue;
      }
      if (count + live > BOARD_PATCH_BATCH_MAX_OPS || !compatible(batch, apply)) break;
      batch.push(apply);
      count += live;
    }
    return batch;
  }

  /** Builds the PATCH ops (expectRev from captures) and preflights them against the acked doc. */
  function prepareBatch(batch: PendingApply[]): PrepareResult {
    const entries: InFlightBatch['entries'] = [];
    const ops: BoardOp[] = [];
    for (const apply of batch) {
      apply.ops.forEach((op, opIndex) => {
        if (apply.dropped[opIndex]) return;
        const captured = apply.captured[opIndex]!;
        for (const [id, rev] of captured) {
          if (rev !== null) continue;
          const current = ackedRev(id);
          if (current !== undefined) captured.set(id, current);
        }
        ops.push(withBoardExpectRev(op, captured));
        entries.push({ apply, opIndex });
      });
    }
    const revision = serverDoc!.revision;
    const outcome = applyBoardOps(boardContentOf(serverDoc!), ops, {
      baseRevision: revision,
      nextRevision: revision + 1,
      actor,
      now: now(),
      newId,
      checkConflicts: true,
    });
    if (outcome.ok) {
      if (outcome.inverse.length > 0) return { kind: 'send', batch: { applies: batch, entries, ops } };
      // Nothing would change on the daemon (e.g. a remote change already did the same): settle as committed.
      outcome.results.forEach((result, k) => {
        const entry = entries[k];
        if (!entry) return;
        const callerIndex = entry.apply.callerIndex[entry.opIndex]!;
        entry.apply.serverResults.set(callerIndex, { ...result, index: callerIndex });
      });
      for (const apply of batch) settleApply(apply, true);
      return { kind: 'progress' };
    }
    if (outcome.reason === 'conflict') {
      const byApply = new Map<PendingApply, number[]>();
      for (const conflict of outcome.conflicts) {
        const entry = conflict.opIndex >= 0 ? entries[conflict.opIndex] : undefined;
        if (entry) byApply.set(entry.apply, [...(byApply.get(entry.apply) ?? []), entry.opIndex]);
      }
      if (byApply.size === 0) {
        // Request-wide conflict (stale board): rebase on a fresh GET first; while draining, give up.
        if (disposed) {
          dropApplies(batch, null);
          return { kind: 'progress' };
        }
        return { kind: 'refetch' };
      }
      let surface: BoardStoreErrorCode | null = null;
      for (const [apply, indexes] of byApply) surface = strongerError(surface, dropOps(apply, indexes));
      settleExhausted();
      if (surface) setError(surface);
      return { kind: 'progress' };
    }
    // Invalid or over a limit against the acked doc: drop the applies involved.
    const involved = new Set<PendingApply>();
    if (outcome.reason === 'invalid') {
      for (const issue of outcome.issues) {
        const index = opIndexOfIssuePath(issue.path);
        const entry = index !== null ? entries[index] : undefined;
        if (entry) involved.add(entry.apply);
      }
    }
    dropApplies(involved.size > 0 ? [...involved] : batch, 'save-failed', outcomeMessage(outcome));
    return { kind: 'progress' };
  }

  function flush(keepalive: boolean): void {
    // Every non-send iteration drops or settles at least one apply, so the loop ends; the cap is a backstop.
    for (let round = 0; round < 10_000 && canSend(); round += 1) {
      const batch = takeBatch();
      if (batch.length === 0) break;
      const prepared = prepareBatch(batch);
      if (prepared.kind === 'progress') continue;
      if (prepared.kind === 'refetch') {
        recomputeView();
        publish();
        runRefetch();
        return;
      }
      send(prepared.batch, keepalive);
      recomputeView();
      publish();
      return;
    }
    recomputeView();
    publish();
    if (!hasSendable() && !inflight && refetchWanted && refetchTimer === null && !disposed) runRefetch();
    resolveIdleWaiters();
  }

  function send(batch: InFlightBatch, keepalive: boolean): void {
    inflight = batch;
    for (const apply of batch.applies) apply.inFlight = true;
    const body: BoardPatchRequest = { baseRevision: serverDoc!.revision, ops: batch.ops, actor };
    const useKeepalive = keepalive && JSON.stringify(body).length < KEEPALIVE_BODY_LIMIT;
    let request: Promise<BoardPatchResponse>;
    try {
      // Not tied to the store's abort signal: queued user edits still reach the daemon after dispose.
      request = api.patchBoard(projectId, body, { workspaceContext, ...(useKeepalive ? { keepalive: true } : {}) });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.then(
      (response) => guarded('board save', () => onPatchSuccess(batch, response)),
      (error: unknown) => guarded('board save', () => onPatchError(batch, error)),
    );
  }

  function onPatchSuccess(batch: InFlightBatch, response: BoardPatchResponse): void {
    inflight = null;
    const batchApplies = new Set(batch.applies);
    const batchCaptured = new Map<string, number>();
    for (const { apply, opIndex } of batch.entries) {
      for (const [id, rev] of apply.captured[opIndex]!) if (rev !== null && !batchCaptured.has(id)) batchCaptured.set(id, rev);
    }
    const before = { nodes: nodeIndex, edges: edgeIndex };
    const orderBefore = serverDoc ? serverDoc.nodes.map((node) => node.id) : [];
    const gap = applyServerChanges(response.changes, response.revision, { updatedAt: response.updatedAt });
    advanceCaptured(response.changes, batchCaptured, before, batchApplies);
    for (const id of boardChangeRemovedIds(response.changes)) removedByMe.add(id);
    response.results.forEach((result, k) => {
      const entry = batch.entries[k];
      if (!entry) return;
      const callerIndex = entry.apply.callerIndex[entry.opIndex]!;
      entry.apply.serverResults.set(callerIndex, { ...result, index: callerIndex });
    });
    const first = batch.applies[0]!;
    const last = batch.applies[batch.applies.length - 1]!;
    if (!isEmptyBoardChangeSet(response.changes) && response.inverse.length > 0) {
      const label = first.history?.entry.label ?? first.options.label;
      const entry: StackEntry = {
        inverse: response.inverse,
        touchedIds: boardChangeTouchedIds(response.changes),
        ...(label !== undefined ? { label } : {}),
        ...(first.options.coalesceKey !== undefined ? { coalesceKey: first.options.coalesceKey } : {}),
        at: last.at,
        removedIds: boardChangeRemovedIds(response.changes),
        firstAt: first.at,
        undoGroup: first.undoGroup,
      };
      if (first.history?.kind === 'undo') {
        redoStack.push(entry);
      } else if (first.history?.kind === 'redo') {
        pushUndo(entry, null);
      } else if (batch.applies.every((apply) => apply.options.undoable)) {
        pushUndo(entry, orderBefore);
        redoStack.length = 0;
      }
    }
    for (const apply of batch.applies) {
      apply.inFlight = false;
      settleApply(apply, true);
    }
    conflictRounds = 0;
    backoff.reset();
    clearError('offline', 'save-failed');
    if (gap) {
      refetchWanted = true;
      ackedIncomplete = true;
    }
    if (disposed) {
      flush(true);
      return;
    }
    recomputeView();
    publish();
    if (ackedIncomplete) {
      // Queued ops wait for the GET: their captures may already name revs the acked doc does not have yet.
      runRefetch();
      return;
    }
    afterSettle();
  }

  function onPatchError(batch: InFlightBatch, error: unknown): void {
    inflight = null;
    for (const apply of batch.applies) apply.inFlight = false;
    const status = error instanceof BoardRequestError ? error.status : null;
    if (disposed) {
      // Draining after dispose: no retries, no refetches.
      dropApplies(queue.filter((apply) => !apply.localOnly), null);
      resolveIdleWaiters(true);
      return;
    }
    if (status === 409) {
      conflictRounds += 1;
      if (conflictRounds > BOARD_PATCH_RETRY_LIMIT) {
        conflictRounds = 0;
        dropApplies(queue.filter((apply) => !apply.localOnly), null);
      }
      recomputeView();
      publish();
      runRefetch();
      return;
    }
    if (status === 403) {
      forbidden = true;
      dropApplies(queue.filter((apply) => !apply.localOnly), 'read-only');
    } else if (isBoardOfflineError(error)) {
      setError('offline');
      scheduleRetry();
    } else {
      dropApplies(batch.applies, 'save-failed', errorMessage(error));
    }
    recomputeView();
    publish();
    afterSettle();
  }

  function scheduleRetry(): void {
    if (retryTimer !== null || disposed) return;
    retryTimer = setT(() => {
      retryTimer = null;
      if (refetchWanted && !hasSendable()) runRefetch();
      else flush(false);
    }, backoff.nextDelay());
  }

  // ---- undo stack -------------------------------------------------------------------------------------------

  function pushUndo(entry: StackEntry, orderBefore: readonly string[] | null): void {
    const top = undoStack[undoStack.length - 1];
    const mergeable = orderBefore !== null && top !== undefined && top === lastPushed && (
      (entry.undoGroup !== null && top.undoGroup === entry.undoGroup)
      || (entry.coalesceKey !== undefined && top.coalesceKey === entry.coalesceKey
        && entry.firstAt - top.at <= BOARD_UNDO_COALESCE_MS)
    );
    if (mergeable) {
      const label = top.label ?? entry.label;
      const merged: StackEntry = {
        inverse: composeBoardInverses(top.inverse, entry.inverse, orderBefore),
        touchedIds: [...new Set([...top.touchedIds, ...entry.touchedIds])],
        ...(label !== undefined ? { label } : {}),
        ...(top.coalesceKey !== undefined ? { coalesceKey: top.coalesceKey } : {}),
        at: entry.at,
        removedIds: [...new Set([...top.removedIds, ...entry.removedIds])],
        firstAt: top.firstAt,
        undoGroup: top.undoGroup,
      };
      undoStack[undoStack.length - 1] = merged;
      lastPushed = merged;
      return;
    }
    undoStack.push(entry);
    if (undoStack.length > BOARD_UNDO_DEPTH) undoStack.splice(0, undoStack.length - BOARD_UNDO_DEPTH);
    lastPushed = orderBefore === null ? null : entry;
  }

  /** Spec 04 B3: undo/redo only while this client is still the last writer of every touched entity. */
  function historyAllowed(entry: StackEntry): boolean {
    for (const id of entry.touchedIds) {
      const entity = nodeIndex.get(id) ?? edgeIndex.get(id);
      if (entity) {
        if (entity.updatedBy?.clientId !== clientId) return false;
      } else if (!entry.removedIds.includes(id) && !removedByMe.has(id)) {
        return false;
      }
    }
    return true;
  }

  /** A page the replayed entry touches, when the shown page is not one of them: undo must be seen happening. */
  function historyPage(entry: StackEntry, after: BoardContent): string | null {
    const pages = boardPagesOf(after);
    if (pages.length < 2) return null;
    const touched = new Set(entry.touchedIds);
    const onPages = new Set(after.nodes.filter((node) => touched.has(node.id)).map((node) => boardNodePageId(node, pages)));
    return onPages.size > 0 && !onPages.has(activePageId) ? [...onPages][0]! : null;
  }

  async function runHistory(kind: 'undo' | 'redo'): Promise<boolean> {
    if (disposed) return false;
    if (readOnly()) {
      setError('read-only');
      publish();
      return false;
    }
    // Pending applies push their own entries when acked: wait so the right entry is on top.
    while (!isIdle()) {
      await new Promise<void>((resolve) => {
        idleWaiters.push(resolve);
      });
      if (disposed) return false;
    }
    if (!serverDoc || !view) return false;
    const stack = kind === 'undo' ? undoStack : redoStack;
    const entry = stack.pop();
    lastPushed = null;
    if (!entry) {
      publish();
      return false;
    }
    if (!historyAllowed(entry)) {
      // The entry can never become ours again: it is discarded, so older entries stay reachable.
      setError('undo-blocked');
      publish();
      return false;
    }
    const captured = entry.inverse.map((op) => {
      const revs = new Map<string, number | null>();
      for (const id of boardOpRevTargets(op)) {
        const rev = ackedRev(id);
        if (rev !== undefined) revs.set(id, rev);
      }
      return revs;
    });
    const ops = entry.inverse.map((op, index) => withBoardExpectRev(op, captured[index]!));
    const at = now();
    const outcome = applyBoardOps(boardContentOf(view), ops, localContext(at));
    if (!outcome.ok) {
      setError('undo-blocked');
      publish();
      return false;
    }
    const touchedPage = historyPage(entry, outcome.content);
    if (touchedPage) activePageId = touchedPage;
    return new Promise<boolean>((resolve) => {
      queue.push({
        ops,
        callerIndex: ops.map((_, index) => index),
        captured,
        dropped: ops.map(() => false),
        options: { undoable: false, silentConflict: false, ...(entry.label !== undefined ? { label: entry.label } : {}) },
        at,
        stamps: new Map(),
        undoGroup: null,
        history: { kind, entry },
        localOnly: false,
        inFlight: false,
        serverResults: new Map(),
        handle: { partsLeft: 1, ok: true, results: [], settle: (ok) => resolve(ok) },
      });
      view = boardWithContent(view!, outcome.content);
      publish();
      scheduleFlush();
    });
  }

  // ---- fetching (load / refetch) ------------------------------------------------------------------------------

  function onPageHide(): void {
    flushViewport(true);
    if (!inflight) flush(true);
  }

  function bindPageHide(): void {
    if (pageHideBound || typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
    pageHideBound = true;
    window.addEventListener('pagehide', onPageHide);
  }

  function receiveFullDoc(doc: BoardDocument): void {
    if (serverDoc && doc.revision < serverDoc.revision) return;
    ackedIncomplete = false;
    const first = serverDoc === null;
    setServerDoc(reconcileBoardDocument(serverDoc, doc));
    if (first) {
      const pages = boardPagesOf(doc);
      activePageId = resolveBoardPageId(pages, doc.activePageId);
      viewportPageId = activePageId;
      for (const [pageId, viewport] of Object.entries(doc.pageViewports ?? {})) pageViewports.set(pageId, viewport);
      // A board that kept one camera (or whose saved page is gone) has no stored view of a page that lacks one.
      initialViewport = pageViewports.get(activePageId)
        ?? (activePageId === doc.activePageId || pages.length === 1 ? doc.viewport ?? null : null);
      // Restoring the saved camera must not save it again.
      lastSavedViewport ??= initialViewport;
    }
    status = 'ready';
    // Read-only local edits are reverted by the next GET (spec 04 §7.2).
    for (const apply of [...queue]) if (apply.localOnly) removeFromQueue(apply);
    rebaseQueued();
  }

  function fetchLatest(): Promise<void> {
    refetchWanted = false;
    if (serverDoc === null && status !== 'ready') status = 'loading';
    let request: Promise<{ board: BoardDocument }>;
    try {
      request = api.fetchBoard(projectId, { workspaceContext, signal: abort.signal });
    } catch (error) {
      request = Promise.reject(error);
    }
    const promise: Promise<void> = request.then(
      (response) => {
        fetchPromise = null;
        if (disposed) {
          flush(true);
          return;
        }
        guarded('board load', () => {
          receiveFullDoc(response.board);
          backoff.reset();
          clearError('offline');
        });
        recomputeView();
        publish();
        afterSettle();
      },
      (error: unknown) => {
        fetchPromise = null;
        if (disposed) {
          flush(true);
          return;
        }
        if (serverDoc === null) status = 'error';
        if (isBoardOfflineError(error)) {
          setError('offline');
          // The daemon may come back; retry with backoff (a stream-ready event also refetches).
          scheduleRefetch(backoff.nextDelay());
        } else if (error instanceof BoardRequestError && error.status === 403) {
          setError('read-only');
        } else if (serverDoc === null) {
          setError('save-failed', errorMessage(error));
        }
        publish();
        afterSettle();
      },
    );
    fetchPromise = promise;
    publish();
    return promise;
  }

  function scheduleRefetch(delay: number): void {
    if (disposed) return;
    refetchWanted = true;
    if (refetchTimer !== null) return;
    refetchTimer = setT(() => {
      refetchTimer = null;
      runRefetch();
    }, delay);
  }

  /** GET now unless a PATCH or GET is running (then after it settles). */
  function runRefetch(): void {
    if (disposed) return;
    refetchWanted = true;
    if (inflight || fetching()) return;
    if (refetchTimer !== null) {
      clearT(refetchTimer);
      refetchTimer = null;
    }
    void fetchLatest();
  }

  /** After a request settles: queued edits first (they never wait behind refetches), then a wanted GET, then idle waiters. */
  function afterSettle(): void {
    if (disposed) return;
    // Nothing left to send ends the 409 rebase rounds: they count per queue, not per session.
    if (!hasSendable()) conflictRounds = 0;
    if (canSend() && hasSendable()) {
      scheduleFlush();
      return;
    }
    if (refetchWanted && !inflight && !fetching() && refetchTimer === null && retryTimer === null) {
      runRefetch();
      return;
    }
    resolveIdleWaiters();
  }

  // ---- viewport ---------------------------------------------------------------------------------------------

  function flushViewport(keepalive: boolean): void {
    if (viewportTimer !== null) {
      clearT(viewportTimer);
      viewportTimer = null;
    }
    const viewport = pendingViewport;
    pendingViewport = null;
    if (!viewport || readOnly()) return;
    lastSavedViewport = viewport;
    const pageId = currentPages().length > 1 ? viewportPageId : undefined;
    let request: Promise<void>;
    try {
      request = api.putBoardViewport(projectId, viewport, {
        workspaceContext,
        ...(keepalive ? { keepalive: true } : {}),
        ...(pageId ? { pageId } : {}),
      });
    } catch (error) {
      request = Promise.reject(error);
    }
    request.catch(() => {
      // The camera is a convenience; a failed save is not surfaced.
    });
  }

  // ---- sync -------------------------------------------------------------------------------------------------

  function receiveSyncResponse(response: BoardSyncResponse): void {
    if (!serverDoc) return;
    let gap = false;
    if (response.changed && response.changes) {
      gap = applyServerChanges(response.changes, response.revision, null);
      rebaseQueued();
      recomputeView();
      publish();
    } else if (response.revision > serverDoc.revision) {
      gap = true;
    }
    if (gap) {
      ackedIncomplete = true;
      scheduleRefetch(0);
    }
  }

  function runSync(): void {
    syncTimer = null;
    if (!syncPending || syncInFlight || disposed) return;
    const { request, waiters } = syncPending;
    syncPending = null;
    syncInFlight = true;
    let call: Promise<BoardSyncResponse>;
    try {
      call = api.syncBoard(projectId, { ...request, actor }, { workspaceContext, signal: abort.signal });
    } catch (error) {
      call = Promise.reject(error);
    }
    const finish = (response: BoardSyncResponse | null): void => {
      syncInFlight = false;
      if (response && !disposed) guarded('board sync', () => receiveSyncResponse(response));
      for (const resolve of waiters) resolve(disposed ? null : response);
      if (syncPending && !disposed && syncTimer === null) syncTimer = setT(runSync, BOARD_SYNC_COALESCE_MS);
    };
    call.then(finish, () => finish(null));
  }

  // ---- public API -------------------------------------------------------------------------------------------

  return {
    getState: () => state,

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    load() {
      if (disposed) return Promise.resolve();
      bindPageHide();
      if (serverDoc) return Promise.resolve();
      if (fetchPromise) return fetchPromise;
      return fetchLatest();
    },

    apply(ops, options = {}) {
      if (disposed || !serverDoc || !view) return Promise.resolve({ ok: false });
      const normalized: NormalizedApplyOptions = {
        undoable: options.undoable !== false,
        silentConflict: options.silentConflict === true,
        ...(options.label !== undefined ? { label: options.label } : {}),
        ...(options.coalesceKey !== undefined ? { coalesceKey: options.coalesceKey } : {}),
      };
      const at = now();
      const viewNodes = new Map(view.nodes.map((node) => [node.id, node]));
      const paged = currentPages().length > 1;
      const prepared = ops.map((op) => {
        const filled = withActivePage(fillBoardOpIds(op, newId), paged ? activePageId : null);
        return filled.op === 'update' ? sanitizeBoardRefIdentities(filled, viewNodes.get(filled.id)) : filled;
      });
      let content: BoardContent = boardContentOf(view);
      const localResults: BoardOpResult[] = [];
      const parts: Array<{ ops: BoardOp[]; callerIndex: number[]; stamps: Map<string, number> }> = [];
      // An apply above the per-PATCH cap is applied and sent in slices (one undo entry, see `undoGroup`).
      for (let offset = 0; offset < prepared.length; offset += BOARD_PATCH_BATCH_MAX_OPS) {
        const slice = prepared.slice(offset, offset + BOARD_PATCH_BATCH_MAX_OPS);
        const outcome = applyBoardOps(content, slice, localContext(at));
        if (!outcome.ok) {
          setError('save-failed', outcomeMessage(outcome));
          publish();
          return Promise.resolve({ ok: false });
        }
        for (const result of outcome.results) localResults.push({ ...result, index: result.index + offset });
        if (outcome.inverse.length === 0) continue;
        const created = boardCreatedIdsInOpOrder(slice, outcome.results, content, outcome.content);
        const stamps = new Map<string, number>();
        if (created.length > 0) {
          const base = Math.max(now(), lastStamp + 1, serverMaxCreatedAt + 1);
          created.forEach((id, k) => stamps.set(id, base + k));
          lastStamp = base + created.length - 1;
        }
        content = restampBoardCreatedAt(outcome.content, stamps);
        // Ops skipped locally (missing target, existing id) would only make the daemon answer 409.
        const send: BoardOp[] = [];
        const callerIndex: number[] = [];
        for (const result of outcome.results) {
          if (result.status !== 'applied') continue;
          send.push(slice[result.index]!);
          callerIndex.push(result.index + offset);
        }
        if (send.length > 0) parts.push({ ops: send, callerIndex, stamps });
      }
      if (parts.length === 0) return Promise.resolve({ ok: true, results: localResults });
      view = boardWithContent(view, content);
      const seq = (seqCounter += 1);
      const localOnly = readOnly();
      return new Promise((resolve) => {
        const handle: ApplyHandle = {
          partsLeft: parts.length,
          ok: true,
          results: localResults.slice(),
          settle: (ok, results) => resolve({ ok, results }),
        };
        for (const part of parts) {
          queue.push({
            ops: part.ops,
            callerIndex: part.callerIndex,
            // The store owns expectRev: a rev read from the optimistic view would be a local stamp.
            captured: part.ops.map((op) => {
              const captured = new Map<string, number | null>();
              for (const id of boardOpRevTargets(op)) captured.set(id, ackedRev(id) ?? null);
              return captured;
            }),
            dropped: part.ops.map(() => false),
            options: normalized,
            at,
            stamps: part.stamps,
            undoGroup: parts.length > 1 ? `apply:${seq}` : null,
            history: null,
            localOnly,
            inFlight: false,
            serverResults: new Map(),
            handle,
          });
        }
        if (localOnly) {
          // Read-only: the change stays local until the next GET reverts it; nothing is saved.
          setError('read-only');
          publish();
          resolve({ ok: false, results: localResults });
          return;
        }
        publish();
        scheduleFlush();
      });
    },

    sync(request) {
      if (disposed || readOnly()) return Promise.resolve(null);
      return new Promise((resolve) => {
        syncPending = syncPending
          ? { request: mergeBoardSyncRequests(syncPending.request, request), waiters: [...syncPending.waiters, resolve] }
          : { request, waiters: [resolve] };
        if (syncTimer === null && !syncInFlight) syncTimer = setT(runSync, BOARD_SYNC_COALESCE_MS);
      });
    },

    setViewport(viewport) {
      if (disposed || readOnly()) return;
      const next = { centerX: viewport.centerX, centerY: viewport.centerY, zoom: viewport.zoom };
      pageViewports.set(activePageId, next);
      // The camera of the page being left goes out first; it must not be saved as this page's.
      if (viewportPageId !== activePageId) {
        flushViewport(false);
        viewportPageId = activePageId;
        lastSavedViewport = null;
      }
      const saved = lastSavedViewport;
      if (viewportTimer === null && saved
        && saved.centerX === next.centerX && saved.centerY === next.centerY && saved.zoom === next.zoom) {
        return;
      }
      pendingViewport = next;
      if (viewportTimer !== null) clearT(viewportTimer);
      viewportTimer = setT(() => {
        viewportTimer = null;
        flushViewport(false);
      }, BOARD_VIEWPORT_SAVE_DEBOUNCE_MS);
    },

    pageViewport: (pageId) => pageViewports.get(pageId) ?? null,

    setActivePage(pageId) {
      if (disposed) return;
      const next = resolveBoardPageId(currentPages(), pageId);
      if (next === activePageId) return;
      activePageId = next;
      publish();
    },

    undo: () => runHistory('undo'),
    redo: () => runHistory('redo'),

    handleBusEvent(event: BoardProjectBusEvent) {
      if (disposed) return;
      if (event.type === 'stream-ready') {
        scheduleRefetch(BOARD_REMOTE_REFETCH_COALESCE_MS);
        return;
      }
      const payload = event.payload;
      if (payload.projectId !== projectId) return;
      if (payload.actor?.clientId !== undefined && payload.actor.clientId === clientId) return;
      if (payload.revision <= (serverDoc?.revision ?? 0)) return;
      scheduleRefetch(BOARD_REMOTE_REFETCH_COALESCE_MS);
    },

    dispose() {
      if (disposed) return;
      flushViewport(true);
      disposed = true;
      listeners.clear();
      for (const timer of [refetchTimer, syncTimer, retryTimer]) if (timer !== null) clearT(timer);
      refetchTimer = null;
      syncTimer = null;
      retryTimer = null;
      refetchWanted = false;
      if (syncPending) {
        for (const resolve of syncPending.waiters) resolve(null);
        syncPending = null;
      }
      if (pageHideBound && typeof window !== 'undefined') window.removeEventListener('pagehide', onPageHide);
      abort.abort();
      // Queued edits are still sent once (keepalive when small); history replays and local-only edits are dropped.
      dropApplies(queue.filter((apply) => apply.history !== null && !apply.inFlight), null);
      for (const apply of [...queue]) if (apply.localOnly) removeFromQueue(apply);
      if (!inflight) flush(true);
      resolveIdleWaiters(true);
    },
  };
}
