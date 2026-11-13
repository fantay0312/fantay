// @vitest-environment node
// OPEND-3493: page-check/SSE overwrite approval regression.
// Mock only the TokenToSea cloud, keep publication, event handling, authorized
// materialization and project reads on the real daemon HTTP paths.
//
// Three tools-dev daemons share one hermetic TokenToSea cloud
// (`@/vitest/tokentosea-cloud`): A and B are two devices signed in to the same
// owner account (separate data dirs, separate sessions), C is a member
// account. The cloud's apps/share collaboration service is the hub: daemons
// publish with `resource.push`, observe changes through `events.list`, and the
// test tells devices apart by the bearer token each one presents.
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  startTokenToSeaCloud,
  type TokenToSeaWorkspaceView,
} from '@/vitest/tokentosea-cloud';
import { createSmokeSuite, type TokenToSeaSuiteContext } from '@/vitest/suite';

type Status = { publishedVersion: number | null; materializedVersion: number | null; ownerMemberId: string | null; awaitingFirstMaterialization: boolean };
type Observed = { seq: number; token: string; member: string | null; operation: string; projectId?: string; resourceId?: string };
type CloudEvent = { seq: number; type: string; payload: Record<string, unknown> };

function headers(view: TokenToSeaWorkspaceView) {
  const owner = view.role === 'owner';
  return {
    'x-od-workspace-id': view.workspaceId, 'x-od-workspace-member-id': view.workspaceMemberId,
    'x-od-workspace-type': 'team', 'x-od-workspace-role': view.role,
    'x-od-workspace-member-status': 'active', 'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': owner ? 'true' : 'false',
    'x-od-workspace-can-write-synced-files': owner ? 'true' : 'false',
  };
}

