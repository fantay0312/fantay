// @vitest-environment node

// P0 invariant: a project belongs to exactly one workspace, and a workspace
// project listing must never expose another workspace's local projects.
//
// This is intentionally an HTTP-level test rather than a planner/unit test.
// The bug class here is a cross-layer one: project creation writes the
// workspace_projects binding, while the listing route merges local rows with
// remote team rows and applies workspace/type filters. A correct individual
// function is not enough if the two layers disagree.
//
// The daemon is a real tools-dev runtime signed in to the hermetic TokenToSea
// cloud (`@/vitest/tokentosea-cloud`) with the packaged launcher's transport
// env. Its three memberships are real cloud rows: the member's personal
// workspace, a Team it owns, and a Team another account owns and invited it to.
// In this mode the local project data plane takes authority from the persisted
// binding and creator witness, so spoofed request state claims (removed,
// locked, no write capability) must not change any local outcome.

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { createFakeAgentRuntimes } from '@/fake-agents';
import {
  startTokenToSeaCloud,
  type TokenToSeaCloud,
  type TokenToSeaWorkspaceView,
} from '@/vitest/tokentosea-cloud';
import { createSmokeSuite, type TokenToSeaSuiteContext } from '@/vitest/suite';

/** What the packaged launcher passes the daemon (apps/packaged/src/workspace-team.ts). */
const PACKAGED_TRANSPORT_ENV = {
  OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea',
  OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea',
  OD_COLLAB_TRANSPORT: 'tokentosea',
  OD_RESOURCE_TRANSPORT: 'tokentosea',
};

type Workspace = Pick<TokenToSeaWorkspaceView, 'workspaceId' | 'workspaceType' | 'workspaceMemberId' | 'role'>;

type CreatedProject = {
  project: { id: string; name: string };
};

function workspaceHeaders(workspace: Workspace): Record<string, string> {
  return {
    'x-od-workspace-id': workspace.workspaceId,
    'x-od-workspace-type': workspace.workspaceType,
    'x-od-workspace-member-id': workspace.workspaceMemberId,
    'x-od-workspace-role': workspace.role,
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': workspace.workspaceType === 'team' ? 'true' : 'false',
    'x-od-workspace-can-write-synced-files': 'true',
  };
}

async function personalWorkspace(cloud: TokenToSeaCloud, member: string): Promise<TokenToSeaWorkspaceView> {
  const { workspaces } = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>(
    member,
    { operation: 'workspace.list' },
  );
  const personal = workspaces.find((workspace) => workspace.workspaceType === 'personal');
  if (!personal) throw new Error(`the fake cloud lists no personal workspace for ${member}`);
  return personal;
}

/** Personal, an owned Team A, and a Team B owned by `bob` that `alice` joined as a member. */
async function seedMemberships(cloud: TokenToSeaCloud): Promise<{
  personal: TokenToSeaWorkspaceView;
  teamA: TokenToSeaWorkspaceView;
  teamB: TokenToSeaWorkspaceView;
}> {
  const personal = await personalWorkspace(cloud, 'alice');
  const teamA = await cloud.createTeamWorkspace('alice', 'Isolation Team A');
  const teamBOwned = await cloud.createTeamWorkspace('bob', 'Isolation Team B');
  const teamB = await cloud.addWorkspaceMember('bob', teamBOwned.workspaceId, 'alice');
  expect(teamA.role).toBe('owner');
  expect(teamB.role).toBe('member');
  return { personal, teamA, teamB };
}

async function createProject(
  daemon: TokenToSeaSuiteContext,
  name: string,
  workspace: Workspace,
): Promise<CreatedProject['project']> {
  const created = await daemon.requestJson<CreatedProject>('/api/projects', {
    method: 'POST',
    headers: workspaceHeaders(workspace),
    body: {
      id: randomUUID(),
      name,
      designSystemId: null,
      skillId: null,
      metadata: { kind: 'prototype' },
      pendingPrompt: null,
    },
  });
  return created.project;
}

