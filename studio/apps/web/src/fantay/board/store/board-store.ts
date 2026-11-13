// SPDX-License-Identifier: AGPL-3.0-only
// Engine store (spec 03 §3.3 with plan R1): UI state only — tool, selection, hover, mode, preview, runtime,
// visible/live sets and the settled zoom. The document is derived from the 04 `BoardDataStore`; `commit`
// translates a transaction into contract ops and calls `data.apply`, `undo`/`redo` call the 04 store.
import type { BoardOpResult } from '@open-design/contracts';

import type { BoardDataStore, BoardStoreState } from '../data/types';
import { emptyEngineDoc, toEngineDoc } from '../model/contract-adapter';
import type {
  BoardSidePanel,
  BoardUiState,
  EngineDoc,
  InteractionPreview,
  NodeRuntime,
} from '../model/types';
import { applyOptionsFor, newBoardId, toContractOps, type BoardTransaction } from './ops';
import { deriveNodeRuntime, deriveRuntimeMap, EMPTY_RUNTIME_ENV, sameRuntime, type RuntimeEnv } from './runtime-state';
import { pruneRemoved, sameSelection } from './selection';

export interface EngineSaveState {
  readonly status: BoardStoreState['status'];
  readonly pendingOps: number;
  readonly lastError: BoardStoreState['lastError'];
}

export interface EngineState {
  readonly projectId: string;
  readonly status: 'loading' | 'ready' | 'error';
  readonly doc: EngineDoc;
  readonly ui: BoardUiState;
  readonly selectionSet: ReadonlySet<string>;
  readonly runtime: ReadonlyMap<string, NodeRuntime>;
  readonly preview: InteractionPreview | null;
  /** nodes to render, in paint order (culling) */
  readonly visibleIds: readonly string[];
  readonly visibleEdgeIds: readonly string[];
  readonly liveIds: ReadonlySet<string>;
  /** bodies that asked to stay live (`requestLive(true)`, e.g. playing) */
  readonly pinnedLiveIds: ReadonlySet<string>;
  readonly settled: { readonly zoom: number; readonly layoutZoom: number };
  readonly readOnly: boolean;
  readonly active: boolean;
  readonly history: { readonly canUndo: boolean; readonly canRedo: boolean };
  readonly save: EngineSaveState;
  readonly env: RuntimeEnv;
}

export interface CommitResult {
  ok: boolean;
  results?: BoardOpResult[];
}

export interface EngineStore {
  readonly projectId: string;
  readonly data: BoardDataStore;
  getState(): EngineState;
  subscribe(listener: () => void): () => void;
  /** Sends a transaction to the 04 store. Nothing to change → `{ ok: true, results: [] }` without a call. */
  commit(tx: BoardTransaction): Promise<CommitResult>;
  /** Coalesces multiple synchronous state updates into a single subscriber notification. */
  batch(fn: () => void): void;
  setUi(patch: Partial<BoardUiState>): void;
  /** Ephemeral runtime (never persisted); `null` clears the node's entry. */
  setRuntime(nodeId: string, patch: Partial<NodeRuntime> | null): void;
  setPreview(preview: InteractionPreview | null): void;
  /** No-op when both lists are unchanged. */
  setVisible(ids: readonly string[], edgeIds?: readonly string[]): void;
  /** No-op when the set is unchanged. */
  setLive(ids: ReadonlySet<string>): void;
  setPinnedLive(id: string, pinned: boolean): void;
  setSettled(settled: { zoom: number; layoutZoom: number }): void;
  setEnv(env: RuntimeEnv): void;
  setActive(active: boolean): void;
  setReadOnly(readOnly: boolean): void;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  /** Re-derives the document and the mirrored 04 state. */
  syncFromData(): void;
  /** Subscribes to the 04 store (and syncs once); returns the unsubscribe. */
  connect(): () => void;
}

export interface EngineStoreInit {
  projectId: string;
  data: BoardDataStore;
  readOnly?: boolean;
  active?: boolean;
  settled?: { zoom: number; layoutZoom: number };
  newNodeId?: () => string;
  newEdgeId?: () => string;
}

