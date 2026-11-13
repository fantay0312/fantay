// SPDX-License-Identifier: AGPL-3.0-only
// Chat → board sync triggers (spec 04 §7.4). The daemon's planner is the single writer of derived nodes; this hook
// only tells it when to run (`store.sync`) and turns the responses into focus intents for the board UI.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import type {
  BoardSyncRequest,
  BoardSyncResponse,
  BoardSyncTurnHint,
  ChatMessage,
  WorkspaceCollabContext,
} from '@open-design/contracts';

import { BOARD_CAMERA_IDLE_FLY_MS, BOARD_SYNC_FILES_DEBOUNCE_MS } from '../data/constants';
import type { BoardDataStore, BoardFocusIntent, BoardHostBindings, BoardStoreState } from '../data/types';
import { classifyOpenRequestNames, resolveBoardNodesForNames } from './focus';
import { useBoardMediaWatch } from './media-watch';

export interface UseBoardChatSyncInput {
  store: BoardDataStore;
  host: BoardHostBindings;
  /** ms since the user last panned/zoomed/dragged (Infinity when never). */
  cameraIdleMs: () => number;
  emitFocus: (intent: Omit<BoardFocusIntent, 'nonce'>) => void;
  /** For the media task poll (same identity as the store). */
  workspaceContext?: WorkspaceCollabContext | null;
  /** Test seams. */
  setTimeoutFn?: typeof setTimeout;
  clearTimeoutFn?: typeof clearTimeout;
}

function latestAssistantMessage(messages: readonly ChatMessage[]): ChatMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role === 'assistant') return message;
  }
  return null;
}

function producedFileNames(message: ChatMessage | null): string[] {
  return (message?.producedFiles ?? []).map((file) => file.name).filter((name) => typeof name === 'string' && name.length > 0);
}

function hasActivePending(state: BoardStoreState): boolean {
  return state.board?.nodes.some((node) =>
    (node.kind === 'image' || node.kind === 'video' || node.kind === 'audio')
    && (node.pending?.status === 'queued' || node.pending?.status === 'running')) ?? false;
}

