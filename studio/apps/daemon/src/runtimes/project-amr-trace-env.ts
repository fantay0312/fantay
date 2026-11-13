import { getWorkspaceProjectByProjectId } from '../db.js';

type SqliteDb = Parameters<typeof getWorkspaceProjectByProjectId>[0];

export type PinnedRunWorkspaceScope = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workspaceId: string;
  // Project writes are creator-gated. Freeze the same member for dynamic
  // library reads; older persisted Runs may not carry this field.
  workspaceMemberId?: string | null;
  source: 'persisted_project_binding';
}>;

/**
 * Written only by the retired AMR runtime for a signed-in run on an unbound
 * project. No new Run carries it, but Runs persisted before that retirement
 * may, so it stays in the union their state is read back as.
 */
export type AccountScopedRunWorkspaceScope = Readonly<{
  schemaVersion: 1;
  projectId: string;
  workspaceId: null;
  source: 'unbound_account';
}>;

export type RunWorkspaceScope =
  | PinnedRunWorkspaceScope
  | AccountScopedRunWorkspaceScope;

/**
 * Freeze the run's Workspace identity before a run is created.
 *
 * This is the only function in the run path that reads the mutable project
 * binding. Its result is stored on the run and reused for every attempt, so a
 * later rebind or UI Workspace switch never moves a run that already started.
 * Null means the project is unbound.
 */
export function pinRunWorkspaceScopeForProject(
  db: SqliteDb,
  projectId: string,
): PinnedRunWorkspaceScope | null {
  const normalizedProjectId = projectId.trim();
  if (!normalizedProjectId) return null;
  const binding = getWorkspaceProjectByProjectId(db, normalizedProjectId);
  const workspaceId =
    typeof binding?.workspaceId === 'string' && binding.workspaceId.trim()
      ? binding.workspaceId.trim()
      : null;
  if (!workspaceId) return null;
  return Object.freeze({
    schemaVersion: 1,
    projectId: normalizedProjectId,
    workspaceId,
    workspaceMemberId: binding?.createdByWorkspaceMemberId?.trim() || null,
    source: 'persisted_project_binding',
  });
}
