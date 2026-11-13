import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  closeDatabase,
  ensureWorkspaceProject,
  insertProject,
  openDatabase,
} from '../../src/db.js';
import * as runWorkspaceScope from '../../src/runtimes/project-amr-trace-env.js';
import { pinRunWorkspaceScopeForProject } from '../../src/runtimes/project-amr-trace-env.js';

let tempDir: string | null = null;

afterEach(() => {
  closeDatabase();
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
  tempDir = null;
});

function projectDb(input: {
  projectId: string;
  workspaceId?: string;
  memberId?: string;
}) {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'od-run-workspace-scope-'));
  const db = openDatabase(tempDir);
  const now = Date.now();
  insertProject(db, {
    id: input.projectId,
    name: input.projectId,
    createdAt: now,
    updatedAt: now,
  });
  if (input.workspaceId) {
    ensureWorkspaceProject(db, {
      projectId: input.projectId,
      workspaceId: input.workspaceId,
      visibility: 'personal',
      createdByWorkspaceMemberId: input.memberId ?? null,
    });
  }
  return db;
}

describe('pinRunWorkspaceScopeForProject', () => {
  it('pins the creator member with the Workspace and does not follow later project rebinding', () => {
    const db = projectDb({
      projectId: 'project-a',
      workspaceId: 'workspace-a',
      memberId: 'member-a',
    });
    const scope = pinRunWorkspaceScopeForProject(db, 'project-a');
    db.prepare(`UPDATE workspace_projects
      SET workspace_id = ?, created_by_workspace_member_id = ?
      WHERE project_id = ?`).run('workspace-b', 'member-b', 'project-a');
    expect(scope).toMatchObject({
      workspaceId: 'workspace-a',
      workspaceMemberId: 'member-a',
    });
    expect(pinRunWorkspaceScopeForProject(db, 'project-a')).toMatchObject({
      workspaceId: 'workspace-b',
      workspaceMemberId: 'member-b',
    });
  });

  it('leaves an unbound project unscoped', () => {
    const db = projectDb({ projectId: 'project-unbound' });
    expect(pinRunWorkspaceScopeForProject(db, 'project-unbound')).toBeNull();
    expect(pinRunWorkspaceScopeForProject(db, '  ')).toBeNull();
  });

  it('no longer carries the retired AMR spawn trace environment', () => {
    // The AMR runtime read OPEN_DESIGN_WORKSPACE_ID and friends from this
    // module's spawn helper. Nothing live spawns it, so only the pin remains.
    expect(Object.keys(runWorkspaceScope).sort()).toEqual([
      'pinRunWorkspaceScopeForProject',
    ]);
  });
});
