// @vitest-environment node

// Team shared-project catalog, driven through a real tools-dev daemon signed in
// to the hermetic TokenToSea cloud (`@/vitest/tokentosea-cloud`). The daemon
// user is always `bob`, an ordinary `member` of alice's team workspace; alice
// owns the workspace and seeds cloud-side state through the harness. Every
// catalog read and write the daemon makes lands on the cloud's apps/share
// collaboration service, so these cases pin the daemon's catalog policy against
// the service it talks to in production rather than against a scripted CLI.

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

type CatalogRow = {
  projectId: string;
  ownerMemberId: string;
  displayName?: string;
  visibility: string;
  syncState: string;
  publishedVersionId: string | null;
};

type CatalogFixture = {
  cloud: TokenToSeaCloud;
  /** alice's (owner) view of the team workspace. */
  team: TokenToSeaWorkspaceView;
  /** bob's (member) view of the same team workspace. */
  bobTeam: TokenToSeaWorkspaceView;
};

async function startCatalogCloud(): Promise<CatalogFixture> {
  const cloud = await startTokenToSeaCloud({
    members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
  });
  try {
    const team = await cloud.createTeamWorkspace('alice', 'Catalog team');
    const bobTeam = await cloud.addWorkspaceMember('alice', team.workspaceId, 'bob');
    expect(bobTeam).toMatchObject({ workspaceType: 'team', role: 'member' });
    return { cloud, team, bobTeam };
  } catch (error) {
    await cloud.close();
    throw error;
  }
}

/** The full request shape the desktop renderer sends for an active, unlocked workspace. */
function workspaceRequestHeaders(
  cloud: TokenToSeaCloud,
  view: TokenToSeaWorkspaceView,
  options: { canWriteSyncedFiles: boolean },
): Record<string, string> {
  return {
    ...cloud.workspaceHeaders(view),
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': String(options.canWriteSyncedFiles),
  };
}

async function teamCatalogAs(
  cloud: TokenToSeaCloud,
  member: string,
  workspaceId: string,
): Promise<CatalogRow[]> {
  const listed = await cloud.collaboration<{ projects: CatalogRow[] }>(member, {
    operation: 'project.list',
    workspaceId,
  });
  return listed.projects;
}

async function createLocalProject(
  daemon: TokenToSeaSuiteContext,
  headers: Record<string, string>,
  id: string,
  name: string,
): Promise<void> {
  const created = await daemon.requestJson<{ project: { id: string } }>('/api/projects', {
    headers,
    body: { id, name, designSystemId: null, skillId: null, metadata: { kind: 'prototype' }, pendingPrompt: null },
  });
  expect(created.project.id).toBe(id);
}

async function moveProject(
  daemon: TokenToSeaSuiteContext,
  headers: Record<string, string>,
  workspaceId: string,
  projectId: string,
  visibility: 'team' | 'personal',
): Promise<void> {
  const move = await daemon.request(`/api/workspaces/${workspaceId}/projects/${projectId}/move`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ visibility }),
  });
  const text = await move.text();
  expect(move.status, `move ${projectId} to ${visibility}: ${text.slice(0, 500)}`).toBe(200);
}

type CollabStatus = {
  awaitingFirstMaterialization?: boolean;
  materializedVersion?: number | null;
  ownerMemberId?: string | null;
};

