// SPDX-License-Identifier: AGPL-3.0-only
// When a chat counts as used. Lists (the sidebar, the chat panel's history) show only used chats, the way Codex
// does: pressing "new chat" opens a composer, and the chat appears once something happens in it. A chat that was
// never touched means nothing, so "new chat" reuses it and leaving it deletes it (ProjectView).
import { composerDraftExtrasKey } from '../runtime/chat/composer-draft';
import type { Conversation } from '../types';

const NO_RUNNING: ReadonlySet<string> = new Set();

/**
 * Something happened in the chat: a stored message, a run (the first send marks `latestRun` right away), or a
 * live stream.
 */
export function hasConversationActivity(
  conversation: Conversation,
  runningIds: ReadonlySet<string> = NO_RUNNING,
): boolean {
  return (conversation.messageCount ?? 0) > 0 || conversation.hasSideDialogue === true
    || conversation.latestRun != null || runningIds.has(conversation.id);
}

/** The localStorage key ChatPane keeps one chat's unsent composer text under. */
export function composerDraftKeyFor(projectId: string, conversationId: string): string {
  return `od:chat-composer:draft:${projectId}:${conversationId}`;
}

function hasStoredComposerDraft(projectId: string, conversationId: string): boolean {
  if (typeof window === 'undefined') return false;
  const key = composerDraftKeyFor(projectId, conversationId);
  try {
    return Boolean(window.localStorage.getItem(key)) || Boolean(window.localStorage.getItem(composerDraftExtrasKey(key)));
  } catch {
    return false;
  }
}

/**
 * A chat nobody did anything in: no message, no run, no name of its own and no unsent draft or attachment.
 * Safe to reuse for the next "new chat", or to delete once it is left.
 */
export function isUntouchedConversation(
  conversation: Conversation,
  projectId: string,
  runningIds: ReadonlySet<string> = NO_RUNNING,
): boolean {
  return (
    !hasConversationActivity(conversation, runningIds)
    && conversation.pinnedAt == null
    && conversation.archivedAt == null
    && conversation.groupId == null
    && conversation.unreadAt == null
    && !conversation.title?.trim()
    && !hasStoredComposerDraft(projectId, conversation.id)
  );
}
