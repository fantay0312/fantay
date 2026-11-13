// @vitest-environment node

// P0: connect the packaged feature gate to a real daemon transaction. Unit
// tests already pin the emitted env byte-for-byte; this witness proves that the
// exact env can drive Personal/Team authority and that persisted project homes
// survive a complete daemon restart.
//
// The daemon is signed in to a TokenToSea account on the hermetic cloud
// (`@/vitest/tokentosea-cloud`). Its Personal workspace is the one apps/share
// provisions for every account and its Team workspace is created there before
// the daemon starts; each run reads both memberships from the cloud directory.
// Project creation persists the explicit Workspace/member pair as durable
// local attribution, so the lists and scopes after the restart come from the
// daemon data root, not from any remote or in-memory state.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

import { afterEach, describe, expect, test } from 'vitest';

import {
  startTokenToSeaCloud,
  type TokenToSeaCloud,
  type TokenToSeaWorkspaceView,
} from '@/vitest/tokentosea-cloud';
import { createSmokeSuite, type TokenToSeaSuiteContext } from '@/vitest/suite';

let cloud: TokenToSeaCloud | null = null;
let externalRoot: string | null = null;

afterEach(async () => {
  await cloud?.close();
  cloud = null;
  if (externalRoot) await rm(externalRoot, { force: true, recursive: true });
  externalRoot = null;
});

describe('packaged Workspace Team transaction', () => {
  test(
    '[P0] feature-test transport keeps Personal and Team project homes across a daemon restart',
    { timeout: 360_000 },
    async () => {
      externalRoot = await mkdtemp(join(tmpdir(), 'od-packaged-workspace-e2e-'));
      const sharedDataDir = join(externalRoot, 'persisted-daemon-data');
      const tts = await startTokenToSeaCloud({ members: [{ name: 'owner', displayName: 'Packaged Owner' }] });
      cloud = tts;
      const directory = await tts.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>('owner', {
        operation: 'workspace.list',
      });
      const personal = directory.workspaces.find((workspace) => workspace.workspaceType === 'personal');
      expect(personal).toMatchObject({ workspaceType: 'personal', role: 'owner' });
      const team = await tts.createTeamWorkspace('owner', 'Packaged Transaction Team');
      expect(team).toMatchObject({ workspaceType: 'team', role: 'owner' });
      // apps/packaged/tests/workspace-team.test.ts pins the feature gate that
      // emits this exact set. E2E consumes the public process environment,
      // keeping the guarded packaged leaf out of the broad test runtime.
      const packagedEnv = {
        OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea',
        OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea',
        OD_COLLAB_TRANSPORT: 'tokentosea',
        OD_RESOURCE_TRANSPORT: 'tokentosea',
      };
      expect(packagedEnv).toEqual({
        OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea',
        OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea',
        OD_COLLAB_TRANSPORT: 'tokentosea',
        OD_RESOURCE_TRANSPORT: 'tokentosea',
      });
      const runtimeEnv = {
        ...packagedEnv,
        AMR_HOME: join(externalRoot, 'empty-amr-home'),
      };
      const first = await createSmokeSuite('packaged-workspace-first', {
        dataDir: sharedDataDir,
      });
      let personalProjectId = '';
      let teamProjectId = '';

      await first.with.tokenToSea(
        tts,
        'owner',
        async (daemon) => {
          await expectDirectory(daemon, personal!, team);
          personalProjectId = await createProject(
            daemon,
            'Packaged Personal Project',
            workspaceHeaders(personal!),
          );
          teamProjectId = await createProject(
            daemon,
            'Packaged Team Project',
            workspaceHeaders(team),
          );
          await expectWorkspaceLists(daemon, personal!, team, personalProjectId, teamProjectId);
        },
        { env: runtimeEnv },
      );

      // A new namespace/process pair reopens the same packaged daemon data
      // root. No in-memory selection or cache survives this boundary.
      const restarted = await createSmokeSuite('packaged-workspace-restarted', {
        dataDir: sharedDataDir,
      });
      await restarted.with.tokenToSea(
        tts,
        'owner',
        async (daemon) => {
          await expectDirectory(daemon, personal!, team);
          await expectWorkspaceLists(daemon, personal!, team, personalProjectId, teamProjectId);
          const personalScope = await readScope(daemon, personalProjectId, workspaceHeaders(personal!));
          const teamScope = await readScope(daemon, teamProjectId, workspaceHeaders(team));
          expect(personalScope.scope).toMatchObject({
            kind: 'personal',
            workspaceId: personal!.workspaceId,
          });
          expect(teamScope.scope).toMatchObject({ kind: 'team', workspaceId: team.workspaceId });
        },
        { env: runtimeEnv },
      );
      // Both runs read the memberships from the cloud as this account.
      expect(tts.requests({ area: 'design', member: 'owner', operation: 'workspace.list', fromHarness: false }).length)
        .toBeGreaterThanOrEqual(2);
    },
  );
});

