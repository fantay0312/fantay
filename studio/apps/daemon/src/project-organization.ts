// SPDX-License-Identifier: AGPL-3.0-only
// Storage for the owner's project groups, pins and archive. See the contract in
// packages/contracts/src/api/project-organization.ts for what each field means.
import { randomUUID } from 'node:crypto';

import type {
  ProjectGroup,
  ProjectOrganizationEntry,
  ProjectOrganizationResponse,
  UpdateProjectOrganizationRequest,
} from '@open-design/contracts';

import type { SqliteDb } from './db.js';

type GroupRow = { id: string; name: string; position: number; createdAt: number; updatedAt: number };

const GROUP_COLUMNS = `id, name, position, created_at AS createdAt, updated_at AS updatedAt`;
const ENTRY_COLUMNS = `project_id AS projectId, group_id AS groupId, pinned_at AS pinnedAt, archived_at AS archivedAt, removed_at AS removedAt`;

export class ProjectArchivedError extends Error {
  constructor(projectId: string) {
    super(`project ${projectId} is archived`);
    this.name = 'ProjectArchivedError';
  }
}

export function readProjectOrganization(db: SqliteDb): ProjectOrganizationResponse {
  return {
    groups: db.prepare(`SELECT ${GROUP_COLUMNS} FROM project_groups ORDER BY position, created_at`).all() as GroupRow[],
    projects: db.prepare(`SELECT ${ENTRY_COLUMNS} FROM project_organization`).all() as ProjectOrganizationEntry[],
    conversations: db.prepare('SELECT id AS conversationId, project_id AS projectId, group_id AS groupId FROM conversations WHERE group_id IS NOT NULL').all() as NonNullable<ProjectOrganizationResponse['conversations']>,
  };
}

export function getProjectGroup(db: SqliteDb, id: string): ProjectGroup | null {
  return (db.prepare(`SELECT ${GROUP_COLUMNS} FROM project_groups WHERE id = ?`).get(id) as GroupRow | undefined) ?? null;
}

export function createProjectGroup(db: SqliteDb, name: string, now = Date.now()): ProjectGroup {
  const last = db.prepare(`SELECT MAX(position) AS position FROM project_groups`).get() as { position: number | null };
  const group: ProjectGroup = { id: randomUUID(), name, position: (last.position ?? -1) + 1, createdAt: now, updatedAt: now };
  db.prepare(
    `INSERT INTO project_groups (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(group.id, group.name, group.position, group.createdAt, group.updatedAt);
  return group;
}

export function renameProjectGroup(db: SqliteDb, id: string, name: string, now = Date.now()): ProjectGroup | null {
  db.prepare(`UPDATE project_groups SET name = ?, updated_at = ? WHERE id = ?`).run(name, now, id);
  return getProjectGroup(db, id);
}

/** Its projects go back to the plain list (ON DELETE SET NULL); nothing else about them changes. */
export function deleteProjectGroup(db: SqliteDb, id: string): boolean {
  const removed = db.prepare(`DELETE FROM project_groups WHERE id = ?`).run(id).changes > 0;
  if (removed) {
    db.prepare(
      `DELETE FROM project_organization WHERE group_id IS NULL AND pinned_at IS NULL AND archived_at IS NULL AND removed_at IS NULL`,
    ).run();
  }
  return removed;
}

/** `ids` must name every group exactly once; returns false otherwise and changes nothing. */
export function reorderProjectGroups(db: SqliteDb, ids: readonly string[], now = Date.now()): boolean {
  const existing = readProjectOrganization(db).groups.map((group) => group.id);
  const requested = new Set(ids);
  if (requested.size !== ids.length || ids.length !== existing.length || !existing.every((id) => requested.has(id))) {
    return false;
  }
  const update = db.prepare(`UPDATE project_groups SET position = ?, updated_at = ? WHERE id = ?`);
  db.transaction(() => {
    ids.forEach((id, position) => update.run(position, now, id));
  })();
  return true;
}

/** Applies the omitted-means-unchanged patch. Throws ProjectArchivedError when pinning an archived project. */
export function updateProjectOrganization(
  db: SqliteDb,
  projectId: string,
  patch: UpdateProjectOrganizationRequest,
  now = Date.now(),
): ProjectOrganizationEntry {
  const existing = db
    .prepare(`SELECT ${ENTRY_COLUMNS} FROM project_organization WHERE project_id = ?`)
    .get(projectId) as ProjectOrganizationEntry | undefined;
  const archivedAt = patch.archived === undefined ? existing?.archivedAt ?? null : patch.archived ? existing?.archivedAt ?? now : null;
  if (archivedAt !== null && patch.pinned === true) throw new ProjectArchivedError(projectId);
  const pinnedAt =
    archivedAt !== null ? null : patch.pinned === undefined ? existing?.pinnedAt ?? null : patch.pinned ? existing?.pinnedAt ?? now : null;
  const groupId = patch.groupId === undefined ? existing?.groupId ?? null : patch.groupId;
  const removedAt = patch.removed === undefined ? existing?.removedAt ?? null : patch.removed ? now : null;
  const entry: ProjectOrganizationEntry = { projectId, groupId, pinnedAt, archivedAt, removedAt };

  if (groupId === null && pinnedAt === null && archivedAt === null && removedAt === null) {
    db.prepare(`DELETE FROM project_organization WHERE project_id = ?`).run(projectId);
    return entry;
  }
  db.prepare(
    `INSERT INTO project_organization (project_id, group_id, pinned_at, archived_at, removed_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       group_id = excluded.group_id, pinned_at = excluded.pinned_at, archived_at = excluded.archived_at, removed_at = excluded.removed_at`,
  ).run(projectId, groupId, pinnedAt, archivedAt, removedAt);
  return entry;
}