describe('workspace project isolation', () => {
  test(
    '[P0] project mutations cannot cross workspace bindings or trust spoofed authority claims',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
      });
      try {
        const { personal: PERSONAL, teamA: TEAM_A, teamB: TEAM_B } = await seedMemberships(cloud);
        const suite = await createSmokeSuite('collab-workspace-project-isolation');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          // The run gate below needs an agent; keep it hermetic.
          const fakeAgents = await createFakeAgentRuntimes({
            root: join(suite.scratchDir, 'fake-agents'),
            runtimeIds: ['claude'],
          });
          await daemon.requestJson('/api/app-config', {
            body: {
              agentCliEnv: { claude: fakeAgents.claude.env },
              agentId: 'claude',
              agentModels: { claude: { model: 'default', reasoning: 'default' } },
              claudeExecutionMode: 'print',
              designSystemId: null,
              onboardingCompleted: true,
              skillId: null,
              telemetry: { artifactManifest: true, content: false, metrics: false },
            },
            method: 'PUT',
          });

          // The signed-in session's cloud directory really lists all three
          // memberships, each with its own member id.
          const directory = await daemon.requestJson<{
            items: Array<{ workspaceId: string; workspaceMemberId: string; workspaceType: string; role: string }>;
          }>('/api/workspace/directory');
          for (const workspace of [PERSONAL, TEAM_A, TEAM_B]) {
            expect(directory.items).toContainEqual(expect.objectContaining({
              workspaceId: workspace.workspaceId,
              workspaceMemberId: workspace.workspaceMemberId,
              workspaceType: workspace.workspaceType,
              role: workspace.role,
            }));
          }

          const personalProject = await createProject(daemon, 'Personal draft', PERSONAL);
          const teamAProject = await createProject(daemon, 'Team A draft', TEAM_A);
          const teamBProject = await createProject(daemon, 'Team B draft', TEAM_B);

          // The persisted binding is the source of truth, not the workspace
          // currently selected by another request.
          await expectScope(daemon, personalProject.id, PERSONAL);
          await expectScope(daemon, teamAProject.id, TEAM_A);
          await expectScope(daemon, teamBProject.id, TEAM_B);

          const teamAList = await daemon.requestJson<{
            projects: Array<{ id: string }>;
          }>(`/api/workspaces/${TEAM_A.workspaceId}/projects?view=drafts`, {
            headers: workspaceHeaders(TEAM_A),
          });
          expect(teamAList.projects.map(({ id }) => id)).toContain(teamAProject.id);
          expect(teamAList.projects.map(({ id }) => id)).not.toContain(teamBProject.id);

          // The route workspace and the asserted membership form one exact
          // authority pair. A caller who belongs to both teams must not be able
          // to combine Team A's headers with Team B's URL and read Team B as if
          // the assertion had named it.
          const crossScopedList = await daemon.request(
            `/api/workspaces/${TEAM_B.workspaceId}/projects?view=drafts`,
            { headers: workspaceHeaders(TEAM_A) },
          );
          expect(crossScopedList.status).toBe(403);
          expect(await crossScopedList.json()).toMatchObject({
            error: { code: 'WORKSPACE_ACCESS_DENIED' },
          });

          const rename = async (projectId: string, workspace: Workspace, name: string) => {
            const response = await daemon.request(`/api/projects/${projectId}`, {
              method: 'PATCH',
              headers: { 'content-type': 'application/json', ...workspaceHeaders(workspace) },
              body: JSON.stringify({ name }),
            });
            await response.arrayBuffer();
            return response.status;
          };

          expect(await rename(teamAProject.id, TEAM_A, 'Team A renamed')).toBe(200);
          expect(
            await rename(teamAProject.id, TEAM_B, 'Cross-workspace overwrite'),
            'a member of another workspace must not mutate Team A project',
          ).not.toBe(200);
          expect(
            await rename(personalProject.id, TEAM_A, 'Team overwrites personal'),
            'a team request must not mutate a personal-workspace project',
          ).not.toBe(200);
          expect(
            await rename(teamBProject.id, PERSONAL, 'Personal overwrites Team B'),
            'a personal request must not mutate a Team B project',
          ).not.toBe(200);

          const renameWithState = async (
            stateHeaders: Record<string, string>,
            name: string,
          ) => {
            const response = await daemon.request(`/api/projects/${teamAProject.id}`, {
              method: 'PATCH',
              headers: {
                'content-type': 'application/json',
                ...workspaceHeaders(TEAM_A),
                ...stateHeaders,
              },
              body: JSON.stringify({ name }),
            });
            await response.arrayBuffer();
            return response.status;
          };
          expect(
            await renameWithState(
              { 'x-od-workspace-member-status': 'removed' },
              'Ignored status claim',
            ),
            'a spoofed removed claim must not override the persisted binding',
          ).toBe(200);
          expect(
            await renameWithState(
              { 'x-od-workspace-lifecycle-state': 'locked' },
              'Ignored lifecycle claim',
            ),
            'a spoofed locked claim must not override the persisted binding',
          ).toBe(200);
          expect(
            await renameWithState(
              { 'x-od-workspace-can-write-synced-files': 'false' },
              'Directory-authorized rename',
            ),
            'the daemon must not derive write authority from request claims',
          ).toBe(200);

          const createRun = async (
            headers?: Record<string, string>,
          ): Promise<number> => {
            const response = await daemon.request('/api/runs', {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...(headers ?? {}),
              },
              body: JSON.stringify({
                agentId: 'claude',
                message: 'Workspace-bound run gate',
                projectId: teamAProject.id,
              }),
            });
            await response.arrayBuffer();
            return response.status;
          };
          expect(await createRun(workspaceHeaders(TEAM_A))).toBe(202);
          expect(await createRun(workspaceHeaders(TEAM_B))).not.toBe(202);
          expect(
            await createRun({
              ...workspaceHeaders(TEAM_A),
              'x-od-workspace-member-status': 'removed',
            }),
          ).toBe(202);
          expect(
            await createRun({
              ...workspaceHeaders(TEAM_A),
              'x-od-workspace-lifecycle-state': 'locked',
            }),
          ).toBe(202);
          // Compatibility lane: an unscoped legacy client of the signed-in
          // account still reaches the project. Explicit Team B still cannot
          // cross into Team A above.
          expect(await createRun()).toBe(202);

          const teamA = await daemon.requestJson<CreatedProject>(
            `/api/projects/${teamAProject.id}`,
            { headers: workspaceHeaders(TEAM_A) },
          );
          expect(teamA.project.name).toBe('Directory-authorized rename');
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P0] a signed-out no-scope catalog does not expose bound workspace projects',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
      });
      try {
        const { personal: PERSONAL, teamA: TEAM_A } = await seedMemberships(cloud);
        const suite = await createSmokeSuite('collab-workspace-project-isolation-filters');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          await createProject(daemon, 'Bound personal project', PERSONAL);
          await createProject(daemon, 'Bound team project', TEAM_A);

          // No scope from a signed-in session ...
          const signedIn = await daemon.requestJson<{ projects: Array<{ name: string }> }>('/api/projects');
          expect(
            signedIn.projects,
            'the no-scope catalog must contain no project claimed by any workspace',
          ).toEqual([]);

          // ... and no scope from a client with no session at all. A cookie-less
          // Node request counts as the local od CLI and would act as Alice, so
          // send it the way a browser does (Fetch Metadata) to stay signed out.
          const signedOut = await fetch(new URL('/api/projects', `${daemon.daemonUrl}/`), {
            headers: { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
          });
          expect(signedOut.status).toBe(200);
          expect(
            ((await signedOut.json()) as { projects: unknown[] }).projects,
            'the signed-out no-scope catalog must contain no project claimed by any workspace',
          ).toEqual([]);
        }, { env: PACKAGED_TRANSPORT_ENV });
      } finally {
        await cloud.close();
      }
    },
  );
});

async function expectScope(
  daemon: TokenToSeaSuiteContext,
  projectId: string,
  workspace: Workspace,
): Promise<void> {
  const response = await daemon.requestJson<{
    scope: { kind: string; workspaceId: string | null; context: unknown };
  }>(`/api/projects/${projectId}/workspace-scope`, {
    headers: workspaceHeaders(workspace),
  });
  expect(response.scope.workspaceId).toBe(workspace.workspaceId);
  expect(response.scope.kind).toBe(workspace.workspaceType);
}
