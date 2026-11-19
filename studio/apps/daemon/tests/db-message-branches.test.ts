import { mkdtempSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeDatabase, getMessage, insertConversation, insertProject, latestCompletedAssistantMessageId,
  listMessages, openDatabase, upsertMessage,
} from '../src/db.js';
import { pinAssistantMessageOnRunCreate } from '../src/runtimes/chat-run-messages.js';
import { beginMessageBranch, selectMessageBranch } from '../src/storage/message-branches.js';

let directory: string;
let db: ReturnType<typeof openDatabase>;
const conversationId = 'conversation';

function add(id: string, role: 'user' | 'assistant') {
  upsertMessage(db, conversationId, {
    id, role, content: id, ...(role === 'assistant' ? { runStatus: 'succeeded' } : {}),
  });
}

function visible() {
  return listMessages(db, conversationId).map(message => message.id);
}

beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'fantay-message-branches-'));
  db = openDatabase(directory, { dataDir: directory });
  const now = Date.now();
  insertProject(db, { id: 'project', name: 'Project', createdAt: now, updatedAt: now });
  insertConversation(db, { id: conversationId, projectId: 'project', createdAt: now, updatedAt: now });
  add('question', 'user');
  add('answer', 'assistant');
  add('follow-up', 'user');
  add('follow-up-answer', 'assistant');
});

afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

describe('message versions', () => {
  it('keeps both reply branches, their follow-ups and the selected path across reloads', () => {
    const run = { id: 'run', conversationId, assistantMessageId: 'answer-2', status: 'queued', createdAt: Date.now() };
    expect(pinAssistantMessageOnRunCreate(db, run, {
      beforeClaimCommit: () => beginMessageBranch(db, conversationId, {
        action: 'regenerate', messageId: 'answer', expectedLeafId: 'follow-up-answer',
      }, 'question', 'answer-2'),
    }).ok).toBe(true);
    expect(visible()).toEqual(['question', 'answer-2']);
    expect(getMessage(db, 'answer')?.content).toBe('answer');
    expect(latestCompletedAssistantMessageId(db, conversationId, 'answer-2')).toBeNull();
    expect(listMessages(db, conversationId)[1]?.branchVersionIds).toEqual(['answer', 'answer-2']);

    add('new-follow-up', 'user');
    add('new-follow-up-answer', 'assistant');
    selectMessageBranch(db, conversationId, 'answer', 'new-follow-up-answer');
    closeDatabase();
    db = openDatabase(directory, { dataDir: directory });
    expect(visible()).toEqual(['question', 'answer', 'follow-up', 'follow-up-answer']);
    selectMessageBranch(db, conversationId, 'answer-2', 'follow-up-answer');
    expect(visible()).toEqual(['question', 'answer-2', 'new-follow-up', 'new-follow-up-answer']);
  });

  it('makes an edited first question a sibling and rolls back a failed claim', () => {
    const edit = {
      action: 'edit' as const, messageId: 'question', expectedLeafId: 'follow-up-answer',
    };
    const claim = (fail = false) => db.transaction(() => {
      beginMessageBranch(db, conversationId, edit, 'question-2', 'answer-2');
      add('question-2', 'user');
      if (fail) throw new Error('claim failed');
      add('answer-2', 'assistant');
    })();
    expect(() => claim(true)).toThrow('claim failed');
    expect(visible()).toEqual(['question', 'answer', 'follow-up', 'follow-up-answer']);
    claim();
    expect(visible()).toEqual(['question-2', 'answer-2']);
    expect(listMessages(db, conversationId)[0]?.branchVersionIds).toEqual(['question', 'question-2']);
    expect(() => selectMessageBranch(db, conversationId, 'question', 'follow-up-answer')).toThrow();
    selectMessageBranch(db, conversationId, 'question', 'answer-2');
    expect(visible()).toEqual(['question', 'answer', 'follow-up', 'follow-up-answer']);
  });
});
