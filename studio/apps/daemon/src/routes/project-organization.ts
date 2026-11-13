// SPDX-License-Identifier: AGPL-3.0-only
// HTTP surface of project groups, pins and archive; the sidebar and `od project` both go through here.
import type { Express, Response } from 'express';
import {
  PROJECT_GROUP_NAME_MAX_LENGTH,
  type ProjectGroupResponse,
  type ProjectOrganizationEntryResponse,
  type ProjectOrganizationResponse,
  type UpdateProjectOrganizationRequest,
} from '@open-design/contracts';

import { getProject, type SqliteDb } from '../db.js';
import { sendApiError } from '../http/api-errors.js';
import {
  createProjectGroup,
  deleteProjectGroup,
  getProjectGroup,
  ProjectArchivedError,
  readProjectOrganization,
  renameProjectGroup,
  reorderProjectGroups,
  updateProjectOrganization,
} from '../project-organization.js';

function groupNameFrom(body: unknown, res: Response): string | null {
  const raw = (body as { name?: unknown } | null | undefined)?.name;
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name || name.length > PROJECT_GROUP_NAME_MAX_LENGTH) {
    sendApiError(res, 400, 'BAD_REQUEST', `name must be 1-${PROJECT_GROUP_NAME_MAX_LENGTH} characters`);
    return null;
  }
  return name;
}

function organizationPatchFrom(body: unknown): UpdateProjectOrganizationRequest | null {
  const { pinned, archived, groupId, removed } = (body ?? {}) as Record<string, unknown>;
  const flagOk = (value: unknown) => value === undefined || typeof value === 'boolean';
  if (!flagOk(pinned) || !flagOk(archived) || !flagOk(removed)) return null;
  if (groupId !== undefined && groupId !== null && typeof groupId !== 'string') return null;
  if (pinned === undefined && archived === undefined && groupId === undefined && removed === undefined) return null;
  return {
    ...(pinned === undefined ? {} : { pinned: pinned as boolean }),
    ...(archived === undefined ? {} : { archived: archived as boolean }),
    ...(groupId === undefined ? {} : { groupId: groupId as string | null }),
    ...(removed === undefined ? {} : { removed: removed as boolean }),
  };
}

export function registerProjectOrganizationRoutes(app: Express, { db }: { db: SqliteDb }): void {
  app.get('/api/project-organization', (_req, res) => {
    const body: ProjectOrganizationResponse = readProjectOrganization(db);
    res.set('Cache-Control', 'no-store').json(body);
  });

  app.patch('/api/project-organization/projects/:id', (req, res) => {
    const projectId = String(req.params.id);
    const patch = organizationPatchFrom(req.body);
    if (!patch) {
      sendApiError(res, 400, 'BAD_REQUEST', 'expected pinned, archived or groupId');
      return;
    }
    if (!getProject(db, projectId)) {
      sendApiError(res, 404, 'PROJECT_NOT_FOUND', 'project not found');
      return;
    }
    if (patch.groupId && !getProjectGroup(db, patch.groupId)) {
      sendApiError(res, 404, 'NOT_FOUND', 'project group not found');
      return;
    }
    try {
      const body: ProjectOrganizationEntryResponse = { entry: updateProjectOrganization(db, projectId, patch) };
      res.json(body);
    } catch (error) {
      if (!(error instanceof ProjectArchivedError)) throw error;
      sendApiError(res, 409, 'CONFLICT', 'an archived project cannot be pinned; unarchive it first');
    }
  });

  app.post('/api/project-organization/groups', (req, res) => {
    const name = groupNameFrom(req.body, res);
    if (name === null) return;
    const body: ProjectGroupResponse = { group: createProjectGroup(db, name) };
    res.status(201).json(body);
  });

  // Registered before `/groups/:id`, which would otherwise read "order" as an id.
  app.put('/api/project-organization/groups/order', (req, res) => {
    const ids = (req.body as { ids?: unknown } | null | undefined)?.ids;
    const valid = Array.isArray(ids) && ids.every((id) => typeof id === 'string');
    if (!valid || !reorderProjectGroups(db, ids as string[])) {
      sendApiError(res, 400, 'BAD_REQUEST', 'ids must list every group exactly once');
      return;
    }
    const body: ProjectOrganizationResponse = readProjectOrganization(db);
    res.json(body);
  });

  app.patch('/api/project-organization/groups/:id', (req, res) => {
    const name = groupNameFrom(req.body, res);
    if (name === null) return;
    const group = renameProjectGroup(db, String(req.params.id), name);
    if (!group) {
      sendApiError(res, 404, 'NOT_FOUND', 'project group not found');
      return;
    }
    const body: ProjectGroupResponse = { group };
    res.json(body);
  });

  app.delete('/api/project-organization/groups/:id', (req, res) => {
    if (!deleteProjectGroup(db, String(req.params.id))) {
      sendApiError(res, 404, 'NOT_FOUND', 'project group not found');
      return;
    }
    res.status(204).end();
  });
}
