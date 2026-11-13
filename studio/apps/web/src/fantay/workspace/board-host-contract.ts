// SPDX-License-Identifier: AGPL-3.0-only
// Workspace root tabs and the board-tab host contract (spec 02 §5.6 + plan R8). FileWorkspace builds
// `FantayBoardHostProps` through `useFantayWorkspace`; `apps/web/src/fantay/board/ProjectBoard.tsx`
// renders them. The board must not edit FileWorkspace: everything it needs arrives through these props,
// `board-viewport-store`, `../shell/commands` and the shell context.
import type { ReactNode } from 'react';
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

export const BOARD_TAB = '__board__' as const;
export const PROJECT_DESIGN_SYSTEM_TAB = '__project_design_system__' as const;
/** false until W3-board-assembly lands `ProjectBoard` (plan §2); the 画板 tab stays hidden meanwhile. */
export const FANTAY_BOARD_READY: boolean = true;

export interface FantayBoardOpenRequest { name: string; nonce: number; openBatch?: readonly string[] }

/** One-shot request set by the `workspace.view` handler (`focus: { kind: 'motion' }`, plan R8 / 07 §2.1). */
export interface FantayBoardFocusRequest { kind: 'motion'; nonce: number }

export interface FantayBoardHostProps {
  projectId: string;
  projectName: string;
  resolvedDir: string | null;
  viewerOnly: boolean;
  /** true while 画板 is the visible workspace surface */
  active: boolean;
  files: readonly ProjectFile[]; // FileWorkspace.visibleFiles
  filesRefreshKey: number | undefined;
  filesGeneration: number | undefined;
  liveArtifacts: readonly LiveArtifactWorkspaceEntry[]; // FileWorkspace.liveArtifactEntries
  browserTabs: readonly ProjectBrowserWorkspaceTab[];
  messages: readonly ChatMessage[];
  conversations: readonly Conversation[];
  activeConversationId: string | null;
  previewComments: readonly PreviewComment[];
  streaming: boolean; // composer actions disabled
  runInFlight: boolean; // a run is actually writing
  runStartedAt: number | null;
  runSteps: readonly RunProgressStep[]; // runtime/run-progress.ts
  /** One-shot: chat/agent asked to show these files while the board is active (nonce changes per request). */
  openRequest: FantayBoardOpenRequest | null;
  /** R8: deck projects size HTML frames as slides. */
  isDeckProject: boolean;
  /** R8: select and fly to the motion node (`workspace.view` with `focus: { kind: 'motion' }`). */
  focusRequest: FantayBoardFocusRequest | null;
  /**
   * FileWorkspace `filesAuthoritative` (default true): false while the file list may still be partial,
   * so the board does not treat absent files as missing (BoardView prop, plan R2).
   */
  filesAuthoritative?: boolean;
  /** FileWorkspace `initialMaterializationPending`: board readOnly = viewerOnly || this (plan R8). */
  initialMaterializationPending?: boolean;
  onOpenFile(name: string): void; // switches to 文件 with that file tab
  onOpenBrowserTab(url?: string): void; // FileWorkspace openBrowserTab / openRequestedBrowserTab
  onRefreshFiles(): void;
  onUploadFiles(files: File[]): Promise<void>;
  /** Selection → composer context chip (FileWorkspace forwards as its active workspace context). */
  onActiveContextChange(context: WorkspaceContextItem | null): void;
  /** Selected single HTML frame → Share target (null = fall back to defaultBoardShareTarget). */
  onShareTargetChange(fileName: string | null): void;
  renderFileViewer(file: ProjectFile, workspaceActive: boolean): ReactNode;
  /*
   * Board comments (pins, card, composer) on the active conversation's `previewComments`, through the same
   * per-conversation comment API FileViewer uses (FileWorkspace props of the same names). Absent → that action is
   * off on the board. Save resolves null and remove/status false on failure (ProjectView shows the toast).
   */
  onSavePreviewComment?(target: PreviewCommentTarget, note: string, attachAfterSave: boolean, images?: File[], commentId?: string): Promise<PreviewComment | null>;
  onRemovePreviewComment?(commentId: string): Promise<boolean>;
  /** PATCH status (resolve = 'resolved', reopen = 'open'). */
  onSetPreviewCommentStatus?(commentId: string, status: PreviewCommentStatus): Promise<boolean>;
  /** Queues the comments as chat tasks for the agent (ProjectView `handleSendBoardCommentAttachments`). */
  onSendBoardCommentAttachments?(attachments: ChatCommentAttachment[], images?: File[]): Promise<CommentSendResult> | CommentSendResult;
}
// The board exports: export function ProjectBoard(props: FantayBoardHostProps): JSX.Element
// (named export; the module default is not used). The W1 placeholder returns null.