/* v2: wheel zoom became the default; v1 stored `wheelZooms: false` even for viewers who never chose it. */
export const BOARD_PREFS_STORAGE_KEY = 'fantay.board.prefs.v2';

export interface BoardPrefs {
  minimapOpen: boolean;
  wheelZooms: boolean;
  sidePanel: BoardSidePanel | null;
}

/** Per-viewer conveniences (minimap toggle, wheel zoom, side panel); storage failures fall back to the defaults. */
export function readBoardPrefs(): BoardPrefs {
  const defaults: BoardPrefs = { minimapOpen: false, wheelZooms: true, sidePanel: null };
  try {
    if (typeof window === 'undefined') return defaults;
    const raw = window.localStorage.getItem(BOARD_PREFS_STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      minimapOpen: parsed.minimapOpen === true,
      wheelZooms: parsed.wheelZooms !== false,
      sidePanel: parsed.sidePanel === 'references' || parsed.sidePanel === 'assets' ? parsed.sidePanel : null,
    };
  } catch {
    return defaults;
  }
}

export function writeBoardPrefs(prefs: BoardPrefs): void {
  try {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(BOARD_PREFS_STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* per-viewer convenience only */
  }
}

export function initialUiState(prefs = readBoardPrefs()): BoardUiState {
  return {
    tool: 'select',
    selection: [],
    selectedEdgeId: null,
    hoverId: null,
    hoverSince: null,
    mode: null,
    maximized: null,
    editingTextId: null,
    renamingId: null,
    interaction: 'idle',
    spaceHeld: false,
    minimapOpen: prefs.minimapOpen,
    sidePanel: prefs.sidePanel,
    wheelZooms: prefs.wheelZooms,
    shortcutsOpen: false,
    dropActive: false,
    contextTarget: null,
    connectMenu: null,
    panelFocusNonce: 0,
  };
}

const EMPTY_SET: ReadonlySet<string> = new Set();
const EMPTY_IDS: readonly string[] = Object.freeze([]);
const EMPTY_RUNTIME: ReadonlyMap<string, NodeRuntime> = new Map();

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const id of a) if (!b.has(id)) return false;
  return true;
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return sameSelection(a, b);
}

/** A loaded document stays usable through later fetch errors; only a failed first load is an error. */
function statusOf(data: BoardStoreState): EngineState['status'] {
  if (data.board !== null || data.status === 'ready') return 'ready';
  return data.status === 'error' ? 'error' : 'loading';
}

/** UI state after a document change: drops references to nodes and edges that disappeared. */
function pruneUi(ui: BoardUiState, prev: EngineDoc, next: EngineDoc): BoardUiState {
  const gone = (id: string | null | undefined): boolean => !!id && prev.nodes.has(id) && !next.nodes.has(id);
  const selection = pruneRemoved(ui.selection, prev, next);
  const edgeGone = ui.selectedEdgeId !== null && prev.edges.has(ui.selectedEdgeId) && !next.edges.has(ui.selectedEdgeId);
  const changed = selection !== ui.selection
    || edgeGone
    || gone(ui.hoverId)
    || gone(ui.mode?.nodeId)
    || gone(ui.editingTextId)
    || gone(ui.renamingId)
    || (ui.contextTarget?.kind === 'node' && gone(ui.contextTarget.id))
    || gone(ui.connectMenu?.from);
  if (!changed) return ui;
  return {
    ...ui,
    selection,
    selectedEdgeId: edgeGone ? null : ui.selectedEdgeId,
    hoverId: gone(ui.hoverId) ? null : ui.hoverId,
    hoverSince: gone(ui.hoverId) ? null : ui.hoverSince,
    mode: gone(ui.mode?.nodeId) ? null : ui.mode,
    editingTextId: gone(ui.editingTextId) ? null : ui.editingTextId,
    renamingId: gone(ui.renamingId) ? null : ui.renamingId,
    contextTarget: ui.contextTarget?.kind === 'node' && gone(ui.contextTarget.id) ? null : ui.contextTarget,
    connectMenu: gone(ui.connectMenu?.from) ? null : ui.connectMenu,
  };
}

