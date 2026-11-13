'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Board comments (first slice): the host bindings (the per-conversation preview comments and their save / delete /
// status / send callbacks, passed down from FileWorkspace through `FantayBoardHostProps`), the per-engine comment UI
// store (picker frame, hover, the new-comment composer, the open card, "show resolved") and the per-frame session.
// The session mirrors Capture's (`use-frame-capture.ts`): while the Comment tool runs on the sole selected frame, the
// frame is pinned live and its selection bridge runs in picker mode (`od:comment-mode`); hover and click targets come
// back through the message router and land here. Composer and card stay in the store after closing (`*Open`
// false) so their exit transition can play.
import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore, type MutableRefObject } from 'react';

import type { CommentSendResult } from '../../../components/comment-send-result';
import type {
  ChatCommentAttachment,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentTarget,
} from '../../../types';
import { useBoardEngine } from '../context';
import type { FrameCommentTarget } from '../engine/message-router';
import type { BoardEngine } from '../store/board-engine';

/* ── host bindings ──────────────────────────────────────────────────────────────────────── */

/** What the host gives the board for comments. A missing callback turns that action off. */
export interface BoardCommentsHost {
  /** comments of the active conversation (all files, all statuses) */
  comments: readonly PreviewComment[];
  save?(target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[], commentId?: string): Promise<PreviewComment | null>;
  remove?(commentId: string): Promise<boolean>;
  setStatus?(commentId: string, status: PreviewCommentStatus): Promise<boolean>;
  send?(attachments: ChatCommentAttachment[], images?: File[]): Promise<CommentSendResult> | CommentSendResult;
}

const NO_COMMENTS: readonly PreviewComment[] = [];
export const EMPTY_BOARD_COMMENTS_HOST: BoardCommentsHost = Object.freeze({ comments: NO_COMMENTS });

export const BoardCommentsContext = createContext<BoardCommentsHost>(EMPTY_BOARD_COMMENTS_HOST);

export function useBoardCommentsHost(): BoardCommentsHost {
  return useContext(BoardCommentsContext);
}

/* ── comment UI store (one per engine) ──────────────────────────────────────────────────── */

export interface BoardCommentDraft {
  /** bumps per opened composer: a new draft remounts the composer body */
  key: number;
  nodeId: string;
  filePath: string;
  target: FrameCommentTarget;
}

export interface BoardCommentUiState {
  /** the frame running the comment picker (Comment tool + sole selected frame) */
  nodeId: string | null;
  /** its document loaded and the picker was turned on */
  ready: boolean;
  hover: FrameCommentTarget | null;
  draft: BoardCommentDraft | null;
  draftOpen: boolean;
  /** the comment whose card is shown */
  cardId: string | null;
  cardOpen: boolean;
  showResolved: boolean;
}

export interface BoardCommentStore {
  getState(): BoardCommentUiState;
  subscribe(listener: () => void): () => void;
  set(patch: Partial<BoardCommentUiState>): void;
  openDraft(draft: Omit<BoardCommentDraft, 'key'>): void;
  closeDraft(): void;
  openCard(commentId: string): void;
  closeCard(): void;
  setShowResolved(show: boolean): void;
}

export const INITIAL_BOARD_COMMENT_STATE: BoardCommentUiState = Object.freeze({
  nodeId: null,
  ready: false,
  hover: null,
  draft: null,
  draftOpen: false,
  cardId: null,
  cardOpen: false,
  showResolved: false,
});