function workspaceHeaders(view: TokenToSeaWorkspaceView): Record<string, string> {
  return {
    'x-od-workspace-id': view.workspaceId,
    'x-od-workspace-member-id': view.workspaceMemberId,
    'x-od-workspace-type': view.workspaceType,
    'x-od-workspace-role': 'owner',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
    'x-od-workspace-can-manage-shared-resources': 'true',
  };
}

async function createProject(
  daemon: TokenToSeaSuiteContext,
  name: string,
  headers: Record<string, string>,
): Promise<string> {
  const created = await daemon.requestJson<{ project: { id: string } }>('/api/projects', {
    method: 'POST',
    headers,
    body: {
      designSystemId: null,
      id: randomUUID(),
      metadata: { kind: 'prototype' },
      name,
      pendingPrompt: null,
      skillId: null,
    },
  });
  return created.project.id;
}

/** The packaged runtime's Workspace authority is the signed-in account's cloud directory. */
async function expectDirectory(
  daemon: TokenToSeaSuiteContext,
  personal: TokenToSeaWorkspaceView,
  team: TokenToSeaWorkspaceView,
): Promise<void> {
  const directory = await daemon.requestJson<{
    items: Array<{ workspaceId: string; workspaceType: string; workspaceMemberId: string; role: string }>;
  }>('/api/workspace/directory');
  expect(directory.items).toEqual(expect.arrayContaining([
    expect.objectContaining({
      workspaceId: personal.workspaceId,
      workspaceType: 'personal',
      workspaceMemberId: personal.workspaceMemberId,
      role: 'owner',
    }),
    expect.objectContaining({
      workspaceId: team.workspaceId,
      workspaceType: 'team',
      workspaceMemberId: team.workspaceMemberId,
      role: 'owner',
    }),
  ]));
}

async function expectWorkspaceLists(
  daemon: TokenToSeaSuiteContext,
  personal: TokenToSeaWorkspaceView,
  team: TokenToSeaWorkspaceView,
  personalProjectId: string,
  teamProjectId: string,
): Promise<void> {
  const personalList = await daemon.requestJson<{ projects: Array<{ id: string }> }>(
    `/api/workspaces/${personal.workspaceId}/projects?view=drafts`,
    { headers: workspaceHeaders(personal) },
  );
  const teamList = await daemon.requestJson<{ projects: Array<{ id: string }> }>(
    `/api/workspaces/${team.workspaceId}/projects?view=drafts`,
    { headers: workspaceHeaders(team) },
  );
  expect(personalList.projects.map(({ id }) => id)).toContain(personalProjectId);
  expect(personalList.projects.map(({ id }) => id)).not.toContain(teamProjectId);
  expect(teamList.projects.map(({ id }) => id)).toContain(teamProjectId);
  expect(teamList.projects.map(({ id }) => id)).not.toContain(personalProjectId);
}

async function readScope(
  daemon: TokenToSeaSuiteContext,
  projectId: string,
  headers: Record<string, string>,
): Promise<{ scope: { kind: string; workspaceId: string | null } }> {
  return await daemon.requestJson(`/api/projects/${projectId}/workspace-scope`, { headers });
}
