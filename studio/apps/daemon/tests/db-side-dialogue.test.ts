import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { boundSideConversation, closeDatabase, deleteConversation, getConversation, getFirstProjectConversation,
  insertConversation, insertProject, listConversations, openDatabase, updateConversation } from '../src/db.js';

it('binds ordinary side runs to their own conversation and preserves the main conversation lifecycle', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'fantay-side-chat-'));
  try {
    const db = openDatabase(dir, { dataDir: dir });
    insertProject(db, { id: 'p', name: 'Project', createdAt: 10, updatedAt: 10 });
    insertConversation(db, { id: 'parent', projectId: 'p', executionPermission: 'workspace-write', createdAt: 10, updatedAt: 10 });
    expect(boundSideConversation(db, 'p', 'parent', 'one', false)).toBeNull();
    const one = boundSideConversation(db, 'p', 'parent', 'one')!;
    const two = boundSideConversation(db, 'p', 'parent', 'two')!;
    expect(boundSideConversation(db, 'p', 'parent', 'one')?.id).toBe(one.id);
    expect(boundSideConversation(db, 'p', 'parent', 'one', false)?.id).toBe(one.id);
    expect(two.id).not.toBe(one.id);
    expect(boundSideConversation(db, 'other', 'parent', 'one')).toBeNull();
    expect(boundSideConversation(db, 'p', one.id, 'one')).toBeNull();
    expect(one.executionPermission).toBe('read-only');
    updateConversation(db, one.id, { executionPermission: 'danger-full-access' });
    expect(getConversation(db, 'parent')?.executionPermission).toBe('workspace-write');
    expect(listConversations(db, 'p').map(c => [c.id, c.hasSideDialogue])).toEqual([['parent', true]]);
    expect(getFirstProjectConversation(db, 'p')?.id).toBe('parent');
    deleteConversation(db, 'parent');
    expect(getConversation(db, one.id)).toBeNull();
    expect(getConversation(db, two.id)).toBeNull();
  } finally { closeDatabase(); rmSync(dir, { recursive: true, force: true }); }
});
