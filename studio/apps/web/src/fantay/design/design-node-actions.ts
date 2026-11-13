// SPDX-License-Identifier: AGPL-3.0-only
// Actions of a board `design` node (amendment C9; W3-board-assembly returns them from
// `BoardExtensions.nodeActions(nodeId, 'design')`): the default "打开编辑器" (the OpenPencil-based editor in
// the 文件 root) and, for `.fig` files, "发给 AI（Figma 快照）": the existing offline Figma import
// (`importProjectFigma`) decodes the design into an agent-readable `figma/` snapshot, and its ready-made
// reshape prompt is sent to the project's chat.
import { PenTool, Sparkles } from 'lucide-react';
import { designFormatForPath, toDesignBridgeError, type WorkspaceCollabContext } from '@open-design/contracts';

import type { Dict } from '../../i18n/types';
import { importProjectFigma } from '../../providers/registry';
import type { BoardNodeAction } from '../board/extensions';
import { revealProjectChat, sendToProjectChat, type ProjectChatSendOptions, type ProjectChatSendResult } from '../chat/project-chat-bridge';
import { toast } from '../ui';
import { designBaseName, readDesign } from './design-api';
import { openDesignDocument } from './design-workspace';

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/**
 * `ProjectChatSendOptions.source` (W1 seam, 07 §2.1(b)) predates design nodes and is informational only —
 * `sendToProjectChat` never reads it. Follow-up for the seam's owner: add `'design-node'` to the union.
 */
const DESIGN_NODE_CHAT_SOURCE = 'design-node' as unknown as ProjectChatSendOptions['source'];

export interface DesignNodeActionInput {
  projectId: string;
  /** The node's `ref.path` (`designs/*.fig` | `*.op`). */
  path: string;
  t: Translate;
  workspaceContext?: WorkspaceCollabContext | null;
  /** Viewer-only projects: the snapshot action is disabled. */
  readOnly?: boolean;
  /** Override for the open action (e.g. the board's `extensions.openDesignDocument`). */
  onOpen?(path: string): void;
}

const CHAT_FAILURE_KEYS: Record<Extract<ProjectChatSendResult, { accepted: false }>['reason'], keyof Dict> = {
  busy: 'designEditor.figmaSnapshot.busy',
  'no-chat': 'designEditor.figmaSnapshot.noChat',
  rejected: 'designEditor.figmaSnapshot.rejected',
};

/** Decodes the design into a `figma/` snapshot and sends the reshape prompt to the project chat. */
export async function sendDesignFigmaSnapshotToChat(input: Omit<DesignNodeActionInput, 'onOpen'>): Promise<'sent' | 'failed'> {
  const { projectId, path, t } = input;
  const ctx = input.workspaceContext ?? null;
  const toastId = toast({ title: t('designEditor.figmaSnapshot.action'), busy: true, duration: 0 });
  const fail = (reason: string): 'failed' => {
    toast({ id: toastId, title: t('designEditor.figmaSnapshot.failed', { reason }), tone: 'danger' });
    return 'failed';
  };
  try {
    const design = await readDesign(projectId, path, ctx);
    if (!design) return fail(t('designEditor.conflict.missing'));
    const file = new File([design.bytes], designBaseName(path), { type: 'application/octet-stream' });
    const imported = await importProjectFigma(projectId, file, undefined, ctx);
    if (!imported.ok) return fail(imported.error);
    const sent = await sendToProjectChat(projectId, imported.result.suggestedPrompt, { source: DESIGN_NODE_CHAT_SOURCE });
    if (!sent.accepted) return fail(t(CHAT_FAILURE_KEYS[sent.reason]));
    revealProjectChat(projectId);
    toast({ id: toastId, title: t('designEditor.figmaSnapshot.sent'), tone: 'success' });
    return 'sent';
  } catch (error) {
    return fail(toDesignBridgeError(error).message);
  }
}

/** The design node's actions: open (bar) and, for `.fig`, the Figma snapshot for the agent (more menu). */
export function designNodeActions(input: DesignNodeActionInput): BoardNodeAction[] {
  const open = input.onOpen ?? ((path: string) => openDesignDocument(input.projectId, path));
  const actions: BoardNodeAction[] = [
    { id: 'design.open', labelKey: 'board.node.openEditor', icon: PenTool, placement: 'bar', run: () => open(input.path) },
  ];
  if (designFormatForPath(input.path) === 'fig') {
    actions.push({
      id: 'design.figmaSnapshot',
      labelKey: 'designEditor.figmaSnapshot.action',
      icon: Sparkles,
      placement: 'more',
      ...(input.readOnly ? { disabledReasonKey: 'designEditor.figmaSnapshot.readOnly' as const } : {}),
      run: async () => {
        if (input.readOnly) return;
        await sendDesignFigmaSnapshotToChat(input);
      },
    });
  }
  return actions;
}