/** Poll status until the placeholder holds `version`; fail with the last observed status. */
async function waitForMaterializedVersion(
  daemon: TokenToSeaSuiteContext,
  projectId: string,
  headers: Record<string, string>,
  version: number,
  reason: string,
): Promise<void> {
  let last: CollabStatus | null = null;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    last = await daemon.requestJson<CollabStatus>(`/api/projects/${projectId}/collab/status`, { headers });
    if (last.awaitingFirstMaterialization === false && last.materializedVersion === version) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${reason}; last status: ${JSON.stringify(last)}`);
}

describe('team shared-project catalog', () => {
  test(
    '[P1] reads the active team catalog through the workspace-scoped TokenToSea catalog and hides non-durable rows',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      try {
        await cloud.publishTeamProject('alice', {
          workspaceId: team.workspaceId,
          projectId: 'shared-project-1',
          name: 'Shared durable project',
          files: { 'index.html': '<!doctype html><h1>Shared</h1>' },
        });
        // A team row with no published version yet: the catalog knows it, nothing durable backs it.
        await cloud.collaboration('alice', {
          operation: 'project.upsert',
          workspaceId: team.workspaceId,
          projectId: 'shared-project-pending',
          name: 'Not durable yet',
          visibility: 'team',
        });
        // Precondition: the service itself hands bob both rows; hiding one is the daemon's policy.
        expect(await teamCatalogAs(cloud, 'bob', team.workspaceId)).toEqual(expect.arrayContaining([
          expect.objectContaining({ projectId: 'shared-project-1', syncState: 'synced' }),
          expect.objectContaining({ projectId: 'shared-project-pending', syncState: 'pending_upload', publishedVersionId: null }),
        ]));

        const suite = await createSmokeSuite('collab-team-project-catalog');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          const headers = workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: false });
          const context = await daemon.requestJson<{
            context: { workspaceId: string; workspaceType: string; workspaceMemberId: string } | null;
          }>('/api/workspace/context', { headers });
          expect(context.context).toMatchObject({
            workspaceId: team.workspaceId,
            workspaceType: 'team',
            workspaceMemberId: bobTeam.workspaceMemberId,
          });

          const catalog = await daemon.requestJson<{
            projects: Array<{ projectId: string; ownerMemberId: string; name?: string; sharedAt: string }>;
          }>('/api/workspace/projects/team', { headers });
          expect(catalog.projects).toHaveLength(1);
          expect(catalog.projects[0]).toMatchObject({
            projectId: 'shared-project-1',
            ownerMemberId: team.workspaceMemberId,
            name: 'Shared durable project',
          });
          expect(catalog.projects.map((project) => project.projectId)).not.toContain('shared-project-pending');
        }, { env: PACKAGED_TRANSPORT_ENV });

        // The catalog came from the cloud, read as bob, scoped to exactly the team workspace.
        const lists = cloud.requests({ area: 'design', operation: 'project.list', member: 'bob', fromHarness: false });
        expect(lists.length).toBeGreaterThan(0);
        expect(lists.map((entry) => entry.workspaceId)).toEqual(lists.map(() => team.workspaceId));
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] does not expose team shared projects while the active workspace is personal',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      try {
        await cloud.publishTeamProject('alice', {
          workspaceId: team.workspaceId,
          projectId: 'shared-project-1',
          name: 'Shared durable project',
          files: { 'index.html': '<!doctype html><h1>Shared</h1>' },
        });
        const directory = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>('bob', {
          operation: 'workspace.list',
        });
        const personal = directory.workspaces.find((workspace) => workspace.workspaceType === 'personal');
        if (!personal) throw new Error(`bob has no personal workspace: ${JSON.stringify(directory)}`);

        const suite = await createSmokeSuite('collab-personal-project-catalog');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          // Precondition: the same member does see the project from the team workspace.
          const teamCatalog = await daemon.requestJson<{ projects: Array<{ projectId: string }> }>(
            '/api/workspace/projects/team',
            { headers: workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: false }) },
          );
          expect(teamCatalog.projects.map((project) => project.projectId)).toEqual(['shared-project-1']);

          const headers = workspaceRequestHeaders(cloud, personal, { canWriteSyncedFiles: true });
          const context = await daemon.requestJson<{ context: { workspaceId: string; workspaceType: string } | null }>(
            '/api/workspace/context',
            { headers },
          );
          expect(context.context).toMatchObject({ workspaceId: personal.workspaceId, workspaceType: 'personal' });

          const catalog = await daemon.request('/api/workspace/projects/team', { headers });
          expect(catalog.status).toBe(403);
          expect(await catalog.json()).toMatchObject({ error: 'WORKSPACE_ACCESS_DENIED' });
        }, { env: PACKAGED_TRANSPORT_ENV });

        // The personal request never even asked the cloud for a catalog.
        expect(
          cloud.requests({ area: 'design', operation: 'project.list', member: 'bob', fromHarness: false })
            .filter((entry) => entry.workspaceId !== team.workspaceId),
        ).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] does not resurrect a locally unshared project when the team catalog remains stale',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      const projectId = 'stale-unshare-project';
      const bob = cloud.member('bob');
      try {
        const suite = await createSmokeSuite('collab-stale-unshare-catalog');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          const headers = workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: true });
          await createLocalProject(daemon, headers, projectId, 'Stale unshare project');

          await moveProject(daemon, headers, team.workspaceId, projectId, 'team');
          // What the catalog says while the project is shared: a durable team row owned by bob.
          let sharedRow: CatalogRow | undefined;
          await expect.poll(async () => {
            sharedRow = (await teamCatalogAs(cloud, 'alice', team.workspaceId))
              .find((row) => row.projectId === projectId);
            return sharedRow && { visibility: sharedRow.visibility, ownerMemberId: sharedRow.ownerMemberId, durable: sharedRow.publishedVersionId != null };
          }, { timeout: 30_000, message: 'the team share should publish a durable catalog row' }).toEqual({
            visibility: 'team',
            ownerMemberId: bobTeam.workspaceMemberId,
            durable: true,
          });

          await moveProject(daemon, headers, team.workspaceId, projectId, 'personal');
          // The unshare did reach the service ...
          expect(await teamCatalogAs(cloud, 'alice', team.workspaceId)).not.toEqual(
            expect.arrayContaining([expect.objectContaining({ projectId })]),
          );

          // ... but bob's catalog reads keep returning the shared row (a stale replica).
          let staleServed = 0;
          const releaseStale = cloud.handle('design', 'POST', 'collaboration', ({ body, member }) => {
            const request = body as { operation?: unknown; workspaceId?: unknown };
            if (member?.name !== 'bob' || request.operation !== 'project.list' || request.workspaceId !== team.workspaceId) {
              return undefined;
            }
            const live = cloud.share.collaboration.execute({ id: bob.userId, name: bob.displayName }, request) as {
              workspaceId: string;
              projects: CatalogRow[];
            };
            staleServed += 1;
            return {
              json: {
                ...live,
                projects: [...live.projects.filter((row) => row.projectId !== projectId), sharedRow],
              },
            };
          });
          try {
            const scope = await daemon.requestJson<{ scope: { workspaceId: string; visibility: string } }>(
              `/api/projects/${projectId}/workspace-scope`,
              { headers },
            );
            expect(scope.scope).toMatchObject({ workspaceId: team.workspaceId, visibility: 'personal' });

            // An explicit private policy outranks a stale Team directory row.
            // Both the all-project view and the Team-only view must preserve it.
            const all = await daemon.requestJson<{ projects: Array<{ id: string; visibility: string }> }>(
              `/api/workspaces/${team.workspaceId}/projects?view=all`,
              { headers },
            );
            expect(all.projects.filter((project) => project.id === projectId))
              .toEqual([expect.objectContaining({ id: projectId, visibility: 'personal' })]);
            const teamView = await daemon.requestJson<{ projects: Array<{ id: string }> }>(
              `/api/workspaces/${team.workspaceId}/projects?view=team`,
              { headers },
            );
            expect(teamView.projects.some((project) => project.id === projectId)).toBe(false);
            const after = await daemon.requestJson<{ scope: { visibility: string } }>(
              `/api/projects/${projectId}/workspace-scope`,
              { headers },
            );
            expect(after.scope.visibility).toBe('personal');
            // The member-facing Team catalog does not bring it back either.
            const catalog = await daemon.requestJson<{ projects: Array<{ projectId: string }> }>(
              '/api/workspace/projects/team',
              { headers },
            );
            expect(catalog.projects.some((project) => project.projectId === projectId)).toBe(false);
            expect(staleServed, 'the daemon must actually have read the stale catalog row').toBeGreaterThan(0);
          } finally {
            releaseStale();
          }
        }, { env: PACKAGED_TRANSPORT_ENV });
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] materializes a missing shared project on its first status read',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      const projectId = 'first-open-shared-project';
      try {
        const published = await cloud.publishTeamProject('alice', {
          workspaceId: team.workspaceId,
          projectId,
          name: 'First-open materialized project',
          files: {
            'index.html': '<!doctype html><html><body data-e2e="first-materialized">shared</body></html>',
            'open-design.json': JSON.stringify({ name: 'First-open materialized project', createdAt: 1, updatedAt: 2 }),
          },
        });

        const suite = await createSmokeSuite('collab-first-open-materialization');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          const headers = workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: false });
          const first = await daemon.requestJson<CollabStatus>(`/api/projects/${projectId}/collab/status`, { headers });
          expect(first.ownerMemberId).toBe(team.workspaceMemberId);
          expect(first.awaitingFirstMaterialization).toBe(true);

          await waitForMaterializedVersion(
            daemon,
            projectId,
            headers,
            published.version,
            'the first-open pull should materialize without a second open',
          );

          const files = await daemon.requestJson<{ files: Array<{ name: string }> }>(
            `/api/projects/${projectId}/files`,
            { headers },
          );
          expect(files.files.some((file) => file.name === 'index.html')).toBe(true);
          const html = await daemon.request(`/api/projects/${projectId}/raw/index.html`, { headers });
          expect(html.status).toBe(200);
          expect(await html.text()).toContain('data-e2e="first-materialized"');
        }, { env: PACKAGED_TRANSPORT_ENV });

        // The bytes came from alice's published version, pulled by bob's daemon.
        expect(cloud.requests({ area: 'design', operation: 'resource.pull', member: 'bob', fromHarness: false })
          .map((entry) => entry.status)).toContain(200);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] retries a transient first-open pull failure and materializes on a later status tick',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      const projectId = 'first-open-shared-project';
      try {
        const published = await cloud.publishTeamProject('alice', {
          workspaceId: team.workspaceId,
          projectId,
          name: 'First-open materialized project',
          files: {
            'index.html': '<!doctype html><html><body data-e2e="first-materialized">shared</body></html>',
            'open-design.json': JSON.stringify({ name: 'First-open materialized project', createdAt: 1, updatedAt: 2 }),
          },
        });
        // The first content pull bob's daemon makes fails as a transient upstream outage.
        let injectedFailures = 0;
        cloud.handle('design', 'POST', 'collaboration', ({ body, member }) => {
          if (member?.name !== 'bob' || (body as { operation?: unknown }).operation !== 'resource.pull') return undefined;
          if (injectedFailures > 0) return undefined;
          injectedFailures += 1;
          return { status: 503, json: { error: 'transient pull failure' } };
        });

        const suite = await createSmokeSuite('collab-first-open-pull-retry');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          const headers = workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: false });
          const first = await daemon.requestJson<CollabStatus>(`/api/projects/${projectId}/collab/status`, { headers });
          expect(first.awaitingFirstMaterialization).toBe(true);

          await waitForMaterializedVersion(
            daemon,
            projectId,
            headers,
            published.version,
            'a transient transport error must not strand the placeholder',
          );
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(injectedFailures, 'the transient failure must actually have been served').toBe(1);
        const pulls = cloud.requests({ area: 'design', operation: 'resource.pull', member: 'bob', fromHarness: false });
        expect(pulls[0]).toMatchObject({ handledBy: 'override', status: 503 });
        expect(pulls.slice(1).map((entry) => [entry.handledBy, entry.status])).toContainEqual(['share', 200]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] writes an owner rename through to the team catalog without requiring another file publish',
    { timeout: 300_000 },
    async () => {
      const { cloud, team, bobTeam } = await startCatalogCloud();
      const projectId = 'shared-project-rename-through';
      // Every catalog upsert bob's daemon sends, observed without changing the reply.
      const upserts: Array<{ projectId?: unknown; name?: unknown }> = [];
      cloud.handle('design', 'POST', 'collaboration', ({ body, member }) => {
        const request = body as { operation?: unknown; projectId?: unknown; name?: unknown };
        if (member?.name === 'bob' && request.operation === 'project.upsert') {
          upserts.push({ projectId: request.projectId, name: request.name });
        }
        return undefined;
      });
      const teamRow = async () => (await teamCatalogAs(cloud, 'alice', team.workspaceId))
        .find((row) => row.projectId === projectId);
      try {
        const suite = await createSmokeSuite('collab-team-project-rename-catalog');
        await suite.with.tokenToSea(cloud, 'bob', async (daemon) => {
          const headers = workspaceRequestHeaders(cloud, bobTeam, { canWriteSyncedFiles: true });
          await createLocalProject(daemon, headers, projectId, 'Before catalog rename');
          await moveProject(daemon, headers, team.workspaceId, projectId, 'team');

          await expect.poll(() => upserts.some((upsert) => upsert.projectId === projectId), {
            timeout: 30_000,
            message: 'sharing should upsert the project into the team catalog',
          }).toBe(true);
          let shared: CatalogRow | undefined;
          await expect.poll(async () => {
            shared = await teamRow();
            return shared && { displayName: shared.displayName, durable: shared.publishedVersionId != null };
          }, { timeout: 30_000, message: 'the share should land as a durable, named team row' })
            .toEqual({ displayName: 'Before catalog rename', durable: true });
          const publishedBeforeRename = shared?.publishedVersionId;
          upserts.length = 0;

          const rename = await daemon.request(`/api/projects/${projectId}`, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json', ...headers },
            body: JSON.stringify({ name: 'Renamed without a file edit' }),
          });
          expect(rename.status).toBe(200);

          await expect.poll(
            () => upserts.some((upsert) => upsert.projectId === projectId && upsert.name === 'Renamed without a file edit'),
            { timeout: 30_000, message: 'the rename should be written through as a catalog upsert' },
          ).toBe(true);
          // Members reading the team catalog see the new name on the same
          // published version: no new file publish was needed to carry it.
          await expect.poll(async () => {
            const row = await teamRow();
            return row && { displayName: row.displayName, publishedVersionId: row.publishedVersionId };
          }, { timeout: 30_000 }).toEqual({
            displayName: 'Renamed without a file edit',
            publishedVersionId: publishedBeforeRename,
          });
        }, { env: PACKAGED_TRANSPORT_ENV });
      } finally {
        await cloud.close();
      }
    },
  );
});
