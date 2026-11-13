import type { Server } from 'node:http';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

/**
 * Presence transport wiring at the real daemon HTTP boundary.
 *
 * Fantaydesign retired the Vela CLI collab transport: the daemon always
 * configures its TokenToSea runtime, and `shouldUseVelaCliCollabTransport`
 * treats that runtime as the collab transport. The legacy env switch
 * (`OD_COLLAB_TRANSPORT=off`) therefore no longer re-enables the process-local
 * presence fallback in the daemon, and no presence or team-project request ever
 * spawns a `vela` binary. The process-local fallback itself remains covered at
 * the route-module level (`collab-presence-routes.test.ts`, `cloud` absent).
 *
 * These tests pin that wiring in `server.ts`, which a route-module test cannot
 * see.
 */

type StartedServer = {
  url: string;
  server: Server;
  shutdown?: () => Promise<void> | void;
};
type ServerModule = {
  startServer: (options: {
    port: number;
    returnServer: boolean;
  }) => Promise<StartedServer>;
};

const MANAGED_ENV = [
  'OD_DATA_DIR',
  'OD_COLLAB_TRANSPORT',
  'OD_TEAM_PROJECTS_TRANSPORT',
  'OD_RESOURCE_TRANSPORT',
  'OD_WORKSPACE_CONTEXT_SOURCE',
  'OD_COLLAB_CLOUD_URL',
  'OD_DEV_WORKSPACE_CONTEXT',
  'VELA_BIN',
  'OD_TEST_TEAM_PROJECTS_JSON',
  'OD_TEST_CLOUD_VIEWERS_JSON',
  'OD_TEST_VELA_LOG',
] as const;

let started: StartedServer | null = null;
let scratch: string | null = null;
// `startServer` reads the transport env on every call, so one module instance
// serves every case. Re-importing it would re-register the prom-client metrics.
let serverModule: ServerModule | null = null;
const savedEnv = new Map<string, string | undefined>();

afterEach(async () => {
  await stopServer();
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = null;
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  savedEnv.clear();
}, 60_000);

const SHARED_PROJECT = 'presence-transport-off-shared';

describe('collab presence wiring with the TokenToSea collab transport', () => {
  it('keeps the TokenToSea presence relay wired when OD_COLLAB_TRANSPORT=off', async () => {
    // With a cloud transport wired, leave is gated on the verified workspace
    // member. A process-local fallback would have answered 200 for any member.
    setEnv({ OD_COLLAB_TRANSPORT: 'off' });
    const api = await startIsolatedServer();

    const left = await api.post(`/api/projects/any-local-project/presence/leave`, {
      memberId: 'm1',
    });

    expect(left.status).toBe(403);
    expect(left.body).toEqual({ error: 'WORKSPACE_PROJECT_PRESENCE_DENIED' });
  }, 60_000);

  it('never relays presence or the team-project catalog through the legacy Vela CLI', async () => {
    setEnv({
      OD_COLLAB_TRANSPORT: 'vela-cli',
      OD_TEAM_PROJECTS_TRANSPORT: 'vela-cli',
      OD_TEST_TEAM_PROJECTS_JSON: JSON.stringify({
        projects: [
          {
            projectId: SHARED_PROJECT,
            ownerMemberId: 'owner-1',
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      }),
      OD_TEST_CLOUD_VIEWERS_JSON: JSON.stringify([
        { memberId: 'cloud-member', displayName: 'Cloud Member', role: 'member' },
      ]),
    });
    await setupVelaStub();
    const api = await startIsolatedServer();

    // The isolated data root holds no TokenToSea session, so the project cannot
    // be verified as team-shared: neither the stub's cloud roster nor a
    // process-local roster is served.
    const list = await api.get(`/api/projects/${SHARED_PROJECT}/presence`);
    expect(list.status).toBe(200);
    expect(presentIds(list.body)).toEqual([]);

    const beat = await api.post(`/api/projects/${SHARED_PROJECT}/presence/heartbeat`, {
      memberId: 'local-member',
      name: 'Ada',
      role: 'owner',
    });
    expect(beat.status).toBe(200);
    expect(presentIds(beat.body)).toEqual([]);

    expect(await velaCalls()).toEqual([]);
  }, 60_000);
});

function presentIds(body: Record<string, any>): string[] {
  return ((body.present ?? []) as { memberId: string }[])
    .map((member) => member.memberId)
    .sort();
}

function setEnv(values: Record<string, string>): void {
  for (const key of MANAGED_ENV) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
  }
  // Start from a clean slate so an ambient transport/context in the developer's
  // shell cannot decide what this test exercises.
  for (const key of MANAGED_ENV) delete process.env[key];
  process.env.OD_DEV_WORKSPACE_CONTEXT = JSON.stringify(devWorkspaceContext());
  for (const [key, value] of Object.entries(values)) process.env[key] = value;
}

function devWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-transport-off',
    workspaceType: 'team',
    teamId: 'team-transport-off',
    workspaceMemberId: 'local-member',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({
      role: 'owner',
      lifecycleState: 'active',
    }),
  };
}

