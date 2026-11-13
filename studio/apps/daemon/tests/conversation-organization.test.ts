import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  closeDatabase,
  getConversation,
  insertConversation,
  insertProject,
  listConversations,
  openDatabase,
  updateConversation,
} from '../src/db.js';
import { createSqlitePublicFilePublicationStore } from '../src/collab/public-file-publication-store.js';
import { isUnsharedLocalProject } from '../src/collab/local-project-share-state.js';
import { createProjectGroup, deleteProjectGroup, readProjectOrganization, updateProjectOrganization } from '../src/project-organization.js';

let directory: string;
beforeEach(() => {
  directory = mkdtempSync(path.join(os.tmpdir(), 'conversation-organization-'));
});
afterEach(() => {
  closeDatabase();
  rmSync(directory, { recursive: true, force: true });
});

function seed() {
  const db = openDatabase(directory, { dataDir: directory });
  createSqlitePublicFilePublicationStore(db);
  insertProject(db, { id: 'project', name: 'Local', createdAt: 1, updatedAt: 1 });
  insertConversation(db, { id: 'chat', projectId: 'project', title: 'Chat', createdAt: 1, updatedAt: 1 });
  return db;
}

it('persists conversation pins and archives across reopening without losing them on rename', () => {
  let db = seed();
  expect(getConversation(db, 'chat')).toMatchObject({ pinnedAt: null, archivedAt: null });
  updateConversation(db, 'chat', { pinnedAt: 20 });
  updateConversation(db, 'chat', { title: 'Renamed' });
  expect(listConversations(db, 'project')[0]).toMatchObject({ title: 'Renamed', pinnedAt: 20 });
  updateConversation(db, 'chat', { pinnedAt: null, archivedAt: 30 });
  closeDatabase();
  db = openDatabase(directory, { dataDir: directory });
  expect(getConversation(db, 'chat')).toMatchObject({ title: 'Renamed', pinnedAt: null, archivedAt: 30 });
  updateConversation(db, 'chat', { archivedAt: null });
  expect(listConversations(db, 'project')[0]?.archivedAt).toBeNull();
});

it('migrates older conversation tables without changing titles or messages', () => {
  let db = seed();
  db.exec('ALTER TABLE conversations DROP COLUMN pinned_at');
  db.exec('ALTER TABLE conversations DROP COLUMN archived_at');
  db.exec('ALTER TABLE conversations DROP COLUMN group_id');
  db.exec('ALTER TABLE conversations DROP COLUMN unread_at');
  db.exec('ALTER TABLE conversations DROP COLUMN read_at');
  closeDatabase();
  db = openDatabase(directory, { dataDir: directory });
  expect(getConversation(db, 'chat')).toMatchObject({ title: 'Chat', pinnedAt: null, archivedAt: null });
});

it('persists sections and read state without changing conversation activity or ownership', () => {
  const db = seed();
  const group = createProjectGroup(db, 'Reviews');
  updateConversation(db, 'chat', { groupId: group.id, unreadAt: 5, readAt: 3 });
  expect(getConversation(db, 'chat')).toMatchObject({ projectId: 'project', updatedAt: 1, groupId: group.id, unreadAt: 5, readAt: 3 });
  expect(readProjectOrganization(db).conversations).toEqual([{ conversationId: 'chat', projectId: 'project', groupId: group.id }]);
  deleteProjectGroup(db, group.id);
  expect(getConversation(db, 'chat')).toMatchObject({ groupId: null, unreadAt: 5 });
});

it('removing and restoring a sidebar project retains its conversation', () => {
  const db = seed();
  const group = createProjectGroup(db, 'Work');
  updateProjectOrganization(db, 'project', { groupId: group.id, pinned: true, removed: true }, 10);
  expect(readProjectOrganization(db).projects[0]).toMatchObject({ removedAt: 10, pinnedAt: 10 });
  deleteProjectGroup(db, group.id);
  expect(readProjectOrganization(db).projects[0]).toMatchObject({ removedAt: 10, groupId: null });
  updateProjectOrganization(db, 'project', { removed: false });
  expect(getConversation(db, 'chat')).toMatchObject({ title: 'Chat', projectId: 'project' });
});

it('only classifies existing unbound projects without publication evidence as locally unshared', () => {
  const db = seed();
  expect(isUnsharedLocalProject(db, 'missing')).toBe(false);
  expect(isUnsharedLocalProject(db, 'project')).toBe(true);
  const publications = createSqlitePublicFilePublicationStore(db);
  publications.set(
    { resourceTeamId: 'workspace', ownerMemberId: 'owner', projectId: 'project', filePath: 'index.html' },
    { slug: 'shared', fileName: 'index.html', url: 'https://example.invalid/shared' },
  );
  expect(isUnsharedLocalProject(db, 'project')).toBe(false);
});
