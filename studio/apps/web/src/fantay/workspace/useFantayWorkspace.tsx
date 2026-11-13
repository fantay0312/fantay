// SPDX-License-Identifier: AGPL-3.0-only
// FileWorkspace controller of the Fantay workspace (spec 02 §5.6/§7, plan R7/R8/R10, 07 §2.1). It owns the
// root tabs 画板 / 文件 / 设计系统, the board header pieces, the board layer (mounted once after the first
// activation and only hidden afterwards), the project design-system body, the open-request routing and
// the workspace bus handlers (`workspace.openEditor`, `workspace.view`). FileWorkspace keeps every upstream
// branch: it calls this hook once and places the nodes it returns.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { WorkspaceContextItem } from '@open-design/contracts';

import type { CommentSendResult } from '../../components/comment-send-result';
import type { RunProgressStep } from '../../runtime/run-progress';
import type {
  ChatCommentAttachment,
  ChatMessage,
  Conversation,
  LiveArtifactWorkspaceEntry,
  PreviewComment,
  PreviewCommentStatus,
  PreviewCommentTarget,
  ProjectBrowserWorkspaceTab,
  ProjectFile,
} from '../../types';
import { BoardHeaderActions } from './BoardHeader';
import { BoardHeaderSlot } from './board-header-slot';
import { BoardTabHost } from './BoardTabHost';
import { WorkspaceMaximizeButton } from './WorkspaceMaximizeButton';
import { WorkspacePanelToggle } from './WorkspacePanelToggle';
import {
  BOARD_TAB,
  FANTAY_BOARD_READY,
  PROJECT_DESIGN_SYSTEM_TAB,
  type FantayBoardFocusRequest,
  type FantayBoardHostProps,
  type FantayBoardOpenRequest,
} from './board-host-contract';
import { routeOpenRequestTarget } from './open-request-routing';
import { ProjectDesignSystemTab } from './ProjectDesignSystemTab';
import { MotionStyleHost } from '../motion/MotionEditorHost';
import { subscribeWorkspaceCommand } from './workspace-bus';
import {
  WORKSPACE_DESIGN_FILES_TAB,
  WORKSPACE_DESIGN_SYSTEM_TAB,
  WORKSPACE_START_TAB,
  fantayRootFor,
  type FantayWorkspaceRoot,
} from './workspace-roots';

export interface UseFantayWorkspaceInput {
  enabled: boolean;
  projectId: string;
  projectName: string;
  resolvedDir: string | null;
  viewerOnly: boolean;
  streaming: boolean;
  runInFlight: boolean;
  runStartedAt: number | null;
  runSteps: readonly RunProgressStep[];
  activeTab: string;
  routeFileName: string | null;
  isDesignSystemProject: boolean;
  isMotionProject?: boolean;
  workspaceTabIds: readonly string[];
  files: readonly ProjectFile[];
  filesRefreshKey?: number;
  filesGeneration?: number;
  liveArtifacts: readonly LiveArtifactWorkspaceEntry[];
  browserTabs: readonly ProjectBrowserWorkspaceTab[];
  messages: readonly ChatMessage[];
  conversations: readonly Conversation[];
  activeConversationId: string | null;
  previewComments: readonly PreviewComment[];
  /** R8: FileWorkspace `isDeck` (deck projects size HTML frames as slides). */
  isDeckProject: boolean;
  /** R8 / R2: FileWorkspace `filesAuthoritative` (false while the file list may still be partial). */
  filesAuthoritative: boolean;
  /** R8: FileWorkspace `initialMaterializationPending`; the board is read-only and hidden meanwhile. */
  initialMaterializationPending: boolean;
  setPersistedActive(name: string | null): void;
  focusWorkspaceTab(tabId: string): void;
  /** Opens (and persists) a file tab; switches the workspace to the 文件 root. */
  openFile(name: string): void;
  openBrowserTab(url?: string): void;
  refreshFiles(): void;
  uploadFiles(files: File[]): Promise<void>;
  renderFileViewer(file: ProjectFile, workspaceActive: boolean): ReactNode;
  /** FileWorkspace-owned state setter (declared early so the context memo can read it); reset to null on projectId change. */
  onBoardActiveContextChange(context: WorkspaceContextItem | null): void;
  /** FileWorkspace comment callbacks (board comment pins / card / composer). */
  savePreviewComment?(target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[], commentId?: string): Promise<PreviewComment | null>;
  removePreviewComment?(commentId: string): Promise<boolean>;
  setPreviewCommentStatus?(commentId: string, status: PreviewCommentStatus): Promise<boolean>;
  sendBoardCommentAttachments?(attachments: ChatCommentAttachment[], images?: File[]): Promise<CommentSendResult> | CommentSendResult;
}

