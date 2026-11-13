// @vitest-environment node

// Workspace resources have a separate persistence and transport path from
// projects. This E2E keeps the skill path load-bearing across the real daemon:
// import binds the resource, scoped catalogs cannot leak it, foreign mutations
// are denied, and team share/unshare stays pinned to the owning workspace.
//
// Every daemon is a real tools-dev runtime signed in to the hermetic TokenToSea
// cloud (`@/vitest/tokentosea-cloud`) with the packaged launcher's transport
// env. Team workspaces, memberships and the shared-resource hub are the
// cloud's apps/share collaboration rows; the resource transport is the
// daemon's TokenToSea `resource.*` operations, observed in the cloud's
// request log instead of a fake resource CLI.

import { describe, expect, test } from 'vitest';

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

function workspaceHeaders(workspace: Workspace): Record<string, string> {
  const manager = workspace.role === 'owner' || workspace.role === 'admin';
  return {
    'x-od-workspace-id': workspace.workspaceId,
    'x-od-workspace-type': workspace.workspaceType,
    'x-od-workspace-member-id': workspace.workspaceMemberId,
    'x-od-workspace-role': workspace.role,
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
    'x-od-workspace-can-manage-shared-resources': manager ? 'true' : 'false',
  };
}

async function responseStatus(
  daemon: TokenToSeaSuiteContext,
  path: string,
  init: RequestInit,
): Promise<number> {
  const response = await daemon.request(path, init);
  await response.arrayBuffer();
  return response.status;
}

type CollaborationCall = {
  member: string | null;
  operation: string;
  workspaceId: string | null;
  resourceId: string | null;
};

/** Record every daemon (non-harness) collaboration call body; falls through to apps/share. */
function observeCollaboration(cloud: TokenToSeaCloud): CollaborationCall[] {
  const calls: CollaborationCall[] = [];
  cloud.handle('design', 'POST', 'collaboration', ({ body, headers, member }) => {
    if (headers['x-e2e-tokentosea-harness'] === '1') return undefined;
    const value = (body ?? {}) as { operation?: unknown; workspaceId?: unknown; resourceId?: unknown };
    calls.push({
      member: member?.name ?? null,
      operation: typeof value.operation === 'string' ? value.operation : '',
      workspaceId: typeof value.workspaceId === 'string' ? value.workspaceId : null,
      resourceId: typeof value.resourceId === 'string' ? value.resourceId : null,
    });
    return undefined;
  });
  return calls;
}

