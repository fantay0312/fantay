// @vitest-environment node

// `reconcileUnboundProjectBeforeMutation` (apps/daemon/src/routes/project/index.ts)
// may claim a project this daemon has never bound to ANY workspace into the
// current mutating request's workspace (recvqbhor3pai2, "复制的项目再次复制").
// The mutation gate now treats a resource no workspace has claimed the same
// whether the caller identifies itself or omits headers: it remains outside the
// workspace isolation regime. The reconciliation helper still owns the separate
// persistence decision described below.
//
// Workspace headers are not authentication credentials at this daemon-local
// boundary. A complete pair selects local namespace/authorship attribution; it
// does not synchronously consult the membership directory. The resolver
// therefore has two outcomes and no daemon-global fallback:
//
//   1. complete identity asserted -> claim that exact local scope
//   2. nothing asserted           -> write nothing
//
// Case 3 deliberately remains unbound. This helper runs immediately before
// `enforceWorkspaceResourceMutation`, whose HEADERLESS branch reads
// `getWorkspaceResourceByResourceId` and answers 401 WORKSPACE_CONTEXT_REQUIRED
// as soon as ANY row exists. Claiming on a headerless request would therefore
// turn today's working headerless duplicate into a 401 — a new failure on a path
// that works now. Pinned below.
//
// Assertions primarily target the persisted binding returned by
// `GET /api/projects/:id/workspace-scope` and prove that remote availability
// never changes the local attribution result.
//
// Every daemon is a real tools-dev runtime signed in to the hermetic TokenToSea
// cloud (`@/vitest/tokentosea-cloud`) with the packaged launcher's transport
// env. The membership authority is the cloud's `workspace.list` for that
// session — readable, or forced down through a cloud-side override — never a
// source-level backdoor.

import { randomUUID } from 'node:crypto';

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

type ProjectWorkspaceScope = {
  kind: 'unbound' | 'unavailable' | 'personal' | 'team';
  projectId: string;
  workspaceId: string | null;
  visibility?: 'personal' | 'team';
};

type CreatedProject = { conversationId: string; project: { id: string } };
type WorkspaceProjectsBody = {
  projects: Array<{ id: string; createdByWorkspaceMemberId: string | null }>;
};

/** A workspace/member pair the signed-in identity has NO membership in. */
const FOREIGN = {
  workspaceId: 'ws-rec-foreign',
  workspaceMemberId: 'mem-rec-foreign',
};

type Pair = { workspaceId: string; workspaceMemberId: string };

function workspaceHeaders(input: Pair & { workspaceType?: 'personal' | 'team' }): Record<string, string> {
  return {
    'x-od-workspace-id': input.workspaceId,
    'x-od-workspace-type': input.workspaceType ?? 'personal',
    'x-od-workspace-member-id': input.workspaceMemberId,
    'x-od-workspace-role': 'owner',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': 'true',
    'x-od-workspace-can-write-synced-files': 'true',
  };
}

/** The member's real personal workspace: an active membership the cloud directory lists. */
async function personalWorkspace(cloud: TokenToSeaCloud, member: string): Promise<TokenToSeaWorkspaceView> {
  const { workspaces } = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>(
    member,
    { operation: 'workspace.list' },
  );
  const personal = workspaces.find((workspace) => workspace.workspaceType === 'personal');
  if (!personal) throw new Error(`the fake cloud lists no personal workspace for ${member}`);
  return personal;
}

/** An unbound project: a headerless legacy create carries no durable scope. */
async function createUnboundProject(daemon: TokenToSeaSuiteContext, name: string): Promise<string> {
  const created = await daemon.requestJson<CreatedProject>('/api/projects', {
    body: {
      designSystemId: null,
      id: randomUUID(),
      metadata: { kind: 'prototype' },
      name,
      pendingPrompt: null,
      skillId: null,
    },
    method: 'POST',
  });
  return created.project.id;
}

async function readScope(
  daemon: TokenToSeaSuiteContext,
  projectId: string,
  headers?: Record<string, string>,
): Promise<ProjectWorkspaceScope> {
  const body = await daemon.requestJson<{ scope: ProjectWorkspaceScope }>(
    `/api/projects/${encodeURIComponent(projectId)}/workspace-scope`,
    headers ? { headers } : {},
  );
  return body.scope;
}

