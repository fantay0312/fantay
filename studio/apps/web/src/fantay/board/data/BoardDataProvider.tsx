// SPDX-License-Identifier: AGPL-3.0-only
// Board data provider (spec 04 §7.1, plan R1/R8): one store per project route and workspace identity, mounted in the
// board layer (which stays mounted while 文件 is visible, so placements continue in the background). It loads the
// store, feeds it the project bus, runs the chat-sync triggers and owns the focus intent the board UI executes.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { WorkspaceContextItem } from '@open-design/contracts';

import { useProjectCollabContext } from '../../../collab/collab-context';
import { workspaceIdentityCacheKey } from '../../../collab/workspace-identity';
import { classifyOpenRequestNames } from '../sync/focus';
import { useBoardChatSync } from '../sync/use-board-chat-sync';
import { subscribeBoardProjectEvents } from './board-events';
import { createBoardStore } from './board-store';
import { boardClientId } from './client-id';
import type { BoardDataStore, BoardDataValue, BoardFocusIntent, BoardHostBindings, BoardStoreState } from './types';

export type { BoardDataValue, BoardFocusIntent, BoardHostBindings } from './types';

const BoardDataContext = createContext<BoardDataValue | null>(null);

// StrictMode runs effect cleanups and re-runs them with the same store: disposal waits one tick and is cancelled
// when the store is mounted again.
const pendingDisposals = new WeakMap<BoardDataStore, ReturnType<typeof setTimeout>>();

function scheduleDispose(store: BoardDataStore): void {
  const timer = setTimeout(() => {
    pendingDisposals.delete(store);
    store.dispose();
  }, 0);
  pendingDisposals.set(store, timer);
}

function cancelDispose(store: BoardDataStore): void {
  const timer = pendingDisposals.get(store);
  if (timer === undefined) return;
  clearTimeout(timer);
  pendingDisposals.delete(store);
}

export interface BoardDataProviderProps extends BoardHostBindings {
  children: ReactNode;
  /** Test seam: store factory (defaults to `createBoardStore`). */
  createStore?: typeof createBoardStore;
}