export function createBoardCommentStore(): BoardCommentStore {
  const listeners = new Set<() => void>();
  let state: BoardCommentUiState = INITIAL_BOARD_COMMENT_STATE;
  let draftKey = 0;
  const set = (patch: Partial<BoardCommentUiState>): void => {
    const keys = Object.keys(patch) as Array<keyof BoardCommentUiState>;
    if (keys.every((key) => Object.is(state[key], patch[key]))) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  return {
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    set,
    openDraft(draft) {
      draftKey += 1;
      set({ draft: { ...draft, key: draftKey }, draftOpen: true, hover: null, cardOpen: false });
    },
    closeDraft() {
      set({ draftOpen: false });
    },
    openCard(commentId) {
      set({ cardId: commentId, cardOpen: true, draftOpen: false });
    },
    closeCard() {
      set({ cardOpen: false });
    },
    setShowResolved(show) {
      set({ showResolved: show });
    },
  };
}

const stores = new WeakMap<BoardEngine, BoardCommentStore>();

export function boardCommentStoreFor(engine: BoardEngine): BoardCommentStore {
  let store = stores.get(engine);
  if (!store) {
    store = createBoardCommentStore();
    stores.set(engine, store);
  }
  return store;
}

export function useBoardCommentStore(): BoardCommentStore {
  return boardCommentStoreFor(useBoardEngine());
}

/** A slice of the comment UI state; re-renders when the slice changes (`Object.is`). */
export function useBoardCommentState<T>(store: BoardCommentStore, selector: (state: BoardCommentUiState) => T): T {
  const read = useMemo(() => () => selector(store.getState()), [store, selector]);
  return useSyncExternalStore(store.subscribe, read, read);
}

/* ── per-frame session ──────────────────────────────────────────────────────────────────── */

export interface BoardCommentSession {
  readonly nodeId: string;
  /** the frame document (re)loaded: turns the picker on again */
  frameLoaded(): void;
  hover(target: FrameCommentTarget): void;
  leave(): void;
  /** a click on an element: opens the composer for it */
  pick(target: FrameCommentTarget): void;
  end(): void;
}

export interface BoardCommentSessionDeps {
  nodeId: string;
  filePath: string;
  /** postMessage to the frame's current document */
  post(message: unknown): void;
  store: BoardCommentStore;
}

export function createBoardCommentSession(deps: BoardCommentSessionDeps): BoardCommentSession {
  const { nodeId, filePath, store } = deps;
  let ended = false;
  const picker = (on: boolean): void => deps.post({ type: 'od:comment-mode', enabled: on, mode: 'picker' });
  const mine = (): boolean => store.getState().nodeId === nodeId;
  store.set({ nodeId, ready: false, hover: null });
  return {
    nodeId,
    frameLoaded() {
      if (ended) return;
      picker(true);
      if (mine()) store.set({ ready: true });
    },
    hover(target) {
      if (!ended && mine()) store.set({ hover: target });
    },
    leave() {
      if (!ended && mine() && store.getState().hover) store.set({ hover: null });
    },
    pick(target) {
      if (ended || !mine()) return;
      store.openDraft({ nodeId, filePath, target });
    },
    end() {
      if (ended) return;
      ended = true;
      picker(false);
      const state = store.getState();
      if (state.nodeId === nodeId) store.set({ nodeId: null, ready: false, hover: null });
      if (state.draft?.nodeId === nodeId && state.draftOpen) store.closeDraft();
    },
  };
}

export interface FrameCommentSessionInput {
  nodeId: string;
  /** the project page the frame shows (null: no comments) */
  path: string | null;
  /** NodeView `commenting` */
  commenting: boolean;
  /** the current document finished loading */
  ready: boolean;
  /** changes whenever a new document mounts (reload, file change) */
  documentKey: string | null;
  post(message: unknown): void;
}

/**
 * The comment session of one frame face: running while `commenting`, pinned live meanwhile (`requestLive`), the
 * picker re-armed on every loaded document. Returns the ref the face's message handlers forward to.
 */
export function useFrameCommentSession(input: FrameCommentSessionInput): MutableRefObject<BoardCommentSession | null> {
  const engine = useBoardEngine();
  const store = boardCommentStoreFor(engine);
  const session = useRef<BoardCommentSession | null>(null);
  const readyRef = useRef(input.ready);
  readyRef.current = input.ready;
  const postRef = useRef(input.post);
  postRef.current = input.post;
  const { nodeId, path, commenting, ready, documentKey } = input;

  useEffect(() => {
    if (!commenting || !path) return undefined;
    const current = createBoardCommentSession({ nodeId, filePath: path, store, post: (message) => postRef.current(message) });
    session.current = current;
    engine.commands.requestLive(nodeId, true);
    if (readyRef.current) current.frameLoaded();
    return () => {
      current.end();
      if (session.current === current) session.current = null;
      engine.commands.requestLive(nodeId, false);
    };
  }, [commenting, path, nodeId, engine, store]);

  useEffect(() => {
    if (commenting && ready && documentKey) session.current?.frameLoaded();
  }, [commenting, ready, documentKey]);

  return session;
}
