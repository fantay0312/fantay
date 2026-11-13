// @vitest-environment node

// INVARIANT UNDER TEST: project creation uses an explicit Workspace/member pair
// only as durable local attribution. Mutable daemon current/default state is
// never an attribution source: a headerless legacy, CLI, plugin, or signed-out
// create remains unbound, while an explicitly scoped create is persisted under
// that exact Workspace without making the local write depend on remote
// membership.
//
// The daemon is a real tools-dev runtime signed in to the hermetic TokenToSea
// cloud (`@/vitest/tokentosea-cloud`) with the packaged launcher's transport
// env. Its membership directory is the cloud's `workspace.list`; the mutable
// "current Workspace" is the directory-validated selection a client persists
// through `PUT /api/workspace/active`; signing out is a real
// `POST /api/tokentosea/logout`. No dev context seam and no directory mock.

import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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

type ProjectWorkspaceScopeBody = {
  scope: {
    kind: 'unbound' | 'unavailable' | 'personal' | 'team';
    projectId: string;
    workspaceId: string | null;
    visibility?: 'personal' | 'team';
    context: { workspaceId: string; workspaceMemberId: string; workspaceType: string } | null;
  };
};

type CreatedProject = { conversationId: string; project: { id: string; name: string } };
type InstalledPlugins = { plugins: Array<{ id: string; title?: string }> };
type DirectoryBody = {
  items: Array<{ workspaceId: string; workspaceMemberId: string; workspaceType: string }>;
  activeWorkspaceId: string | null;
};

/** A complete pair the signed-in member has NO membership in. */
const FOREIGN = {
  workspaceId: 'ws-bind-foreign',
  workspaceMemberId: 'mem-bind-foreign',
  workspaceType: 'team' as const,
};

