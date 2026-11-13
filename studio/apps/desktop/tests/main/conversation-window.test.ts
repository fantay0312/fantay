import { expect, it } from 'vitest';
import { conversationWindowUrl } from '../../src/main/conversation-window.js';

it.each(['od://app/', 'http://127.0.0.1:5283/'])('opens a conversation on the same app origin %s', base => {
  expect(conversationWindowUrl(base, { projectId: 'project-1', conversationId: 'chat-2' })).toBe(new URL('/projects/project-1/conversations/chat-2', base).toString());
});
it.each([null, {}, { projectId: '../secrets', conversationId: 'c' }, { projectId: 'p', conversationId: 'https://external' }])('rejects non-conversation targets', input => {
  expect(conversationWindowUrl('od://app/', input)).toBeNull();
});