const REJECTED_COMMENT_SEND: CommentSendResult = { status: 'rejected', commentIds: [] };

export interface FantayWorkspaceController {
  enabled: boolean;
  root: FantayWorkspaceRoot;
  /** enabled && activeTab === BOARD_TAB && FANTAY_BOARD_READY */
  boardActive: boolean;
  boardToolbar: ReactNode;
  /** <BoardHeaderActions/> (zoom menu + Share) while the board is the visible surface, else null */
  headerActions: ReactNode;
  /** <ProjectDesignSystemTab/> when activeTab === PROJECT_DESIGN_SYSTEM_TAB, else null */
  body: ReactNode | null;
  /** The board (R8): rendered once inside `.ws-body`, mounted after the first activation, hidden while inactive. */
  boardLayer: ReactNode | null;
  /** true ⇒ request routed to the board (FileWorkspace must return early). */
  consumeOpenRequest(request: FantayBoardOpenRequest): boolean;
}

/** Board-host state that belongs to one project; a project switch starts from `emptyBoardHostState`. */
interface BoardHostState {
  projectId: string;
  boardMounted: boolean;
  openRequest: FantayBoardOpenRequest | null;
  focusRequest: FantayBoardFocusRequest | null;
  shareTarget: string | null;
}

function emptyBoardHostState(projectId: string): BoardHostState {
  return { projectId, boardMounted: false, openRequest: null, focusRequest: null, shareTarget: null };
}

type BoardHostPatch = Partial<Omit<BoardHostState, 'projectId'>>;