export function useBoardChatSync(input: UseBoardChatSyncInput): void {
  const { store, host } = input;
  const latest = useRef(input);
  latest.current = input;

  const ready = useSyncExternalStore(
    store.subscribe,
    () => store.getState().status === 'ready',
    () => false,
  );
  const pendingMedia = useSyncExternalStore(
    store.subscribe,
    () => hasActivePending(store.getState()),
    () => false,
  );

  const assistant = latestAssistantMessage(host.messages);
  const producedNames = producedFileNames(assistant);
  const producedSignature = `${assistant?.id ?? ''}\n${producedNames.join('\n')}`;

  /** Turn hint of the latest assistant message (spec 04 §7.4), or undefined when there is none yet. */
  const turnHint = useCallback((status: BoardSyncTurnHint['status'], paths?: string[]): BoardSyncTurnHint | undefined => {
    const { host: current } = latest.current;
    const message = latestAssistantMessage(current.messages);
    if (!message || !current.activeConversationId) return undefined;
    return {
      conversationId: current.activeConversationId,
      messageId: message.id,
      ...(message.runId ? { runId: message.runId } : {}),
      status,
      ...(paths && paths.length > 0 ? { paths: paths.slice(0, 500) } : {}),
    };
  }, []);

  const requestSync = useCallback((request: BoardSyncRequest): Promise<BoardSyncResponse | null> => {
    const { host: current, store: currentStore } = latest.current;
    if (current.readOnly) return Promise.resolve(null);
    const conversationId = current.activeConversationId;
    return currentStore.sync({ ...(conversationId ? { conversationId } : {}), ...request });
  }, []);

  const focusBehavior = useCallback((): BoardFocusIntent['behavior'] => (
    latest.current.cameraIdleMs() >= BOARD_CAMERA_IDLE_FLY_MS ? 'fly-to' : 'reveal-pill'
  ), []);

  // Trigger 1: the store becomes ready (once per store/project).
  const openedFor = useRef<BoardDataStore | null>(null);
  useEffect(() => {
    if (!ready || host.readOnly || openedFor.current === store) return;
    openedFor.current = store;
    void requestSync({ reason: 'open' });
  }, [ready, store, host.readOnly, requestSync]);

  // Triggers 2 and 3: run start / run end / produced files of the latest turn changed while idle. The previous
  // values are per project: switching projects records the new baseline without triggering.
  const previousRun = useRef({ projectId: host.projectId, running: host.runInFlight, produced: producedSignature });
  useEffect(() => {
    const previous = previousRun.current;
    previousRun.current = { projectId: host.projectId, running: host.runInFlight, produced: producedSignature };
    if (previous.projectId !== host.projectId || host.readOnly) return;
    const wasRunning = previous.running;
    const producedBefore = previous.produced;
    if (!wasRunning && host.runInFlight) {
      const turn = turnHint('running');
      void requestSync({ reason: 'run-started', ...(turn ? { turn } : {}) });
      return;
    }
    const finished = wasRunning && !host.runInFlight;
    const producedChanged = !host.runInFlight && producedSignature !== producedBefore;
    if (!finished && !producedChanged) return;
    const turn = turnHint('terminal', producedFileNames(latestAssistantMessage(latest.current.host.messages)));
    void requestSync({ reason: 'run-finished', ...(turn ? { turn } : {}) }).then((response) => {
      if (!response) return;
      const created = response.placements.filter((placement) => placement.status === 'created').map((placement) => placement.nodeId);
      const nodeIds = [...new Set(created)];
      if (nodeIds.length === 0) return;
      latest.current.emitFocus({
        nodeIds,
        primaryNodeId: nodeIds[0] ?? null,
        behavior: focusBehavior(),
        source: 'run-finished',
      });
    });
  }, [host.projectId, host.runInFlight, producedSignature, host.readOnly, requestSync, turnHint, focusBehavior]);

  // Trigger 4: open requests (once per nonce, queued until the store is ready, only while the board is active).
  const handledNonce = useRef<number | null>(null);
  const request = host.openRequest;
  useEffect(() => {
    if (!request || handledNonce.current === request.nonce) return;
    if (!host.active) {
      // Not routed to the board: FileWorkspace opened it; never replay it on a later activation.
      handledNonce.current = request.nonce;
      return;
    }
    if (!ready) return;
    handledNonce.current = request.nonce;
    const { host: current, store: currentStore } = latest.current;
    const names = request.openBatch && request.openBatch.length > 0 ? [...request.openBatch] : [request.name];
    const { placeable } = classifyOpenRequestNames(names, current.files, current.liveArtifacts);
    if (placeable.length === 0) {
      current.onUnplaceableOpenRequest(request.name);
      return;
    }
    const primary = placeable.includes(request.name) ? request.name : placeable[0]!;
    if (current.readOnly) {
      const board = currentStore.getState().board;
      const nodeIds = board ? resolveBoardNodesForNames(board, placeable) : [];
      if (nodeIds.length === 0) {
        current.onUnplaceableOpenRequest(request.name);
        return;
      }
      const primaryIds = board ? resolveBoardNodesForNames(board, [primary]) : [];
      latest.current.emitFocus({
        nodeIds,
        primaryNodeId: primaryIds[0] ?? nodeIds[0] ?? null,
        behavior: focusBehavior(),
        source: 'open-request',
      });
      return;
    }
    const turn = current.runInFlight ? turnHint('running') : undefined;
    void requestSync({
      reason: 'focus',
      ...(turn ? { turn } : {}),
      focus: { names: placeable, primary },
    }).then((response) => {
      if (!response) return;
      const focus = response.focus;
      if (focus && focus.nodeIds.length > 0) {
        latest.current.emitFocus({
          nodeIds: [...focus.nodeIds],
          primaryNodeId: focus.primaryNodeId,
          behavior: focusBehavior(),
          source: 'open-request',
        });
        return;
      }
      if (response.unplaceable.includes(request.name)) latest.current.host.onUnplaceableOpenRequest(request.name);
    });
  }, [request, host.active, ready, requestSync, turnHint, focusBehavior]);

  // Trigger 5: file list changes while idle (debounced; per project like triggers 2 and 3).
  const previousGeneration = useRef({ projectId: host.projectId, generation: host.filesGeneration });
  const filesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const previous = previousGeneration.current;
    if (previous.projectId === host.projectId && previous.generation === host.filesGeneration) return;
    previousGeneration.current = { projectId: host.projectId, generation: host.filesGeneration };
    const clearT = latest.current.clearTimeoutFn ?? clearTimeout;
    if (filesTimer.current !== null) {
      clearT(filesTimer.current);
      filesTimer.current = null;
    }
    if (previous.projectId !== host.projectId || host.runInFlight || host.readOnly) return;
    const setT = latest.current.setTimeoutFn ?? setTimeout;
    filesTimer.current = setT(() => {
      filesTimer.current = null;
      if (latest.current.host.runInFlight) return;
      void requestSync({ reason: 'files-changed' });
    }, BOARD_SYNC_FILES_DEBOUNCE_MS);
  }, [host.projectId, host.filesGeneration, host.runInFlight, host.readOnly, requestSync]);
  useEffect(() => () => {
    if (filesTimer.current !== null) (latest.current.clearTimeoutFn ?? clearTimeout)(filesTimer.current);
  }, []);

  // Trigger 6: agent media tasks progressed (poll while a run is in flight or the board shows queued/running media).
  const onMediaSignature = useCallback(() => {
    void requestSync({ reason: 'media' });
  }, [requestSync]);
  useBoardMediaWatch({
    projectId: host.projectId,
    enabled: !host.readOnly && (host.runInFlight || pendingMedia),
    workspaceContext: input.workspaceContext ?? null,
    onSignatureChange: onMediaSignature,
    ...(input.setTimeoutFn ? { setTimeoutFn: input.setTimeoutFn } : {}),
    ...(input.clearTimeoutFn ? { clearTimeoutFn: input.clearTimeoutFn } : {}),
  });
}