function uiChanged(prev: BoardUiState, patch: Partial<BoardUiState>): boolean {
  for (const [key, value] of Object.entries(patch) as Array<[keyof BoardUiState, unknown]>) {
    const before = prev[key];
    if (key === 'selection') {
      if (!sameSelection(before as readonly string[], value as readonly string[])) return true;
      continue;
    }
    if (before !== value) return true;
  }
  return false;
}

export function createEngineStore(init: EngineStoreInit): EngineStore {
  const { projectId, data } = init;
  const listeners = new Set<() => void>();
  const ephemeral = new Map<string, Partial<NodeRuntime>>();
  const newNodeId = init.newNodeId ?? (() => newBoardId('n'));
  const newEdgeId = init.newEdgeId ?? (() => newBoardId('e'));

  let state: EngineState = {
    projectId,
    status: 'loading',
    doc: emptyEngineDoc(projectId),
    ui: initialUiState(),
    selectionSet: EMPTY_SET,
    runtime: EMPTY_RUNTIME,
    preview: null,
    visibleIds: EMPTY_IDS,
    visibleEdgeIds: EMPTY_IDS,
    liveIds: EMPTY_SET,
    pinnedLiveIds: EMPTY_SET,
    settled: init.settled ?? { zoom: 1, layoutZoom: 1 },
    readOnly: init.readOnly ?? false,
    active: init.active ?? true,
    history: { canUndo: false, canRedo: false },
    save: { status: 'idle', pendingOps: 0, lastError: null },
    env: EMPTY_RUNTIME_ENV,
  };
  let batchDepth = 0;
  let dirtyInBatch = false;

  function emit(): void {
    for (const listener of [...listeners]) listener();
  }

  function replace(next: EngineState): void {
    if (next === state) return;
    if (next.ui.selection !== state.ui.selection) {
      next = {
        ...next,
        selectionSet: next.ui.selection.length === 0 ? EMPTY_SET : new Set(next.ui.selection),
      };
    }
    state = next;
    if (batchDepth > 0) dirtyInBatch = true;
    else emit();
  }

  function syncFromData(): void {
    const ds = data.getState();
    const doc = toEngineDoc(ds.board, projectId, state.doc, ds.activePageId);
    const status = statusOf(ds);
    const history = state.history.canUndo === ds.canUndo && state.history.canRedo === ds.canRedo
      ? state.history
      : { canUndo: ds.canUndo, canRedo: ds.canRedo };
    const save = state.save.status === ds.status && state.save.pendingOps === ds.pendingOps && state.save.lastError === ds.lastError
      ? state.save
      : { status: ds.status, pendingOps: ds.pendingOps, lastError: ds.lastError };
    if (doc === state.doc && status === state.status && history === state.history && save === state.save) return;
    let { ui, runtime, pinnedLiveIds } = state;
    if (doc !== state.doc) {
      ui = pruneUi(ui, state.doc, doc);
      // A node on another page keeps its runtime; only a node gone from the whole board drops it.
      const onBoard = new Set(ds.board?.nodes.map((node) => node.id));
      for (const id of [...ephemeral.keys()]) if (state.doc.nodes.has(id) && !onBoard.has(id)) ephemeral.delete(id);
      runtime = deriveRuntimeMap(doc, state.env, ephemeral, state.runtime);
      if (pinnedLiveIds.size > 0) {
        const kept = new Set([...pinnedLiveIds].filter((id) => doc.nodes.has(id) || !state.doc.nodes.has(id)));
        if (kept.size !== pinnedLiveIds.size) pinnedLiveIds = kept;
      }
    }
    replace({ ...state, doc, status, history, save, ui, runtime, pinnedLiveIds });
  }

  return {
    projectId,
    data,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    commit(tx) {
      if (state.readOnly && tx.origin === 'local') return Promise.resolve({ ok: false });
      const ops = toContractOps(tx.ops, { doc: state.doc, newNodeId, newEdgeId });
      if (ops.length === 0) return Promise.resolve({ ok: true, results: [] });
      let pending: Promise<CommitResult>;
      try {
        pending = data.apply(ops, applyOptionsFor(tx));
      } catch {
        return Promise.resolve({ ok: false });
      }
      // the 04 store applies optimistically before resolving; pick the view up even if it notifies later
      syncFromData();
      return pending.then(
        (result) => result,
        () => ({ ok: false }),
      );
    },
    batch(fn) {
      batchDepth += 1;
      try {
        fn();
      } finally {
        batchDepth -= 1;
        if (batchDepth === 0 && dirtyInBatch) {
          dirtyInBatch = false;
          emit();
        }
      }
    },
    setUi(patch) {
      if (!uiChanged(state.ui, patch)) return;
      const ui = { ...state.ui, ...patch };
      if (patch.minimapOpen !== undefined || patch.wheelZooms !== undefined || patch.sidePanel !== undefined) {
        writeBoardPrefs({ minimapOpen: ui.minimapOpen, wheelZooms: ui.wheelZooms, sidePanel: ui.sidePanel });
      }
      replace({ ...state, ui });
    },
    setRuntime(nodeId, patch) {
      if (patch === null) {
        if (!ephemeral.has(nodeId)) return;
        ephemeral.delete(nodeId);
      } else {
        const merged: Record<string, unknown> = { ...ephemeral.get(nodeId) };
        for (const [key, value] of Object.entries(patch)) {
          if (value === undefined) delete merged[key];
          else merged[key] = value;
        }
        ephemeral.set(nodeId, merged as Partial<NodeRuntime>);
      }
      const node = state.doc.nodes.get(nodeId);
      if (!node) return;
      const derived = deriveNodeRuntime(node, state.env, ephemeral.get(nodeId));
      const before = state.runtime.get(nodeId);
      if (before && sameRuntime(before, derived)) return;
      const runtime = new Map(state.runtime);
      runtime.set(nodeId, derived);
      replace({ ...state, runtime });
    },
    setPreview(preview) {
      if (preview === state.preview) return;
      replace({ ...state, preview });
    },
    setVisible(ids, edgeIds) {
      const nextIds = sameIds(state.visibleIds, ids) ? state.visibleIds : ids;
      const nextEdges = edgeIds === undefined || sameIds(state.visibleEdgeIds, edgeIds) ? state.visibleEdgeIds : edgeIds;
      if (nextIds === state.visibleIds && nextEdges === state.visibleEdgeIds) return;
      replace({ ...state, visibleIds: nextIds, visibleEdgeIds: nextEdges });
    },
    setLive(ids) {
      if (sameSet(state.liveIds, ids)) return;
      replace({ ...state, liveIds: ids });
    },
    setPinnedLive(id, pinned) {
      if (state.pinnedLiveIds.has(id) === pinned) return;
      const next = new Set(state.pinnedLiveIds);
      if (pinned) next.add(id);
      else next.delete(id);
      replace({ ...state, pinnedLiveIds: next });
    },
    setSettled(settled) {
      if (state.settled.zoom === settled.zoom && state.settled.layoutZoom === settled.layoutZoom) return;
      replace({ ...state, settled: { zoom: settled.zoom, layoutZoom: settled.layoutZoom } });
    },
    setEnv(env) {
      if (env === state.env) return;
      const runtime = deriveRuntimeMap(state.doc, env, ephemeral, state.runtime);
      replace({ ...state, env, runtime });
    },
    setActive(active) {
      if (state.active === active) return;
      replace({ ...state, active });
    },
    setReadOnly(readOnly) {
      if (state.readOnly === readOnly) return;
      replace({ ...state, readOnly });
    },
    undo() {
      if (state.readOnly) return Promise.resolve(false);
      return data.undo().catch(() => false);
    },
    redo() {
      if (state.readOnly) return Promise.resolve(false);
      return data.redo().catch(() => false);
    },
    syncFromData,
    connect() {
      const unsubscribe = data.subscribe(syncFromData);
      syncFromData();
      return unsubscribe;
    },
  };
}