export function BoardDataProvider(props: BoardDataProviderProps): JSX.Element {
  const { children, createStore = createBoardStore, ...host } = props;
  const { workspaceContext } = useProjectCollabContext();
  const identityKey = workspaceIdentityCacheKey(workspaceContext);
  const storeKey = `${host.projectId}\u0000${identityKey}\u0000${host.readOnly ? 'ro' : 'rw'}`;

  const make = (): { key: string; store: BoardDataStore } => ({
    key: storeKey,
    // No side effects until `load()`: a store created by a discarded StrictMode render is just garbage.
    store: createStore({ projectId: host.projectId, clientId: boardClientId(), workspaceContext, readOnly: host.readOnly }),
  });
  const [entry, setEntry] = useState(make);
  let current = entry;
  if (entry.key !== storeKey) {
    current = make();
    setEntry(current);
  }
  const store = current.store;

  const hostRef = useRef(host);
  hostRef.current = host;

  useEffect(() => {
    cancelDispose(store);
    void store.load();
    const unsubscribe = subscribeBoardProjectEvents(host.projectId, (event) => store.handleBusEvent(event));
    const onUnload = () => store.dispose();
    if (typeof window !== 'undefined') window.addEventListener('unload', onUnload);
    return () => {
      if (typeof window !== 'undefined') window.removeEventListener('unload', onUnload);
      unsubscribe();
      scheduleDispose(store);
    };
  }, [store, host.projectId]);

  // ---- focus intents --------------------------------------------------------------------------------------
  const [focusIntent, setFocusIntent] = useState<BoardFocusIntent | null>(null);
  const nonceRef = useRef(0);
  const lastCameraInteraction = useRef<number | null>(null);
  useEffect(() => {
    setFocusIntent(null);
  }, [store]);

  /** Latest wins: a new intent replaces a pending one (spec 04 §7.4); only emitted while the board is active. */
  const emitFocus = useCallback((intent: Omit<BoardFocusIntent, 'nonce'>) => {
    if (!hostRef.current.active || intent.nodeIds.length === 0) return;
    nonceRef.current += 1;
    setFocusIntent({ ...intent, nodeIds: [...intent.nodeIds], nonce: nonceRef.current });
  }, []);
  const ackFocusIntent = useCallback((nonce: number) => {
    setFocusIntent((pending) => (pending && pending.nonce === nonce ? null : pending));
  }, []);
  const noteCameraInteraction = useCallback(() => {
    lastCameraInteraction.current = Date.now();
  }, []);
  const cameraIdleMs = useCallback(() => (
    lastCameraInteraction.current === null ? Number.POSITIVE_INFINITY : Date.now() - lastCameraInteraction.current
  ), []);
  const willHandleOpenRequest = useCallback((request: { name: string; openBatch?: readonly string[] }) => {
    const bindings = hostRef.current;
    if (!bindings.active) return false;
    const names = request.openBatch && request.openBatch.length > 0 ? [...request.openBatch] : [request.name];
    return classifyOpenRequestNames(names, bindings.files, bindings.liveArtifacts).placeable.length > 0;
  }, []);

  // Stable callback wrappers: the host may pass fresh closures every render.
  const onActiveContextChange = useCallback((item: WorkspaceContextItem | null) => {
    hostRef.current.onActiveContextChange(item);
  }, []);
  const onUnplaceableOpenRequest = useCallback((name: string) => {
    hostRef.current.onUnplaceableOpenRequest(name);
  }, []);

  const hostBindings = useMemo<BoardHostBindings>(() => ({
    projectId: host.projectId,
    projectDir: host.projectDir,
    active: host.active,
    readOnly: host.readOnly,
    files: host.files,
    filesGeneration: host.filesGeneration,
    liveArtifacts: host.liveArtifacts,
    messages: host.messages,
    activeConversationId: host.activeConversationId,
    runInFlight: host.runInFlight,
    openRequest: host.openRequest,
    onActiveContextChange,
    onUnplaceableOpenRequest,
  }), [
    host.projectId, host.projectDir, host.active, host.readOnly, host.files, host.filesGeneration, host.liveArtifacts,
    host.messages, host.activeConversationId, host.runInFlight, host.openRequest, onActiveContextChange, onUnplaceableOpenRequest,
  ]);

  useBoardChatSync({ store, host: hostBindings, cameraIdleMs, emitFocus, workspaceContext });

  const value = useMemo<BoardDataValue>(() => ({
    store,
    host: hostBindings,
    focusIntent,
    ackFocusIntent,
    noteCameraInteraction,
    willHandleOpenRequest,
  }), [store, hostBindings, focusIntent, ackFocusIntent, noteCameraInteraction, willHandleOpenRequest]);

  return <BoardDataContext.Provider value={value}>{children}</BoardDataContext.Provider>;
}

export function useBoardData(): BoardDataValue {
  const value = useContext(BoardDataContext);
  if (!value) throw new Error('useBoardData() must be used inside <BoardDataProvider>');
  return value;
}

/** `useBoardData()` that returns null outside a provider. */
export function useOptionalBoardData(): BoardDataValue | null {
  return useContext(BoardDataContext);
}

/** Selector over a store's state (`useSyncExternalStore`, server snapshot included per amendment B2). */
export function useBoardStoreState<T>(store: BoardDataStore, selector: (state: BoardStoreState) => T): T {
  const cache = useRef<{ state: BoardStoreState; selector: (state: BoardStoreState) => T; value: T } | null>(null);
  const read = (): T => {
    const state = store.getState();
    const cached = cache.current;
    if (cached && cached.state === state && cached.selector === selector) return cached.value;
    const value = selector(state);
    if (cached && Object.is(cached.value, value)) {
      cache.current = { state, selector, value: cached.value };
      return cached.value;
    }
    cache.current = { state, selector, value };
    return value;
  };
  return useSyncExternalStore(store.subscribe, read, read);
}

export function useBoardState<T>(selector: (state: BoardStoreState) => T): T {
  const { store } = useBoardData();
  return useBoardStoreState(store, selector);
}