test('OPEND-3493: a second owner device approves updates and continues publishing without an echo', { timeout: 360_000 }, async () => {
  const a = await createSmokeSuite('opend3493-shared-a');
  const b = await createSmokeSuite('opend3493-shared-b');
  const c = await createSmokeSuite('opend3493-shared-c');
  const cloud = await startTokenToSeaCloud({
    members: [{ name: 'owner', displayName: 'Mock owner' }, { name: 'member', displayName: 'Mock member' }],
  });
  // Every collaboration call the daemons make, keyed by the bearer token that
  // identifies the calling device. Observation only: the cloud still answers.
  const observed: Observed[] = [];
  cloud.handle('design', 'POST', 'collaboration', ({ member, headers: requestHeaders, body }) => {
    const input = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    if (requestHeaders['x-e2e-tokentosea-harness'] !== '1' && typeof input.operation === 'string') {
      observed.push({
        seq: observed.length,
        token: /^Bearer (\S+)$/i.exec(String(requestHeaders.authorization ?? ''))?.[1] ?? '',
        member: member?.name ?? null,
        operation: input.operation,
        ...(typeof input.projectId === 'string' ? { projectId: input.projectId } : {}),
        ...(typeof input.resourceId === 'string' ? { resourceId: input.resourceId } : {}),
      });
    }
    return undefined;
  });
  const OWNER = await cloud.createTeamWorkspace('owner', 'Serial device mock');
  const WORKSPACE = OWNER.workspaceId;
  const MEMBER = await cloud.addWorkspaceMember('owner', WORKSPACE, 'member', 'member');
  const env = (suite: typeof a) => ({ env: { AMR_HOME: join(suite.scratchDir, 'empty-amr-home') } });
  const id = randomUUID();
  const v1 = '<!doctype html><html><body>A published version one</body></html>';
  const v2 = '<!doctype html><html><body>A published version two</body></html>';
  const filePath = `/api/projects/${id}/raw/index.html`;
  const statusPath = `/api/projects/${id}/collab/status`;
  async function pin(daemon: TokenToSeaSuiteContext, view: TokenToSeaWorkspaceView) {
    await daemon.requestJson('/api/workspace/active', { method: 'PUT', body: { workspaceId: WORKSPACE, workspaceMemberId: view.workspaceMemberId } });
    await daemon.requestJson(`/api/workspace/billing?scope=workspace&workspaceId=${WORKSPACE}`, { headers: headers(view) });
  }
  async function upload(daemon: TokenToSeaSuiteContext, content: string) {
    const form = new FormData();
    form.set('file', new Blob([content], { type: 'text/html' }), 'index.html');
    const response = await daemon.request(`/api/projects/${id}/files`, { method: 'POST', headers: headers(OWNER), body: form });
    expect(response.status, await response.text()).toBe(200);
  }
  async function read(daemon: TokenToSeaSuiteContext, view: TokenToSeaWorkspaceView) {
    const response = await daemon.request(filePath, { headers: headers(view) });
    return { status: response.status, content: await response.text() };
  }
  async function seed(daemon: TokenToSeaSuiteContext, view: TokenToSeaWorkspaceView) {
    await pin(daemon, view);
    // Opening a missing shared project uses the real first-materialization
    // path, including for an owner on a fresh device. No local file seeding.
    await daemon.requestJson(statusPath, { headers: headers(view) });
    await expect.poll(async () => {
      const status = await daemon.requestJson<Status>(statusPath, { headers: headers(view) });
      return status.awaitingFirstMaterialization;
    }, { timeout: 30_000 }).toBe(false);
    await expect.poll(() => read(daemon, view), { timeout: 30_000 }).toEqual({ status: 200, content: v1 });
    return await daemon.requestJson<Status>(statusPath, { headers: headers(view) });
  }
  async function cloudEventsAfter(after: number) {
    return (await cloud.collaboration<{ events: CloudEvent[] }>('owner', { operation: 'events.list', workspaceId: WORKSPACE, after })).events;
  }
  async function cloudEventCursor() {
    return (await cloud.collaboration<{ cursor: number }>('owner', { operation: 'events.list', workspaceId: WORKSPACE, after: 0 })).cursor;
  }
  const pollers = (name: string) => new Set(observed.filter(entry => entry.member === name && entry.operation === 'events.list').map(entry => entry.token));
  try {
    await a.with.tokenToSea(cloud, 'owner', async (aDaemon) => {
      await pin(aDaemon, OWNER);
      await aDaemon.requestJson('/api/projects', { headers: headers(OWNER), body: { id, name: 'OPEND-3493 serial shared design', designSystemId: null, skillId: null, metadata: { kind: 'prototype' } } });
      await upload(aDaemon, v1);
      await aDaemon.requestJson(`/api/workspaces/${WORKSPACE}/projects/${id}/move`, { headers: headers(OWNER), body: { visibility: 'team' } });
      // The team catalog row in the cloud, written by device A as the owner.
      await expect.poll(async () => {
        const project = await cloud.collaboration<{ visibility: string; ownerMemberId: string }>('owner', { operation: 'project.get', workspaceId: WORKSPACE, projectId: id }).catch(() => null);
        return project && { visibility: project.visibility, ownerMemberId: project.ownerMemberId };
      }, { timeout: 30_000 }).toEqual({ visibility: 'team', ownerMemberId: OWNER.workspaceMemberId });
      expect(observed.some(entry => entry.token === aDaemon.session.accessToken && entry.operation === 'project.upsert' && entry.projectId === id)).toBe(true);
      await b.with.tokenToSea(cloud, 'owner', async (bDaemon) => {
        // Same account, a different device and session.
        expect(bDaemon.session.accessToken).not.toBe(aDaemon.session.accessToken);
        const bInitial = await seed(bDaemon, OWNER);
        expect(bInitial.ownerMemberId).toBe(OWNER.workspaceMemberId);
        // Actual bytes, not a status label, prove first materialization.
        await c.with.tokenToSea(cloud, 'member', async (cDaemon) => {
          await seed(cDaemon, MEMBER);
          await expect.poll(async () => (await cDaemon.requestJson<Status>(statusPath, { headers: headers(MEMBER) })).materializedVersion ?? 0, { timeout: 30_000 }).toBeGreaterThan(0);
          const initialVersion = Number((await cDaemon.requestJson<Status>(statusPath, { headers: headers(MEMBER) })).materializedVersion);
          // Both owner devices and the member device poll the workspace event stream.
          await expect.poll(() => [...pollers('owner')].filter(token => token === aDaemon.session.accessToken || token === bDaemon.session.accessToken).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
          await expect.poll(() => pollers('member').size, { timeout: 20_000 }).toBeGreaterThan(0);
          const checkpoint = await cloudEventCursor();
          await upload(aDaemon, v2);
          await aDaemon.requestJson(`/api/projects/${id}/collab/publish`, { headers: headers(OWNER), method: 'POST' });
          await expect.poll(async () => (await cloudEventsAfter(checkpoint)).some(event => event.type === 'resource.updated' && event.payload.projectId === id && Number(event.payload.version ?? 0) > initialVersion), { timeout: 30_000 }).toBe(true);
          // Control must actually receive v2 before judging the same-account B.
          await expect.poll(() => read(cDaemon, MEMBER), { timeout: 30_000 }).toEqual({ status: 200, content: v2 });
          type Update = { state: string; latestVersion: number; localVersion: number; promptSuppressedUntil: number | null };
          const updatePath = `/api/projects/${id}/collab/update`;
          async function action(input: Record<string, unknown>) {
            return (await bDaemon.requestJson<{ update: Update }>(updatePath, { headers: headers(OWNER), method: 'POST', body: input })).update;
          }
          // The event records an offer; neither the event nor an unapproved pull may overwrite.
          await expect.poll(async () => (await bDaemon.requestJson<{ ownedContentUpdate: Update }>(statusPath, { headers: headers(OWNER) })).ownedContentUpdate.state, { timeout: 20_000 }).toBe('confirmation_required');
          expect(await read(bDaemon, OWNER)).toEqual({ status: 200, content: v1 });
          const unapproved = await bDaemon.request(`/api/projects/${id}/collab/pull`, { method: 'POST', headers: headers(OWNER) });
          expect(unapproved.status).toBe(409);
          const denied = await cDaemon.request(updatePath, { method: 'POST', headers: { ...headers(MEMBER), 'content-type': 'application/json' }, body: JSON.stringify({ action: 'accept', version: initialVersion }) });
          expect(denied.status).toBe(403);
          const offered = await action({ action: 'check', manual: true });
          expect(await action({ action: 'dismiss', version: offered.latestVersion })).toMatchObject({ state: 'ignored' });
          expect((await action({ action: 'check' })).state).toBe('ignored');
          const reoffered = await action({ action: 'check', manual: true });
          const checkpointCommands = observed.length;
          const accepted = await action({ action: 'accept', version: reoffered.latestVersion, dontPromptFor24h: true });
          expect(accepted.state).toBe('up_to_date');
          expect(accepted.promptSuppressedUntil).toBeGreaterThan(Date.now());
          expect(await read(bDaemon, OWNER)).toEqual({ status: 200, content: v2 });
          const history = await bDaemon.requestJson<{ versions: Array<{ id: string; source: string; current: boolean }> }>(`/api/projects/${id}/files/index.html/versions`, { headers: headers(OWNER) });
          expect(history.versions.filter(v => v.source === 'sync').length).toBeGreaterThanOrEqual(2);
          const previous = history.versions.find(v => !v.current);
          expect(previous).toBeDefined();
          // Real child-process debounce cannot use this test process's fake clock.
          const observeUntil = Date.now() + 2_000;
          while (Date.now() < observeUntil) await bDaemon.requestJson(statusPath, { headers: headers(OWNER) });
          // Any owner-account push that device A did not make is B echoing the
          // accepted bytes back (a refreshed B token counts too).
          const pushedBy = (entry: Observed) => entry.operation === 'resource.push' && entry.member === 'owner' && entry.token !== aDaemon.session.accessToken;
          const echoed = observed.slice(checkpointCommands).filter(pushedBy);
          expect(echoed).toHaveLength(0);
          const v3 = '<!doctype html><html><body>B continues on this device</body></html>';
          const edits = observed.length;
          await upload(bDaemon, v3);
          await expect.poll(() => observed.slice(edits).some(entry => pushedBy(entry) && entry.token === bDaemon.session.accessToken), { timeout: 20_000 }).toBe(true);
          await expect.poll(() => read(cDaemon, MEMBER), { timeout: 20_000 }).toEqual({ status: 200, content: v3 });
          await bDaemon.requestJson(`/api/projects/${id}/files/index.html/versions/${previous!.id}/restore`, { method: 'POST', headers: headers(OWNER), body: {} });
          expect(await read(bDaemon, OWNER)).toEqual({ status: 200, content: v1 });
          await expect.poll(() => read(cDaemon, MEMBER), { timeout: 20_000 }).toEqual({ status: 200, content: v1 });
          // The member device never wrote project content to the cloud.
          expect(observed.filter(entry => entry.member === 'member' && entry.operation === 'resource.push')).toEqual([]);
          await b.report.json('owner-device-update.json', { offered, accepted, echoPushes: echoed.length, laterEditPublished: true, htmlHistoryRestored: true });
        }, env(c));
      }, env(b));
    }, env(a));
  } finally { await cloud.close(); }
});