function devWorkspaceHeaders(): Record<string, string> {
  const context = devWorkspaceContext();
  return {
    'x-od-workspace-id': context.workspaceId,
    'x-od-workspace-type': context.workspaceType,
    'x-od-workspace-member-id': context.workspaceMemberId,
    'x-od-workspace-role': context.role,
    'x-od-workspace-member-status': context.memberStatus,
    'x-od-workspace-lifecycle-state': context.lifecycleState,
    'x-od-workspace-can-share-projects': String(
      context.permissions.canShareProjects,
    ),
    'x-od-workspace-can-write-synced-files': String(
      context.permissions.canWriteSyncedFiles,
    ),
  };
}

/**
 * A tripwire `vela` on the legacy resolution path (`VELA_BIN`). It answers like
 * a working Vela CLI (the project is shared, `cloud-member` is present), so any
 * regression that routes presence or the team-project catalog back through a
 * child process shows up both in the call log and in the served roster.
 */
async function setupVelaStub(): Promise<void> {
  const root = await ensureScratch();
  const script = join(root, 'vela-stub.mjs');
  await writeFile(
    script,
    `import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
if (process.env.OD_TEST_VELA_LOG) {
  appendFileSync(process.env.OD_TEST_VELA_LOG, args.join(' ') + '\\n');
}
const [group, ...rest] = args;
const out = (value) => {
  process.stdout.write(JSON.stringify(value));
  process.exit(0);
};
if (group === 'team-projects') {
  if (rest[0] === '--help') process.exit(0);
  const catalog = JSON.parse(process.env.OD_TEST_TEAM_PROJECTS_JSON || '{"projects":[]}');
  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  if (rest[0] === 'list') out({ projects });
  if (rest[0] === 'get') {
    const found = projects.find((project) => project.projectId === rest[1]);
    if (!found) {
      process.stderr.write('API request failed with status 404');
      process.exit(1);
    }
    out(found);
  }
  out({});
}
if (group === 'resource' && rest[0] === 'shared') {
  // Older CLI builds expose only the resource index; the catalog adapter
  // probes once per process, so answer both shapes for the same catalog.
  const catalog = JSON.parse(process.env.OD_TEST_TEAM_PROJECTS_JSON || '{"projects":[]}');
  const projects = Array.isArray(catalog.projects) ? catalog.projects : [];
  out({
    resources: projects.map((project) => ({
      id: 'project-' + project.projectId,
      teamId: 'team-transport-off',
      kind: 'project',
      ownerMemberId: project.ownerMemberId,
      createdAt: project.createdAt,
      metadata: { projectId: project.projectId },
      deletedAt: null,
    })),
  });
}
if (group === 'collab' && rest[0] === 'presence') {
  const viewers = JSON.parse(process.env.OD_TEST_CLOUD_VIEWERS_JSON || '[]');
  out({ viewers: rest[1] === 'leave' ? [] : viewers });
}
out({});
`,
    'utf8',
  );
  const bin = join(root, 'vela');
  await writeFile(bin, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"\n`, 'utf8');
  await chmod(bin, 0o755);
  process.env.VELA_BIN = bin;
  process.env.OD_TEST_VELA_LOG = join(root, 'vela-calls.log');
}

async function velaCalls(): Promise<string[]> {
  const log = process.env.OD_TEST_VELA_LOG;
  if (!log) return [];
  try {
    return (await readFile(log, 'utf8')).split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function ensureScratch(): Promise<string> {
  scratch ??= await mkdtemp(join(tmpdir(), 'od-presence-transport-off-'));
  return scratch;
}

async function startIsolatedServer(): Promise<{
  get(route: string): Promise<{ status: number; body: Record<string, any> }>;
  post(
    route: string,
    body: unknown,
  ): Promise<{ status: number; body: Record<string, any> }>;
}> {
  const root = await ensureScratch();
  process.env.OD_DATA_DIR = join(root, 'data');
  if (!serverModule) {
    vi.resetModules();
    serverModule = (await import('../src/server.js')) as unknown as ServerModule;
  }
  started = await serverModule.startServer({ port: 0, returnServer: true });
  const base = started.url;
  const read = async (response: Response) => ({
    status: response.status,
    body: (await response.json()) as Record<string, any>,
  });
  return {
    async get(route: string) {
      return read(
        await fetch(`${base}${route}`, {
          headers: devWorkspaceHeaders(),
        }),
      );
    },
    async post(route: string, body: unknown) {
      return read(
        await fetch(`${base}${route}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...devWorkspaceHeaders(),
          },
          body: JSON.stringify(body),
        }),
      );
    },
  };
}

async function stopServer(): Promise<void> {
  const current = started;
  started = null;
  if (!current) return;
  await withTimeout(Promise.resolve(current.shutdown?.()), 8_000);
  if (current.server) {
    current.server.closeAllConnections?.();
    current.server.closeIdleConnections?.();
    await withTimeout(
      new Promise<void>((resolve) => current.server.close(() => resolve())),
      8_000,
    );
  }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
