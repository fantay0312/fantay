// SPDX-License-Identifier: AGPL-3.0-only
// Assembled project board (spec 02 §5.6, 03 §2, 04 §7.1, 05 §4.11, 06 §6, 07 §2.1/§3/§7; plan §4 W3-board-assembly).
// Replaces the W1 placeholder. Composes BoardDataProvider -> GenerationProvider -> DesignEditorEventBridge + BoardView.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useProjectCollabContext } from '../../collab/collab-context';
import { revealProjectChat } from '../chat/project-chat-bridge';
import { DesignEditorEventBridge } from '../design/DesignEditorEventBridge';
import {
  GenerationProvider,
  createGenerationBoardPort,
  type GenerationSettingsSection,
} from '../generation';
import { ToolDialogHost } from '../media-tools';
import { fanCardPosition } from '../media-nodes/CandidateFan';
import { runProjectCommand, useActiveProjectSession } from '../shell/project-bridge';
import { useFantayShell } from '../shell/shell-context';
import { toast } from '../ui';
import type { FantayBoardHostProps } from '../workspace/board-host-contract';
import {
  deriveBuildingState,
  useAssembledBoardExtensions,
  useBoardFocusRequest,
  useBoardInsertBridge,
} from './assembly';
import { BoardView } from './BoardView';
import type { BoardCommands } from './commands/board-commands';
import type { BoardCommentsHost } from './comments/use-board-comment-session';
import { BoardDataProvider, useBoardData, useBoardState } from './data/BoardDataProvider';
import { useBoardSelectionContextSync } from './sync/use-board-selection-context';

function isHtmlFramePath(path: string | undefined): path is string {
  if (!path) return false;
  const lower = path.toLowerCase();
  return lower.endsWith('.html') || lower.endsWith('.htm');
}

function AssembledGenerationLayer({ hostProps }: { hostProps: FantayBoardHostProps }): JSX.Element {
  const data = useBoardData();
  const { workspaceContext } = useProjectCollabContext();
  const session = useActiveProjectSession(hostProps.projectId);
  const shell = useFantayShell();
  const boardReady = useBoardState((state) => state.status === 'ready' && state.board !== null);
  const commandsRef = useRef<BoardCommands | null>(null);

  const generationBoardPort = useMemo(
    () =>
      createGenerationBoardPort(data.store, {
        select: (ids) => commandsRef.current?.select(ids),
        focus: (id) => {
          const commands = commandsRef.current;
          if (!commands) return;
          const board = data.store.getState().board;
          const node = board?.nodes.find((entry) => entry.id === id);
          const count = (node?.kind === 'image' || node?.kind === 'video') ? (node.generation?.candidates.length ?? 0) : 0;
          if (node && count > 1) {
            let minX = 0;
            let minY = 0;
            let maxX = node.w;
            let maxY = node.h;
            for (let index = 0; index < count - 1; index += 1) {
              const pos = fanCardPosition(index, count, node.w, node.h);
              minX = Math.min(minX, pos.x);
              minY = Math.min(minY, pos.y);
              maxX = Math.max(maxX, pos.x + node.w);
              maxY = Math.max(maxY, pos.y + node.h);
            }
            commands.camera.fitRect(
              { x: node.x + minX, y: node.y + minY, w: maxX - minX, h: maxY - minY },
              { maxZoom: 1, animate: false },
            );
            return;
          }
          commands.focusNodes([id], { animate: true });
        },
      }),
    [data.store],
  );

  const handleOpenSettings = useCallback(
    (section: GenerationSettingsSection) => {
      if (runProjectCommand(hostProps.projectId, { kind: 'openSettings', section })) return;
      shell?.openAccountServices('services');
    },
    [hostProps.projectId, shell],
  );

  const handleNotify = useCallback((notification: { tone: 'info' | 'success' | 'error'; message: string }) => {
    toast({
      title: notification.message,
      tone: notification.tone === 'error' ? 'danger' : notification.tone === 'success' ? 'success' : 'default',
    });
  }, []);

  const handleRevealChat = useCallback(() => {
    revealProjectChat(hostProps.projectId);
  }, [hostProps.projectId]);

  const renderToolDialogs = useCallback(
    ({ request, close }: { request: Parameters<typeof ToolDialogHost>[0]['dialog']; close(): void }) => (
      <ToolDialogHost dialog={request} onClose={close} />
    ),
    [],
  );

  return (
    <GenerationProvider
      projectId={hostProps.projectId}
      projectMetadata={session?.projectMetadata ?? null}
      mediaProviders={session?.mediaProviders}
      workspaceContext={workspaceContext}
      board={generationBoardPort}
      boardReady={boardReady}
      readOnly={data.host.readOnly}
      onOpenSettings={handleOpenSettings}
      notify={handleNotify}
      onRevealChat={handleRevealChat}
      renderToolDialogs={renderToolDialogs}
    >
      <AssembledBoardBodyWithCommandsRef hostProps={hostProps} portCommandsRef={commandsRef} />
    </GenerationProvider>
  );
}