function workspaceHeaders(input: {
  workspaceId: string;
  workspaceMemberId: string;
  workspaceType: 'personal' | 'team';
  role?: string;
}): Record<string, string> {
  return {
    'x-od-workspace-id': input.workspaceId,
    'x-od-workspace-type': input.workspaceType,
    'x-od-workspace-member-id': input.workspaceMemberId,
    'x-od-workspace-role': input.role ?? 'owner',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-can-share-projects': 'true',
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

/** A request that carries no TokenToSea session cookie: the signed-out lane. */
function signedOutRequest(
  daemon: TokenToSeaSuiteContext,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(new URL(path, `${daemon.daemonUrl}/`), init);
}

async function signedOutJson<T>(
  daemon: TokenToSeaSuiteContext,
  path: string,
  body?: unknown,
): Promise<T> {
  const response = await signedOutRequest(daemon, path, body === undefined
    ? {}
    : { body: JSON.stringify(body), headers: { 'content-type': 'application/json' }, method: 'POST' });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status} ${path}: ${text.slice(0, 500)}`);
  return JSON.parse(text) as T;
}

async function readScope(
  daemon: TokenToSeaSuiteContext,
  projectId: string,
  headers?: Record<string, string>,
): Promise<ProjectWorkspaceScopeBody['scope']> {
  const body = await daemon.requestJson<ProjectWorkspaceScopeBody>(
    `/api/projects/${encodeURIComponent(projectId)}/workspace-scope`,
    headers ? { headers } : {},
  );
  return body.scope;
}

function projectBody(name: string) {
  return {
    designSystemId: null,
    id: randomUUID(),
    metadata: { kind: 'prototype' },
    name,
    pendingPrompt: null,
    skillId: null,
  };
}

async function createProject(
  daemon: TokenToSeaSuiteContext,
  name: string,
  headers?: Record<string, string>,
): Promise<string> {
  const created = await daemon.requestJson<CreatedProject>('/api/projects', {
    body: projectBody(name),
    method: 'POST',
    ...(headers ? { headers } : {}),
  });
  return created.project.id;
}

describe('a created project is bound only to an explicit Workspace', () => {
  test(
    'ambient state never claims headerless creates; explicit scope still binds exactly',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'alice', displayName: 'Alice' }] });
      try {
        const personal = await personalWorkspace(cloud, 'alice');
        const team = await cloud.createTeamWorkspace('alice', 'Bind team');
        const suite = await createSmokeSuite('collab-created-project-binding');

        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          // Put the daemon into "a signed-in Workspace is known": the
          // directory-validated selection every real client persists on a
          // left-rail switch, on top of the signed-in session's own directory.
          const switched = await daemon.requestJson<{ activeWorkspaceId: string }>('/api/workspace/active', {
            body: { workspaceId: personal.workspaceId, workspaceMemberId: personal.workspaceMemberId },
            method: 'PUT',
          });
          expect(switched.activeWorkspaceId).toBe(personal.workspaceId);
          const directory = await daemon.requestJson<DirectoryBody>('/api/workspace/directory');
          expect(directory.activeWorkspaceId, 'precondition: the daemon holds an ambient Workspace').toBe(
            personal.workspaceId,
          );
          expect(directory.items.map((item) => item.workspaceId)).toEqual(
            expect.arrayContaining([personal.workspaceId, team.workspaceId]),
          );

          // `od project create`, MCP, and other headerless legacy callers do
          // not inherit whichever Workspace the daemon most recently observed.
          const plainCreate = await createProject(daemon, 'Bind plain create');
          const plainScope = await readScope(daemon, plainCreate);
          expect(
            plainScope.kind,
            'a headerless create must not inherit daemon-global Workspace state',
          ).toBe('unbound');
          expect(plainScope.workspaceId).toBeNull();

          // --- SOURCE 2: folder import. Same shared helper, its own route.
          const importedDir = join(suite.scratchDir, 'imported-folder');
          await mkdir(importedDir, { recursive: true });
          const imported = await daemon.requestJson<CreatedProject>('/api/import/folder', {
            body: { baseDir: importedDir, name: 'Bind folder import' },
            method: 'POST',
          });
          const importedScope = await readScope(daemon, imported.project.id);
          expect(
            importedScope.kind,
            'a headerless folder import must not inherit daemon-global Workspace state',
          ).toBe('unbound');
          expect(importedScope.workspaceId).toBeNull();

          // --- SOURCE 3: plugin-created project. Uses whichever plugin the
          // daemon registered at startup, so it needs no fixture of its own.
          const installed = await daemon.requestJson<InstalledPlugins>('/api/plugins');
          expect(
            installed.plugins.length,
            'the daemon registers bundled plugins at startup',
          ).toBeGreaterThan(0);
          const fromPlugin = await duplicateFirstDuplicablePlugin(
            daemon,
            installed.plugins.map((plugin) => plugin.id),
          );
          const pluginScope = await readScope(daemon, fromPlugin.project.id);
          expect(
            pluginScope.kind,
            'a headerless plugin create must not inherit daemon-global Workspace state',
          ).toBe('unbound');
          expect(pluginScope.workspaceId).toBeNull();

          // An explicit identity is the only Workspace binding source, and it
          // outranks the ambient personal selection above.
          const teamHeaders = workspaceHeaders({
            workspaceId: team.workspaceId,
            workspaceMemberId: team.workspaceMemberId,
            workspaceType: 'team',
            role: team.role,
          });
          const explicit = await createProject(daemon, 'Bind explicit team', teamHeaders);
          const explicitScope = await readScope(daemon, explicit, teamHeaders);
          expect(explicitScope.workspaceId).toBe(team.workspaceId);
          expect(explicitScope.kind).toBe('team');

          // Signed-out remains the same legal unbound/local path: sign out for
          // real, then create the way a cookie-cleared client does.
          expect(await daemon.requestJson('/api/tokentosea/logout', { method: 'POST' })).toEqual({ ok: true });
          expect(await daemon.requestJson('/api/tokentosea/status')).toMatchObject({ signedIn: false });
          const signedOut = (await signedOutJson<CreatedProject>(
            daemon,
            '/api/projects',
            projectBody('Bind signed out'),
          )).project.id;
          const signedOutScope = (await signedOutJson<ProjectWorkspaceScopeBody>(
            daemon,
            `/api/projects/${encodeURIComponent(signedOut)}/workspace-scope`,
          )).scope;
          expect(signedOutScope.kind, 'signed out has no workspace to bind to').toBe('unbound');
          expect(signedOutScope.workspaceId).toBeNull();
          // Still a real, readable, usable project — not a blocked create.
          const readBack = await signedOutJson<{ project: { id: string; name: string } }>(
            daemon,
            `/api/projects/${encodeURIComponent(signedOut)}`,
          );
          expect(readBack.project.name).toBe('Bind signed out');
        }, { env: PACKAGED_TRANSPORT_ENV });

        // The ambient selection really was validated by the cloud directory,
        // and the sign-out really revoked the member's tokens there.
        expect(cloud.requests({ area: 'design', member: 'alice', fromHarness: false, operation: 'workspace.list' }))
          .not.toEqual([]);
        expect(cloud.requests({ area: 'oauth', resource: 'revoke' }).map((entry) => entry.member))
          .toContain('alice');
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});

describe('an asserted workspace identity is persisted as local attribution', () => {
  test(
    'a complete explicit pair is not blocked by the remote membership directory',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'alice', displayName: 'Alice' }] });
      try {
        await cloud.createTeamWorkspace('alice', 'Claim team');
        const suite = await createSmokeSuite('collab-created-project-unverified-claim');

        // The cloud directory deliberately does NOT list the asserted pair.
        // Local project creation/duplication must still use that complete pair
        // as a namespace and authorship witness without consulting remote
        // membership.
        await suite.with.tokenToSea(cloud, 'alice', async (daemon) => {
          const directory = await daemon.requestJson<DirectoryBody>('/api/workspace/directory');
          expect(directory.items.length, 'precondition: the signed-in directory is readable').toBeGreaterThan(0);
          expect(
            directory.items.map((item) => item.workspaceId),
            'precondition: the asserted pair is not a membership of the signed-in account',
          ).not.toContain(FOREIGN.workspaceId);

          const source = await createProject(daemon, 'Claim source');

          // Duplicate exercises both reconciliation of the existing unbound
          // source and attribution of the newly created copy.
          const response = await daemon.request(
            `/api/projects/${encodeURIComponent(source)}/duplicate`,
            {
              body: JSON.stringify({ name: 'Claim copy' }),
              headers: { 'content-type': 'application/json', ...workspaceHeaders(FOREIGN) },
              method: 'POST',
            },
          );
          expect(response.status).toBe(200);
          const copyId = ((await response.json()) as CreatedProject).project.id;

          const sourceScope = await readScope(daemon, source);
          expect(sourceScope.workspaceId).toBe(FOREIGN.workspaceId);
          expect(sourceScope.kind).toBe('team');

          const copyScope = await readScope(daemon, copyId);
          expect(copyScope.workspaceId).toBe(FOREIGN.workspaceId);
          expect(copyScope.kind).toBe('team');
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});

/**
 * Create a project from whichever bundled plugin the daemon can actually
 * duplicate. Not every plugin exposes a duplicable HTML preview
 * (`NO_DUPLICABLE_PREVIEW`), and which ones ship is a catalog detail this spec
 * has no business pinning — so try them in turn and report the refusals if none
 * works, rather than failing on an unrelated fixture change.
 */
async function duplicateFirstDuplicablePlugin(
  daemon: TokenToSeaSuiteContext,
  pluginIds: readonly string[],
): Promise<CreatedProject> {
  const refusals: string[] = [];
  for (const pluginId of pluginIds) {
    const response = await daemon.request(
      `/api/plugins/${encodeURIComponent(pluginId)}/duplicate-project`,
      {
        body: JSON.stringify({ name: `Bind plugin project ${pluginId}` }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      },
    );
    const text = await response.text();
    if (response.ok) return JSON.parse(text) as CreatedProject;
    refusals.push(`${pluginId}: ${response.status} ${text.slice(0, 120)}`);
  }
  throw new Error(
    `no bundled plugin could be duplicated into a project:\n${refusals.join('\n')}`,
  );
}
