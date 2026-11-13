// SPDX-License-Identifier: AGPL-3.0-only
// Design documents in the workspace (plan R10): they open in the 文件 root like the motion editor, through
// `workspace.openEditor` (the shell subscribes; without a subscriber the route deep link opens the tab),
// and land on the board as `design` drafts through `board.insert` (queued while no board is mounted).
import { navigate } from '../../router';
import { getActiveProjectSession } from '../shell/project-bridge';
import { queueBoardInsert, sendWorkspaceCommand, type WorkspaceCommandOf } from '../workspace/workspace-bus';

/** Opens `path` in the project's 文件 root (the file tab renders `DesignDocumentViewer`). */
export function openDesignDocument(projectId: string, path: string, options?: { conversationId?: string | null }): void {
  const handled = sendWorkspaceCommand({ type: 'workspace.openEditor', projectId, fileName: path });
  if (handled) return;
  const session = getActiveProjectSession();
  const conversationId =
    options?.conversationId !== undefined
      ? options.conversationId
      : session?.projectId === projectId
        ? session.activeConversationId
        : null;
  navigate({ kind: 'project', projectId, conversationId, fileName: path });
}

function deliverBoardInsert(command: WorkspaceCommandOf<'board.insert'>): 'sent' | 'queued' {
  if (sendWorkspaceCommand(command)) return 'sent';
  queueBoardInsert(command);
  return 'queued';
}

/** A saved design as a board node; `sourceNodeId` adds a lineage edge from that node (R21). */
export function insertDesignOnBoard(
  projectId: string,
  draft: { path: string; title?: string; sourceNodeId?: string },
): 'sent' | 'queued' {
  return deliverBoardInsert({
    type: 'board.insert',
    projectId,
    select: true,
    drafts: [
      {
        kind: 'design',
        path: draft.path,
        ...(draft.title ? { title: draft.title } : {}),
        ...(draft.sourceNodeId ? { sourceNodeId: draft.sourceNodeId } : {}),
      },
    ],
  });
}

/** A project HTML page (e.g. a design saved as a web page) as a board frame (spec 06 §8.2). */
export function insertFrameOnBoard(projectId: string, path: string, title?: string): 'sent' | 'queued' {
  return deliverBoardInsert({
    type: 'board.insert',
    projectId,
    drafts: [{ kind: 'frame', path, ...(title ? { title } : {}) }],
  });
}
