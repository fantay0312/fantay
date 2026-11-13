// SPDX-License-Identifier: AGPL-3.0-only
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDatabase, deleteProject, insertProject, openDatabase, type SqliteDb } from '../src/db.js';
import {
  createProjectGroup,
  deleteProjectGroup,
  ProjectArchivedError,
  readProjectOrganization,
  reorderProjectGroups,
  updateProjectOrganization,
} from '../src/project-organization.js';

let root: string;
let db: SqliteDb;

const entryOf = (projectId: string) => readProjectOrganization(db).projects.find((entry) => entry.projectId === projectId);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'od-project-organization-'));
  db = openDatabase(root, { dataDir: root });
  insertProject(db, { id: 'p', name: 'p', createdAt: 1, updatedAt: 1 });
});

afterEach(() => {
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

describe('project organization', () => {
  it('leaves omitted fields alone and drops an entry with nothing left in it', () => {
    const group = createProjectGroup(db, 'Clients');
    updateProjectOrganization(db, 'p', { groupId: group.id }, 10);
    updateProjectOrganization(db, 'p', { pinned: true }, 20);
    expect(entryOf('p')).toEqual({ projectId: 'p', groupId: group.id, pinnedAt: 20, archivedAt: null, removedAt: null });
    updateProjectOrganization(db, 'p', { pinned: true }, 30);
    expect(entryOf('p')?.pinnedAt).toBe(20);
    updateProjectOrganization(db, 'p', { pinned: false, groupId: null });
    expect(entryOf('p')).toBeUndefined();
  });

  it('archiving unpins and keeps the group; an archived project refuses a pin until restored', () => {
    const group = createProjectGroup(db, 'Clients');
    updateProjectOrganization(db, 'p', { pinned: true, groupId: group.id }, 10);
    updateProjectOrganization(db, 'p', { archived: true }, 20);
    expect(entryOf('p')).toEqual({ projectId: 'p', groupId: group.id, pinnedAt: null, archivedAt: 20, removedAt: null });
    expect(() => updateProjectOrganization(db, 'p', { pinned: true })).toThrow(ProjectArchivedError);
    updateProjectOrganization(db, 'p', { archived: false, pinned: true }, 30);
    expect(entryOf('p')).toEqual({ projectId: 'p', groupId: group.id, pinnedAt: 30, archivedAt: null, removedAt: null });
  });

  it('deleting a group returns its projects to the plain list', () => {
    const group = createProjectGroup(db, 'Clients');
    insertProject(db, { id: 'q', name: 'q', createdAt: 1, updatedAt: 1 });
    updateProjectOrganization(db, 'p', { groupId: group.id });
    updateProjectOrganization(db, 'q', { groupId: group.id, pinned: true }, 5);
    expect(deleteProjectGroup(db, group.id)).toBe(true);
    expect(entryOf('p')).toBeUndefined();
    expect(entryOf('q')).toMatchObject({ groupId: null, pinnedAt: 5 });
    expect(deleteProjectGroup(db, group.id)).toBe(false);
  });

  it('forgets a deleted project', () => {
    updateProjectOrganization(db, 'p', { pinned: true });
    deleteProject(db, 'p');
    expect(readProjectOrganization(db).projects).toEqual([]);
  });

  it('reorders only with every group named exactly once', () => {
    const a = createProjectGroup(db, 'a');
    const b = createProjectGroup(db, 'b');
    expect(reorderProjectGroups(db, [a.id])).toBe(false);
    expect(reorderProjectGroups(db, [a.id, a.id])).toBe(false);
    expect(reorderProjectGroups(db, [b.id, a.id])).toBe(true);
    expect(readProjectOrganization(db).groups.map((group) => group.name)).toEqual(['b', 'a']);
  });
});
