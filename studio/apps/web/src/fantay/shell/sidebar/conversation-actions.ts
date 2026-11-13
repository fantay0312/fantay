// SPDX-License-Identifier: AGPL-3.0-only
import type { WorkspaceCollabContext } from '@open-design/contracts';
import type { ChatMessage, Conversation } from '../../../types';
import { formAnswersDisplayBody } from '../../../artifacts/question-form';
import { isDesignSystemWorkspacePrompt } from '../../../design-system-auto-prompt';
import { loadConversationTranscript } from '../../../state/load-conversation-transcript';
import { updateProjectConversations } from '../../../state/projects';
import { currentWorkspaceAccountGeneration } from '../../../collab/workspace-identity';
import { acknowledgeProjectCompletion } from '../../../hooks/useProjectRunStatuses';
import { runProjectCommand } from '../project-bridge';
import { reconcileSidebarConversation } from './use-sidebar-conversations';

export function applyConversationReceipt(conversation: Conversation): void {
  reconcileSidebarConversation(conversation.projectId, conversation.id, conversation);
  runProjectCommand(conversation.projectId, { kind: 'conversationUpdated', conversation });
}

export async function organizeAllConversations(
  projectId: string,
  action: 'read' | 'archive',
  context: WorkspaceCollabContext | null,
): Promise<void> {
  const generation = currentWorkspaceAccountGeneration();
  const conversations = await updateProjectConversations(projectId, action, context);
  if (generation !== currentWorkspaceAccountGeneration()) return;
  for (const conversation of conversations) applyConversationReceipt(conversation);
  if (action === 'read') acknowledgeProjectCompletion(projectId);
}

export function visibleTranscript(
  messages: readonly ChatMessage[],
  labels: { user: string; assistant: string; designSystem: string },
): string {
  return messages
    .filter((message) => message.role === 'user' || message.role === 'assistant')
    .map((message) => {
      const content =
        message.role === 'user'
          ? isDesignSystemWorkspacePrompt(message.content)
            ? labels.designSystem
            : formAnswersDisplayBody(message.content)
          : message.content;
      return content.trim()
        ? `## ${message.role === 'user' ? labels.user : labels.assistant}\n\n${content.trim()}`
        : '';
    })
    .filter(Boolean)
    .join('\n\n');
}

export async function conversationText(
  conversation: Conversation,
  context: WorkspaceCollabContext | null,
  labels: { user: string; assistant: string; designSystem: string },
  signal = new AbortController().signal,
): Promise<string> {
  const messages = await loadConversationTranscript(conversation.projectId, conversation.id, context, signal);
  return visibleTranscript(messages, labels);
}

export function conversationShareHtml(title: string, transcript: string): string {
  const escape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
    );
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title><style>body{margin:0;background:#faf9f6;color:#232323;font:16px/1.8 system-ui,sans-serif}main{max-width:760px;padding:48px 24px;margin:auto}h1{font-size:28px;line-height:1.3}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}</style><main><h1>${escape(title)}</h1><pre>${escape(transcript)}</pre></main></html>`;
}