describe('workspace-scoped skill resources', () => {
  test(
    '[P0] import, mutation, team share, and unshare stay inside the owning workspace',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
      });
      try {
        const TEAM_A = await cloud.createTeamWorkspace('alice', 'Skill Team A');
        const teamBOwned = await cloud.createTeamWorkspace('bob', 'Skill Team B');
        const TEAM_B = await cloud.addWorkspaceMember('bob', teamBOwned.workspaceId, 'alice');
        expect(TEAM_A.role).toBe('owner');
        expect(TEAM_B.role).toBe('member');
        const calls = observeCollaboration(cloud);
        const suite = await createSmokeSuite('collab-workspace-skill-resource-isolation');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          const context = await daemon.requestJson<{ context: { workspaceId: string } | null }>(
            '/api/workspace/context',
            { headers: workspaceHeaders(TEAM_A) },
          );
          expect(context.context?.workspaceId).toBe(TEAM_A.workspaceId);

          const imported = await daemon.requestJson<{ skill: { id: string; name: string } }>(
            '/api/skills/import',
            {
              method: 'POST',
              headers: workspaceHeaders(TEAM_A),
              body: {
                name: 'Workspace Guard Skill',
                description: 'Must stay in its owning workspace',
                body: 'Keep workspace resources isolated.',
                triggers: ['workspace guard'],
              },
            },
          );
          const skillId = imported.skill.id;

          const listIds = async (headers?: Record<string, string>) => {
            const response = await daemon.requestJson<{ skills: Array<{ id: string }> }>(
              '/api/skills',
              headers ? { headers } : undefined,
            );
            return response.skills.map((skill) => skill.id);
          };
          expect(await listIds(workspaceHeaders(TEAM_A))).toContain(skillId);
          expect(await listIds(workspaceHeaders(TEAM_B))).not.toContain(skillId);
          expect(await listIds()).not.toContain(skillId);

          expect(
            await responseStatus(daemon, `/api/skills/${encodeURIComponent(skillId)}`, {
              method: 'PUT',
              headers: {
                'content-type': 'application/json',
                ...workspaceHeaders(TEAM_B),
              },
              body: JSON.stringify({
                name: 'Cross workspace overwrite',
                description: 'must fail',
                body: 'must fail',
                triggers: [],
              }),
            }),
          ).toBe(404);
          expect(
            await responseStatus(daemon, `/api/skills/${encodeURIComponent(skillId)}`, {
              method: 'DELETE',
              headers: workspaceHeaders(TEAM_B),
            }),
          // Foreign Personal resources are deliberately undiscoverable. Both
          // read/update and delete must stop at scoped lookup with 404 rather
          // than disclose that another Workspace owns this id.
          ).toBe(404);
          // The refused foreign delete left the owner's skill in place.
          expect(await listIds(workspaceHeaders(TEAM_A))).toContain(skillId);

          const shared = await daemon.requestJson<{ shared: boolean; version?: number }>(
            `/api/workspace/skills/${encodeURIComponent(skillId)}/share`,
            {
              method: 'POST',
              headers: workspaceHeaders(TEAM_A),
            },
          );
          expect(shared).toEqual({ shared: true, version: 1 });

          const teamList = await daemon.requestJson<{
            ids: string[];
            resources: Array<{ id: string; canUnshare?: boolean }>;
          }>('/api/workspace/skills/team', {
            headers: workspaceHeaders(TEAM_A),
          });
          expect(teamList.ids).toEqual([skillId]);
          expect(teamList.resources).toEqual([
            expect.objectContaining({ id: skillId, canUnshare: true }),
          ]);

          const unshared = await daemon.requestJson<{ unshared: boolean }>(
            `/api/workspace/skills/${encodeURIComponent(skillId)}/share`,
            {
              method: 'DELETE',
              headers: workspaceHeaders(TEAM_A),
            },
          );
          expect(unshared.unshared).toBe(true);
          expect(
            await daemon.requestJson<{ ids: string[] }>('/api/workspace/skills/team', {
              headers: workspaceHeaders(TEAM_A),
            }),
          ).toEqual(expect.objectContaining({ ids: [] }));

          // Both hub mutations went to the owning Team as the signed-in member,
          // under the Team-scoped resource id.
          const mutations = calls.filter(({ operation }) =>
            operation === 'resource.push' || operation === 'resource.remove'
          );
          expect(mutations.map(({ operation, workspaceId, member }) => [operation, workspaceId, member])).toEqual([
            ['resource.push', TEAM_A.workspaceId, 'alice'],
            ['resource.remove', TEAM_A.workspaceId, 'alice'],
          ]);
          const hubSafeSkillId = skillId.replace(/[^a-zA-Z0-9_-]/g, '-');
          expect(mutations[0]?.resourceId).toBe(`skill-${TEAM_A.workspaceId}-${hubSafeSkillId}`);
          expect(mutations[1]?.resourceId).toBe(mutations[0]?.resourceId);
          expect(
            calls.filter(({ workspaceId }) => workspaceId === TEAM_B.workspaceId)
              .filter(({ operation }) => operation.startsWith('resource.') || operation.startsWith('project.')),
            'nothing about the skill may be written into the other Team',
          ).toEqual([]);
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P0] a second daemon observes an owner skill share and a fresh daemon sees its retraction',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
      });
      try {
        const TEAM_A = await cloud.createTeamWorkspace('alice', 'Skill relay team');
        // A distinct account that is a plain member of the same Team.
        const TEAM_A_MEMBER = await cloud.addWorkspaceMember('alice', TEAM_A.workspaceId, 'bob');
        expect(TEAM_A_MEMBER.role).toBe('member');
        expect(TEAM_A_MEMBER.workspaceMemberId).not.toBe(TEAM_A.workspaceMemberId);
        const ownerSuite = await createSmokeSuite('collab-skill-relay-owner');
        const memberSuite = await createSmokeSuite('collab-skill-relay-member');
        const reopenedMemberSuite = await createSmokeSuite('collab-skill-relay-member-reopened');

        await ownerSuite.with.tokenToSea(cloud, 'alice', async (owner) => {
          const imported = await owner.requestJson<{ skill: { id: string } }>(
            '/api/skills/import',
            {
              method: 'POST',
              headers: workspaceHeaders(TEAM_A),
              body: {
                name: 'Cross-daemon shared skill',
                description: 'Visible to a second member daemon',
                body: 'Keep the shared resource relay authoritative.',
                triggers: ['cross daemon resource'],
              },
            },
          );
          const skillId = imported.skill.id;
          await owner.requestJson(`/api/workspace/skills/${encodeURIComponent(skillId)}/share`, {
            method: 'POST',
            headers: workspaceHeaders(TEAM_A),
          });

          await memberSuite.with.tokenToSea(cloud, 'bob', async (member) => {
            await expect.poll(async () => {
              const team = await member.requestJson<{ ids: string[] }>(
                '/api/workspace/skills/team',
                { headers: workspaceHeaders(TEAM_A_MEMBER) },
              );
              return team.ids;
            }).toContain(skillId);
          }, { env: PACKAGED_TRANSPORT_ENV });

          await owner.requestJson(
            `/api/workspace/skills/${encodeURIComponent(skillId)}/share`,
            {
              method: 'DELETE',
              headers: workspaceHeaders(TEAM_A),
            },
          );

          await reopenedMemberSuite.with.tokenToSea(cloud, 'bob', async (member) => {
            const team = await member.requestJson<{ ids: string[] }>(
              '/api/workspace/skills/team',
              { headers: workspaceHeaders(TEAM_A_MEMBER) },
            );
            expect(team.ids).not.toContain(skillId);
          }, { env: PACKAGED_TRANSPORT_ENV });
        }, { env: PACKAGED_TRANSPORT_ENV });

        // The relay ran through the cloud as the two distinct accounts.
        const daemonOperations = (member: string) => cloud
          .requests({ area: 'design', member, fromHarness: false })
          .map((entry) => entry.operation);
        expect(daemonOperations('alice')).toEqual(expect.arrayContaining(['resource.push', 'resource.remove']));
        expect(daemonOperations('bob')).toContain('resource.list');
        expect(daemonOperations('bob')).not.toContain('resource.push');
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});
