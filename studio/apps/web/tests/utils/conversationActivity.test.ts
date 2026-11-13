// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';

import { composerDraftExtrasKey } from '../../src/runtime/chat/composer-draft';
import type { Conversation } from '../../src/types';
import {
  composerDraftKeyFor,
  hasConversationActivity,
  isUntouchedConversation,
} from '../../src/utils/conversationActivity';

function chat(extra: Partial<Conversation> = {}): Conversation {
  return { id: 'c1', projectId: 'p1', title: null, messageCount: 0, createdAt: 1, updatedAt: 1, ...extra };
}

afterEach(() => window.localStorage.clear());

describe('hasConversationActivity', () => {
  it('counts stored messages, a started run and a live stream', () => {
    expect(hasConversationActivity(chat())).toBe(false);
    expect(hasConversationActivity(chat({ messageCount: undefined }))).toBe(false);
    expect(hasConversationActivity(chat({ messageCount: 1 }))).toBe(true);
    expect(hasConversationActivity(chat({ latestRun: { status: 'running' } }))).toBe(true);
    expect(hasConversationActivity(chat(), new Set(['c1']))).toBe(true);
  });
});

describe('isUntouchedConversation', () => {
  it('is an empty, unnamed chat with no unsent draft', () => {
    expect(isUntouchedConversation(chat(), 'p1')).toBe(true);
  });

  it('keeps a chat the owner named, used, or started typing into', () => {
    expect(isUntouchedConversation(chat({ title: 'Design system' }), 'p1')).toBe(false);
    expect(isUntouchedConversation(chat({ messageCount: 3 }), 'p1')).toBe(false);

    window.localStorage.setItem(composerDraftKeyFor('p1', 'c1'), 'half a prompt');
    expect(isUntouchedConversation(chat(), 'p1')).toBe(false);
    window.localStorage.clear();

    window.localStorage.setItem(composerDraftExtrasKey(composerDraftKeyFor('p1', 'c1')), '{"attachments":[1]}');
    expect(isUntouchedConversation(chat(), 'p1')).toBe(false);
  });

  it('uses the same draft key ChatPane writes', () => {
    expect(composerDraftKeyFor('p1', 'c1')).toBe('od:chat-composer:draft:p1:c1');
  });
});
