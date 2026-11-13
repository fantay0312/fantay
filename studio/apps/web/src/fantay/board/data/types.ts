// SPDX-License-Identifier: AGPL-3.0-only
// Board web data-layer interfaces (spec 04 §7.1, plan §3.1 + R1/R8). W2-board-data implements
// `createBoardStore(deps): BoardDataStore`, `BoardDataProvider` and `useBoardData()` against these types
// and does not edit this file; the board engine (03) derives its document from `BoardDataStore`.
import type {
  BoardChangedSsePayload,
  BoardDocument,
  BoardOp,
  BoardOpResult,
  BoardPage,
  BoardSyncRequest,
  BoardSyncResponse,
  BoardViewport,
  ChatMessage,
  ProjectFile,
  WorkspaceContextItem,
} from '@open-design/contracts';

import type { LiveArtifactWorkspaceEntry } from '../../../types';
import type { FantayBoardOpenRequest } from '../../workspace/board-host-contract';

export type BoardStoreErrorCode = 'conflict' | 'save-failed' | 'offline' | 'read-only' | 'undo-blocked';

export interface BoardStoreState {
  status: 'idle' | 'loading' | 'ready' | 'error';
  board: BoardDocument | null;          // optimistic view = server doc + pending ops
  serverRevision: number;
  initialViewport: BoardViewport | null; // from the first successful GET only
  pages: readonly BoardPage[];           // tab order, never empty
  activePageId: string;                  // the page this client shows; `apply` adds new nodes to it
  pendingOps: number;
  lastError: { code: BoardStoreErrorCode; message?: string; at: number } | null;
  canUndo: boolean;
  canRedo: boolean;
}

export interface BoardApplyOptions {
  /** default true */
  undoable?: boolean;
  silentConflict?: boolean;
  label?: string;
  /**
   * R1: consecutive undoable applies with the same key within 1500 ms merge into one undo entry that
   * keeps the oldest inverse (e.g. a drag that commits several moves).
   */
  coalesceKey?: string;
}

/**
 * One undo/redo stack entry (04 §7.2). `inverse` is the PATCH response's `inverse` array as committed by
 * the contracts (`applyBoardOps`): a `restore` op plus an optional trailing `set-meta` op, replayed as
 * one PATCH. Entries are pushed only for non-empty change sets (`!isEmptyBoardChangeSet(changes)`: an op
 * can be `applied` yet change nothing).
 */
export interface BoardUndoEntry {
  inverse: BoardOp[];
  touchedIds: string[];
  label?: string;
  coalesceKey?: string;
  at: number;
}

/** 04's `BoardStore` (plan §3.1 name: `BoardDataStore`). */
export interface BoardDataStore {
  getState(): BoardStoreState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  apply(ops: BoardOp[], options?: BoardApplyOptions): Promise<{ ok: boolean; results?: BoardOpResult[] }>;
  sync(request: BoardSyncRequest): Promise<BoardSyncResponse | null>;
  setViewport(viewport: BoardViewport): void;
  /** The last camera of a page: saved this session, else stored. */
  pageViewport(pageId: string): BoardViewport | null;
  setActivePage(pageId: string): void;
  undo(): Promise<boolean>;
  redo(): Promise<boolean>;
  handleBusEvent(event: BoardProjectBusEvent): void;
  dispose(): void;
}

/** Alias with spec 04's name. */
export type BoardStore = BoardDataStore;

export type BoardProjectBusEvent = { type: 'board-changed'; payload: BoardChangedSsePayload } | { type: 'stream-ready' };

/**
 * Host bindings of `BoardDataProvider` (04 §7.1), filled from `FantayBoardHostProps` (plan R8). Arrays
 * are readonly and `liveArtifacts` are FileWorkspace's workspace entries so the host props pass through
 * unchanged.
 */
export interface BoardHostBindings {
  projectId: string;
  projectDir: string | null;
  active: boolean;
  /** viewerOnly || initialMaterializationPending (plan R8). */
  readOnly: boolean;
  files: readonly ProjectFile[];
  filesGeneration: number;
  liveArtifacts: readonly LiveArtifactWorkspaceEntry[];
  messages: readonly ChatMessage[];
  activeConversationId: string | null;
  runInFlight: boolean;
  openRequest: FantayBoardOpenRequest | null;
  onActiveContextChange: (item: WorkspaceContextItem | null) => void;
  onUnplaceableOpenRequest: (name: string) => void;    // shell switches to the 文件 tab
}

export interface BoardFocusIntent {
  nonce: number;
  nodeIds: string[];
  primaryNodeId: string | null;
  behavior: 'fly-to' | 'reveal-pill';
  source: 'open-request' | 'run-finished';
}

export interface BoardDataValue {
  store: BoardDataStore;
  host: BoardHostBindings;
  focusIntent: BoardFocusIntent | null;
  ackFocusIntent(nonce: number): void;
  noteCameraInteraction(): void;                        // UI calls on user pan/zoom/drag
  willHandleOpenRequest(request: { name: string; openBatch?: readonly string[] }): boolean;
}