/**
 * Drive a mutation that runs `reconcileUnboundProjectBeforeMutation` on its
 * SOURCE project. Status-agnostic on purpose — see the file header.
 */
async function mutate(
  daemon: TokenToSeaSuiteContext,
  path: string,
  headers: Record<string, string> | undefined,
  body: unknown,
): Promise<number> {
  const response = await daemon.request(path, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    method: 'POST',
  });
  await response.arrayBuffer();
  return response.status;
}

const duplicatePath = (id: string) => `/api/projects/${encodeURIComponent(id)}/duplicate`;
const designSystemCopyPath = (id: string) =>
  `/api/projects/${encodeURIComponent(id)}/design-system-copy`;

describe('reconciling an unbound project uses explicit local attribution', () => {
  test(
    'a complete workspace/member pair becomes the claim through either entry point',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'alice', displayName: 'Alice' }] });
      try {
        const member = await personalWorkspace(cloud, 'alice');
        const suite = await createSmokeSuite('collab-reconcile-forged-claim');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          // The readable authority lists MEMBER and not FOREIGN.
          const directory = await daemon.requestJson<{ items: Pair[] }>('/api/workspace/directory');
          expect(directory.items).toEqual([
            expect.objectContaining({
              workspaceId: member.workspaceId,
              workspaceMemberId: member.workspaceMemberId,
            }),
          ]);

          // --- CASE 1: duplicate under an explicit local namespace.
          const viaDuplicate = await createUnboundProject(daemon, 'Reconcile via duplicate');
          expect(
            (await readScope(daemon, viaDuplicate)).kind,
            'precondition: the source project is a true orphan',
          ).toBe('unbound');

          expect(
            await mutate(daemon, duplicatePath(viaDuplicate), workspaceHeaders(FOREIGN), {
              name: 'Explicitly attributed duplicate',
            }),
            'local attribution must not depend on directory membership',
          ).toBe(200);

          const duplicateScope = await readScope(daemon, viaDuplicate);
          expect(duplicateScope.workspaceId).toBe(FOREIGN.workspaceId);
          expect(duplicateScope.kind).toBe('personal');

          // --- CASE 2: design-system copy, the other reachable entry point.
          const viaCopy = await createUnboundProject(daemon, 'Reconcile via ds copy');
          expect((await readScope(daemon, viaCopy)).kind).toBe('unbound');

          expect(
            await mutate(daemon, designSystemCopyPath(viaCopy), workspaceHeaders(FOREIGN), {
              name: 'Explicitly attributed copy',
            }),
          ).toBe(200);

          const copyScope = await readScope(daemon, viaCopy);
          expect(copyScope.workspaceId).toBe(FOREIGN.workspaceId);
          expect(copyScope.kind).toBe('personal');

          // --- CASE 3: a pair also present in the directory has identical local
          // attribution semantics.
          const legitimate = await createUnboundProject(daemon, 'Reconcile legitimate');
          expect((await readScope(daemon, legitimate)).kind).toBe('unbound');

          const status = await mutate(
            daemon,
            duplicatePath(legitimate),
            workspaceHeaders(member),
            { name: 'Legitimate duplicate' },
          );
          expect(status, 'a verified caller must not be refused').toBe(200);

          const legitimateScope = await readScope(daemon, legitimate, workspaceHeaders(member));
          expect(legitimateScope.kind).toBe('personal');
          expect(legitimateScope.workspaceId).toBe(member.workspaceId);

          // Authorship is persisted from the complete explicit pair.
          const listed = await daemon.requestJson<WorkspaceProjectsBody>(
            `/api/workspaces/${encodeURIComponent(member.workspaceId)}/projects`,
            { headers: workspaceHeaders(member) },
          );
          const claimed = listed.projects.find((project) => project.id === legitimate);
          expect(claimed?.createdByWorkspaceMemberId).toBe(member.workspaceMemberId);

          // --- CASE 4: a request that asserts NOTHING must leave the binding
          // alone, and must keep working. This helper's headerless branch is only
          // reachable where the daemon has no ambient workspace, because #6201's
          // create-side binding otherwise claims the project at creation — see
          // the separate finding in the PR body about headerless mutations of a
          // BOUND project.
          const headerless = await createUnboundProject(daemon, 'Reconcile headerless');
          expect((await readScope(daemon, headerless)).kind).toBe('unbound');

          const headerlessStatus = await mutate(
            daemon,
            duplicatePath(headerless),
            undefined,
            { name: 'Headerless duplicate' },
          );
          expect(headerlessStatus, 'a headerless duplicate of an orphan must keep working').toBe(200);
          expect(
            (await readScope(daemon, headerless)).kind,
            'nothing was asserted, so nothing may be claimed — a claim here would make the '
              + 'gate\'s headerless branch answer 401 on the next mutation',
          ).toBe('unbound');
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    'an explicit request scope outranks a validated navigation switch',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'alice', displayName: 'Alice' }] });
      try {
        const member = await personalWorkspace(cloud, 'alice');
        const suite = await createSmokeSuite('collab-reconcile-selection-isolation');

        // A left-rail switch validates a tab-local selection. It must not become
        // daemon-global project authority, even when a later request asserts a
        // different, unverifiable pair.
        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          const orphan = await createUnboundProject(daemon, 'Selection-isolated orphan');
          expect(
            (await readScope(daemon, orphan)).kind,
            'precondition: this must be a true orphan',
          ).toBe('unbound');

          const directoryReadsBefore = cloud.requests({
            area: 'design', member: 'alice', fromHarness: false, operation: 'workspace.list',
          }).length;
          const switched = await daemon.request('/api/workspace/active', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: member.workspaceId,
              workspaceMemberId: member.workspaceMemberId,
            }),
          });
          expect(switched.status).toBe(200);
          expect(((await switched.json()) as { activeWorkspaceId: string }).activeWorkspaceId)
            .toBe(member.workspaceId);
          // The switch was validated against the cloud directory, not trusted.
          const unlisted = await daemon.request('/api/workspace/active', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(FOREIGN),
          });
          expect(unlisted.status, 'an unlisted pair is not a valid switch target').toBe(404);
          expect(cloud.requests({
            area: 'design', member: 'alice', fromHarness: false, operation: 'workspace.list',
          }).length).toBeGreaterThan(directoryReadsBefore);

          // The next request explicitly attributes the orphan elsewhere.
          await mutate(daemon, duplicatePath(orphan), workspaceHeaders(FOREIGN), {
            name: 'Duplicate asserting an unverifiable pair',
          });

          const after = await readScope(daemon, orphan);
          expect(after.workspaceId).toBe(FOREIGN.workspaceId);
          expect(
            after.workspaceId,
            'nor may the tab selection be written onto a pre-existing orphan',
          ).not.toBe(member.workspaceId);
          expect(after.kind).toBe('personal');
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    'an unreadable membership authority does not block local attribution',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'alice', displayName: 'Alice' }] });
      try {
        // Resolve the pair while the authority is still readable; from here on
        // every client `workspace.list` the daemon sends fails upstream.
        const member = await personalWorkspace(cloud, 'alice');
        cloud.handle('design', 'POST', 'collaboration', ({ body, headers }) => {
          if (headers['x-e2e-tokentosea-harness'] === '1') return undefined;
          const operation = (body as { operation?: unknown } | undefined)?.operation;
          return operation === 'workspace.list'
            ? { status: 500, json: { error: 'authority down' } }
            : undefined;
        });
        const suite = await createSmokeSuite('collab-reconcile-authority-down');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          const directory = await daemon.request('/api/workspace/directory');
          expect(directory.status, 'precondition: the membership authority is unreadable').toBe(503);
          expect(await directory.json()).toMatchObject({ error: 'WORKSPACE_AUTHORITY_UNAVAILABLE' });

          const project = await createUnboundProject(daemon, 'Reconcile authority down');
          expect((await readScope(daemon, project)).kind).toBe('unbound');

          // The asserted pair is written locally even though the directory is
          // down; cloud operations will authorize separately when attempted.
          await mutate(daemon, duplicatePath(project), workspaceHeaders(member), {
            name: 'Duplicate during outage',
          });

          const scope = await readScope(daemon, project);
          expect(scope.workspaceId).toBe(member.workspaceId);
          expect(scope.kind).toBe('personal');
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({
          area: 'design', member: 'alice', fromHarness: false, operation: 'workspace.list', handledBy: 'override',
        })).not.toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});