function AssembledBoardBodyWithCommandsRef({
  hostProps,
  portCommandsRef,
}: {
  hostProps: FantayBoardHostProps;
  portCommandsRef: React.MutableRefObject<BoardCommands | null>;
}): JSX.Element {
  const data = useBoardData();
  const { workspaceContext } = useProjectCollabContext();
  const session = useActiveProjectSession(hostProps.projectId);
  const projectPlatform = session?.projectMetadata?.platform;
  const readOnly = data.host.readOnly;
  const boardReady = useBoardState((state) => state.status === 'ready' && state.board !== null);
  const board = useBoardState((state) => state.board);

  const [selectedIds, setSelectedIds] = useState<readonly string[]>([]);

  useEffect(() => {
    setSelectedIds([]);
  }, [hostProps.projectId]);

  useBoardSelectionContextSync({ selectedIds });

  const shareTargetPath = useMemo<string | null>(() => {
    if (selectedIds.length !== 1 || !board) return null;
    const node = board.nodes.find((entry) => entry.id === selectedIds[0]);
    if (!node || node.kind !== 'frame' || node.missing) return null;
    const path = node.ref?.path;
    return isHtmlFramePath(path) ? path : null;
  }, [board, selectedIds]);

  const onShareTargetChangeRef = useRef(hostProps.onShareTargetChange);
  onShareTargetChangeRef.current = hostProps.onShareTargetChange;

  useEffect(() => {
    onShareTargetChangeRef.current(shareTargetPath);
  }, [shareTargetPath]);

  useEffect(() => {
    return () => {
      onShareTargetChangeRef.current(null);
    };
  }, []);

  useBoardInsertBridge({
    projectId: hostProps.projectId,
    boardReady,
    readOnly,
    store: data.store,
    commandsRef: portCommandsRef,
    isDeckProject: hostProps.isDeckProject,
    projectPlatform,
  });

  useBoardFocusRequest({
    projectId: hostProps.projectId,
    boardReady,
    focusRequest: hostProps.focusRequest,
    store: data.store,
    commandsRef: portCommandsRef,
  });

  const extensions = useAssembledBoardExtensions({
    projectId: hostProps.projectId,
    files: hostProps.files,
    readOnly,
    workspaceContext,
    store: data.store,
    commandsRef: portCommandsRef,
    onRefreshFiles: hostProps.onRefreshFiles,
  });

  const {
    previewComments,
    onSavePreviewComment,
    onRemovePreviewComment,
    onSetPreviewCommentStatus,
    onSendBoardCommentAttachments,
  } = hostProps;
  const comments = useMemo<BoardCommentsHost>(
    () => ({
      comments: previewComments,
      ...(onSavePreviewComment ? { save: onSavePreviewComment } : {}),
      ...(onRemovePreviewComment ? { remove: onRemovePreviewComment } : {}),
      ...(onSetPreviewCommentStatus ? { setStatus: onSetPreviewCommentStatus } : {}),
      ...(onSendBoardCommentAttachments ? { send: onSendBoardCommentAttachments } : {}),
    }),
    [previewComments, onSavePreviewComment, onRemovePreviewComment, onSetPreviewCommentStatus, onSendBoardCommentAttachments],
  );

  const { buildingPaths, buildingAgentName } = useMemo(
    () =>
      deriveBuildingState({
        runInFlight: hostProps.runInFlight,
        streaming: hostProps.streaming,
        runSteps: hostProps.runSteps,
        files: hostProps.files,
        messages: hostProps.messages,
      }),
    [hostProps.runInFlight, hostProps.streaming, hostProps.runSteps, hostProps.files, hostProps.messages],
  );

  return (
    <>
      <DesignEditorEventBridge
        projectId={hostProps.projectId}
        workspaceContext={workspaceContext}
        readOnly={readOnly}
      />
      <BoardView
        data={data}
        files={hostProps.files}
        filesAuthoritative={hostProps.filesAuthoritative}
        filesRefreshKey={hostProps.filesRefreshKey}
        liveArtifacts={hostProps.liveArtifacts}
        messages={hostProps.messages}
        runInFlight={hostProps.runInFlight}
        buildingPaths={buildingPaths}
        buildingAgentName={buildingAgentName}
        isDeckProject={hostProps.isDeckProject}
        projectPlatform={projectPlatform}
        viewerOnly={readOnly}
        workspaceContext={workspaceContext}
        extensions={extensions}
        commandsRef={portCommandsRef}
        onOpenInFiles={hostProps.onOpenFile}
        onOpenBrowserTab={hostProps.onOpenBrowserTab}
        onRefreshFiles={hostProps.onRefreshFiles}
        onSelectionChange={setSelectedIds}
        comments={comments}
      />
    </>
  );
}

export function ProjectBoard(props: FantayBoardHostProps): JSX.Element {
  const readOnly = props.viewerOnly || Boolean(props.initialMaterializationPending);

  return (
    <BoardDataProvider
      projectId={props.projectId}
      projectDir={props.resolvedDir}
      active={props.active}
      readOnly={readOnly}
      files={props.files}
      filesGeneration={props.filesGeneration ?? 0}
      liveArtifacts={props.liveArtifacts}
      messages={props.messages}
      activeConversationId={props.activeConversationId}
      runInFlight={props.runInFlight}
      openRequest={props.openRequest}
      onActiveContextChange={props.onActiveContextChange}
      onUnplaceableOpenRequest={props.onOpenFile}
    >
      <AssembledGenerationLayer hostProps={props} />
    </BoardDataProvider>
  );
}