export function useFantayWorkspace(input: UseFantayWorkspaceInput): FantayWorkspaceController {
  const {
    enabled,
    projectId,
    projectName,
    resolvedDir,
    viewerOnly,
    streaming,
    runInFlight,
    runStartedAt,
    runSteps,
    activeTab,
    routeFileName,
    files,
    filesRefreshKey,
    filesGeneration,
    liveArtifacts,
    browserTabs,
    messages,
    conversations,
    activeConversationId,
    previewComments,
    isDeckProject,
    filesAuthoritative,
    initialMaterializationPending,
  } = input;

  // Latest input for callbacks and bus handlers; they only run after a commit.
  const inputRef = useRef(input);
  inputRef.current = input;

  const [storedState, setStoredState] = useState<BoardHostState>(() => emptyBoardHostState(projectId));
  const hostState = storedState.projectId === projectId ? storedState : emptyBoardHostState(projectId);
  const patchHostState = useCallback((patch: (current: BoardHostState) => BoardHostPatch) => {
    setStoredState((previous) => {
      const currentProjectId = inputRef.current.projectId;
      const base = previous.projectId === currentProjectId ? previous : emptyBoardHostState(currentProjectId);
      const changes = patch(base);
      const keys = Object.keys(changes) as Array<keyof BoardHostPatch>;
      if (base === previous && keys.every((key) => Object.is(base[key], changes[key]))) return previous;
      return { ...base, ...changes };
    });
  }, []);

  const nonceRef = useRef(0);
  const nextNonce = useCallback(() => {
    nonceRef.current += 1;
    return nonceRef.current;
  }, []);

  const boardAvailable = enabled && FANTAY_BOARD_READY;
  const boardActive = boardAvailable && activeTab === BOARD_TAB;
  // While the project's first materialization is pending FileWorkspace shows its placeholder panel; the
  // board stays mounted (read-only, plan R8) but hidden, and the header shows the 文件 root.
  const boardVisible = boardActive && !initialMaterializationPending;
  const root: FantayWorkspaceRoot = initialMaterializationPending ? 'files' : fantayRootFor(activeTab);

  // The last active tab whose root is 文件, so 文件 returns to it (spec 02 §5.6).
  const lastFilesTabRef = useRef<{ projectId: string; tab: string } | null>(null);
  useEffect(() => {
    if (!enabled || initialMaterializationPending) return;
    if (activeTab !== WORKSPACE_START_TAB && fantayRootFor(activeTab) === 'files') {
      lastFilesTabRef.current = { projectId, tab: activeTab };
    }
  }, [enabled, initialMaterializationPending, projectId, activeTab]);

  const selectRoot = useCallback((next: FantayWorkspaceRoot) => {
    const current = inputRef.current;
    if (!current.enabled) return;
    if (next === 'board') {
      if (FANTAY_BOARD_READY) current.setPersistedActive(BOARD_TAB);
      return;
    }
    if (next === 'designSystem') {
      current.setPersistedActive(current.isDesignSystemProject ? WORKSPACE_DESIGN_SYSTEM_TAB : PROJECT_DESIGN_SYSTEM_TAB);
      return;
    }
    const last = lastFilesTabRef.current;
    const target = last && last.projectId === current.projectId && current.workspaceTabIds.includes(last.tab)
      ? last.tab
      : WORKSPACE_DESIGN_FILES_TAB;
    current.focusWorkspaceTab(target);
  }, []);

  // Keep the board mounted after its first activation in this project (R8).
  useEffect(() => {
    if (!boardActive || hostState.boardMounted) return;
    patchHostState(() => ({ boardMounted: true }));
  }, [boardActive, hostState.boardMounted, patchHostState]);
  const boardMounted = boardAvailable && (hostState.boardMounted || boardActive);

  // A project switch clears the board selection context FileWorkspace holds (spec 02 §7.4).
  const contextProjectRef = useRef(projectId);
  useEffect(() => {
    if (contextProjectRef.current === projectId) return;
    contextProjectRef.current = projectId;
    inputRef.current.onBoardActiveContextChange(null);
  }, [projectId]);

  // Workspace bus (07 §2.1): explicit editor opens land on the 文件 root as a file tab, never as a board
  // focus; `workspace.view` switches the root and can ask the board to fly to the motion node. Both
  // handle only their own project, so senders can fall back (navigate / queue) for other projects.
  useEffect(() => {
    if (!enabled) return undefined;
    const unsubscribeOpenEditor = subscribeWorkspaceCommand('workspace.openEditor', (command) => {
      const current = inputRef.current;
      if (command.projectId !== current.projectId || !command.fileName) return false;
      current.openFile(command.fileName);
      return true;
    });
    const unsubscribeView = subscribeWorkspaceCommand('workspace.view', (command) => {
      const current = inputRef.current;
      if (command.projectId !== current.projectId) return false;
      if (command.view === 'board' && FANTAY_BOARD_READY) {
        current.setPersistedActive(BOARD_TAB);
        if (command.focus?.kind === 'motion') {
          const focusRequest: FantayBoardFocusRequest = { kind: 'motion', nonce: nextNonce() };
          patchHostState(() => ({ focusRequest }));
        }
        return true;
      }
      selectRoot('files');
      return true;
    });
    return () => {
      unsubscribeOpenEditor();
      unsubscribeView();
    };
  }, [enabled, nextNonce, patchHostState, selectRoot]);

  const consumeOpenRequest = (request: FantayBoardOpenRequest): boolean => {
    if (!enabled || initialMaterializationPending) return false;
    const target = routeOpenRequestTarget({
      name: request.name,
      activeTab,
      routeFileName,
      boardReady: FANTAY_BOARD_READY,
    });
    if (target !== 'board') return false;
    const openRequest: FantayBoardOpenRequest = request.openBatch
      ? { name: request.name, nonce: nextNonce(), openBatch: [...request.openBatch] }
      : { name: request.name, nonce: nextNonce() };
    patchHostState(() => ({ openRequest }));
    return true;
  };

  // Stable host callbacks: they always reach the latest FileWorkspace closures.
  const onOpenFile = useCallback((name: string) => {
    inputRef.current.openFile(name);
  }, []);
  const onOpenBrowserTab = useCallback((url?: string) => {
    inputRef.current.openBrowserTab(url);
  }, []);
  const onRefreshFiles = useCallback(() => {
    inputRef.current.refreshFiles();
  }, []);
  const onUploadFiles = useCallback((picked: File[]) => inputRef.current.uploadFiles(picked), []);
  const onActiveContextChange = useCallback((context: WorkspaceContextItem | null) => {
    inputRef.current.onBoardActiveContextChange(context);
  }, []);
  const onShareTargetChange = useCallback((fileName: string | null) => {
    patchHostState(() => ({ shareTarget: fileName }));
  }, [patchHostState]);
  const renderFileViewer = useCallback(
    (file: ProjectFile, workspaceActive: boolean) => inputRef.current.renderFileViewer(file, workspaceActive),
    [],
  );
  const onSavePreviewComment = useCallback(
    (target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[], commentId?: string) => {
      const save = inputRef.current.savePreviewComment;
      return save ? save(target, note, attachAfterSave, images, commentId) : Promise.resolve(null);
    },
    [],
  );
  const onRemovePreviewComment = useCallback((commentId: string) => {
    const remove = inputRef.current.removePreviewComment;
    return remove ? remove(commentId) : Promise.resolve(false);
  }, []);
  const onSetPreviewCommentStatus = useCallback((commentId: string, status: PreviewCommentStatus) => {
    const setStatus = inputRef.current.setPreviewCommentStatus;
    return setStatus ? setStatus(commentId, status) : Promise.resolve(false);
  }, []);
  const onSendBoardCommentAttachments = useCallback(async (attachments: ChatCommentAttachment[], images?: File[]) => {
    const send = inputRef.current.sendBoardCommentAttachments;
    return send ? send(attachments, images) : REJECTED_COMMENT_SEND;
  }, []);

  const hostProps = useMemo<FantayBoardHostProps>(() => ({
    projectId,
    projectName,
    resolvedDir,
    viewerOnly,
    active: boardVisible,
    files,
    filesRefreshKey,
    filesGeneration,
    liveArtifacts,
    browserTabs,
    messages,
    conversations,
    activeConversationId,
    previewComments,
    streaming,
    runInFlight,
    runStartedAt,
    runSteps,
    openRequest: hostState.openRequest,
    isDeckProject,
    focusRequest: hostState.focusRequest,
    filesAuthoritative,
    initialMaterializationPending,
    onOpenFile,
    onOpenBrowserTab,
    onRefreshFiles,
    onUploadFiles,
    onActiveContextChange,
    onShareTargetChange,
    renderFileViewer,
    onSavePreviewComment,
    onRemovePreviewComment,
    onSetPreviewCommentStatus,
    onSendBoardCommentAttachments,
  }), [
    projectId,
    projectName,
    resolvedDir,
    viewerOnly,
    boardVisible,
    files,
    filesRefreshKey,
    filesGeneration,
    liveArtifacts,
    browserTabs,
    messages,
    conversations,
    activeConversationId,
    previewComments,
    streaming,
    runInFlight,
    runStartedAt,
    runSteps,
    hostState.openRequest,
    isDeckProject,
    hostState.focusRequest,
    filesAuthoritative,
    initialMaterializationPending,
    onOpenFile,
    onOpenBrowserTab,
    onRefreshFiles,
    onUploadFiles,
    onActiveContextChange,
    onShareTargetChange,
    renderFileViewer,
    onSavePreviewComment,
    onRemovePreviewComment,
    onSetPreviewCommentStatus,
    onSendBoardCommentAttachments,
  ]);

  if (!enabled) {
    return {
      enabled: false,
      root,
      boardActive: false,
      boardToolbar: null,
      headerActions: null,
      body: null,
      boardLayer: null,
      consumeOpenRequest,
    };
  }

  return {
    enabled: true,
    root,
    boardActive,
    boardToolbar: boardVisible ? <BoardHeaderSlot /> : null,
    headerActions: (
      <>
        <WorkspaceMaximizeButton />
        {boardVisible ? (
          <BoardHeaderActions
            projectId={projectId}
            files={files}
            shareTarget={hostState.shareTarget}
            viewerOnly={viewerOnly}
            streaming={streaming}
          />
        ) : null}
        <WorkspacePanelToggle />
      </>
    ),
    body: activeTab === PROJECT_DESIGN_SYSTEM_TAB ? (input.isMotionProject
      ? <MotionStyleHost projectId={projectId} active runInFlight={runInFlight} viewerOnly={viewerOnly}
          fileVersion={files.find((file) => file.name === 'movie-studio.json')?.mtime}
          onExit={() => inputRef.current.openFile('movie-studio.json')} />
      : <ProjectDesignSystemTab projectId={projectId} />) : null,
    boardLayer: boardMounted ? (
      <div
        data-testid="fantay-board-layer"
        data-active={boardVisible ? 'true' : 'false'}
        aria-hidden={boardVisible ? undefined : true}
        style={{ display: boardVisible ? 'flex' : 'none', flex: '1 1 auto', minHeight: 0, minWidth: 0 }}
      >
        <BoardTabHost key={projectId} {...hostProps} />
      </div>
    ) : null,
    consumeOpenRequest,
  };
}
