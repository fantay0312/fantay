// @vitest-environment node

// Billing preflight through a real tools-dev daemon signed in to the fake
// TokenToSea cloud (`@/vitest/tokentosea-cloud`).
//
// Ported from the Vela-era original, which fed `vela billing preflight`
// Coding Plan evidence through a fake CLI. TokenToSea has no Coding Plan and
// no preflight document; its funding evidence is the app grant
// (`connect/grant`), falling back to the account wallet (`connect/wallet`),
// which the daemon turns into the per-call cost ceiling (`maxCostUsd`) before
// any paid call. So this file pins two layers:
//
// 1. `GET /api/workspace/billing?includePreflight=1` keeps its exact-scope
//    authority: a held membership answers 200 for exactly that subject with no
//    preflight (TokenToSea supplies none, and the wallet document the billing
//    domain returns is not accepted as one), and any other workspace is 403.
//    The real `od workspace billing` CLI reaches the same route with its
//    workspace and model arguments intact (M06-06): it sends no cookie, and
//    the daemon runs a loopback request without browser headers as the one
//    signed-in TokenToSea account. When the cloud refuses the member's token
//    (401, 403 or revoked), the route fails closed with 401
//    `AMR_AUTH_REQUIRED` once its directory lease is dropped or lapses (at
//    most 15 s), and never answers 200 or "unavailable" after the cloud
//    refused a directory read (M07-08).
// 2. The funding preflight before a paid TokenToSea call, exercised through
//    the explicit connection test (`POST /api/test/connection`): exact
//    subject/model/ceiling on the paid call, corrupt or missing evidence and
//    an exhausted budget never reach a paid call, and 401/403 never degrade
//    into "unavailable"; concurrent subjects keep their own evidence.
//
// Not portable: Coding Plan windows (schema, reset dates, BigInt-lossless
// credit strings, empty-window rules).

import { execFile } from 'node:child_process';
import { createServer, request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import type { WorkspaceBillingResponse } from '@open-design/contracts';
import { expect, test } from 'vitest';

import {
  startTokenToSeaCloud,
  type TokenToSeaCloudReply,
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

const MODEL = {
  model: 'e2e/chat',
  provider: 'e2e',
  billingMode: 'token',
  toolCalling: true,
  available: true,
  maxOutputTokens: 4096,
};
const MODELS = [
  { ...MODEL, id: 'e2e-chat', name: 'E2E Chat', priceVersion: 1 },
  { ...MODEL, id: 'e2e-chat-b', model: 'e2e/chat-b', name: 'E2E Chat B', priceVersion: 7 },
];

type ConnectionResult = { ok: boolean; kind: string; model?: string; sample?: string; detail?: string };
type PaidCall = { member: string | null; model: unknown; priceVersion: unknown; maxCostUsd: unknown };

const odBin = fileURLToPath(new URL('../../../apps/daemon/bin/od.mjs', import.meta.url));
const execFileAsync = promisify(execFile);

/** What the billing route answers once the cloud refuses the member's token (directory `unauthorized`). */
const AUTH_REQUIRED = {
  error: { code: 'AMR_AUTH_REQUIRED', message: 'AMR authorization expired. Sign in again to continue.', retryable: false },
};

type WireRequest = { method: string; url: string; headers: IncomingHttpHeaders };

/**
 * A loopback forwarder in front of the daemon that records what a client put
 * on the wire. Headers pass through unchanged except Host, so the daemon sees
 * the client's own request.
 */
async function startWireRecorder(target: string) {
  const targetUrl = new URL(target);
  const requests: WireRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', headers: { ...req.headers } });
    const upstream = httpRequest({
      host: targetUrl.hostname,
      port: targetUrl.port,
      method: req.method,
      path: req.url,
      headers: { ...req.headers, host: targetUrl.host },
    }, (response) => {
      res.writeHead(response.statusCode ?? 502, response.headers);
      response.pipe(res);
    });
    upstream.once('error', (error) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`wire recorder could not reach the daemon: ${error.message}`);
    });
    req.pipe(upstream);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () => new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    }),
  };
}

test('[P0] scoped billing preflight stays exact-scope through real daemon HTTP and rejects corrupt or unauthorized funding evidence',
  { timeout: 300_000 }, async () => {
    const cloud = await startTokenToSeaCloud({
      members: [{ name: 'ada', displayName: 'Ada' }, { name: 'bo', displayName: 'Bo' }],
      models: MODELS,
    });
    const evidence: unknown[] = [];
    const paidCalls: PaidCall[] = [];
    let grantReply: TokenToSeaCloudReply | null = null;
    let holdGrant: { signal: () => void; release: Promise<void> } | null = null;
    const stopObservingPaidCalls = cloud.handle('connect', 'POST', 'chat/completions', ({ member, body }) => {
      const input = body as Record<string, unknown>;
      paidCalls.push({ member: member?.name ?? null, model: input.model, priceVersion: input.priceVersion, maxCostUsd: input.maxCostUsd });
      return undefined;
    });
    const stopGrantOverride = cloud.handle('connect', 'GET', 'grant', async ({ member }) => {
      if (member?.name !== 'ada') return undefined;
      if (holdGrant) {
        const held = holdGrant;
        held.signal();
        await held.release;
      }
      return grantReply ?? undefined;
    });
    // While set, the collaboration service refuses Ada's token on every
    // operation: the membership directory read and the events stream alike, as
    // a real token refusal would. (With a healthy events stream the daemon's
    // directory lease has no time limit, so refusing the directory read alone
    // would not model a refused token.)
    let collaborationRefusal: 401 | 403 | null = null;
    const stopCollaborationRefusal = cloud.handle('design', 'POST', 'collaboration', ({ member }) =>
      collaborationRefusal !== null && member?.name === 'ada'
        ? { status: collaborationRefusal, json: { error: collaborationRefusal === 401 ? 'TokenToSea 登录已失效，请重新登录' : 'forbidden' } }
        : undefined);
    try {
      const ada = cloud.member('ada');
      const bo = cloud.member('bo');
      const team = await cloud.createTeamWorkspace('ada', 'Preflight b');
      const { workspaces } = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>(
        'ada',
        { operation: 'workspace.list' },
      );
      const personal = workspaces.find((workspace) => workspace.workspaceType === 'personal')!;
      const suite = await createSmokeSuite('billing-preflight');
      // A second account signed in on the same daemon, for the concurrency case.
      const boSession = await cloud.seedSession(suite.dataDir, 'bo');

      await suite.with.tokenToSea(cloud, 'ada', async (daemon) => {
        async function read(scope: TokenToSeaWorkspaceView, modelId: string) {
          const query = new URLSearchParams({ scope: 'workspace', workspaceId: scope.workspaceId, includePreflight: '1', modelId });
          const response = await daemon.request(`/api/workspace/billing?${query}`, { headers: cloud.workspaceHeaders(scope) });
          return { status: response.status, body: await response.json() as WorkspaceBillingResponse };
        }

        for (const [scope, modelId] of [[personal, 'model-covered'], [team, 'model with spaces']] as const) {
          const result = await read(scope, modelId);
          expect(result.status, modelId).toBe(200);
          expect(result.body.preflight, modelId).toBeNull();
          expect(result.body.quotaRealtime, modelId).toEqual({ healthy: false });
          expect(result.body.workspaceBalance, modelId).toBeNull();
          expect(result.body.workspaceRuntime, modelId).toMatchObject({
            workspaceId: scope.workspaceId,
            workspaceMemberId: scope.workspaceMemberId,
          });
          expect(result.body.summary, modelId).toMatchObject({ workspaceId: null, balanceUsd: ada.wallet.balanceUsd });
          evidence.push({ case: `HTTP exact scope ${scope.workspaceType}`, modelId, ...result });
        }
        const foreign = await daemon.request('/api/workspace/billing?scope=workspace&workspaceId=ws-foreign&includePreflight=1', {
          headers: { 'x-od-workspace-id': 'ws-foreign', 'x-od-workspace-member-id': personal.workspaceMemberId },
        });
        expect(foreign.status).toBe(403);
        expect(await foreign.json()).toEqual({ error: 'workspace_not_authorized' });

        // M06-06: the real od CLI round trip. The CLI sends no cookie; the daemon
        // runs it as the one signed-in account (Ada, seen through the suite's
        // cookie status check — Bo has not used his cookie yet). TokenToSea
        // supplies no preflight that could echo the model back, so a forwarder
        // records the arguments the CLI put on the wire.
        const wire = await startWireRecorder(daemon.daemonUrl);
        let cliRun: { stdout: string; stderr: string };
        try {
          cliRun = await execFileAsync(process.execPath, [
            odBin, 'workspace', 'billing', '--workspace-type', 'team', '--workspace', team.workspaceId,
            '--model', 'model with spaces', '--json',
          ], { env: { ...process.env, OD_DAEMON_URL: wire.url } });
        } finally {
          await wire.close();
        }
        const cli = JSON.parse(cliRun.stdout) as WorkspaceBillingResponse;
        expect(cli.workspaceRuntime).toMatchObject({ workspaceId: team.workspaceId, workspaceMemberId: team.workspaceMemberId });
        expect(cli.preflight).toBeNull();
        expect(cli.workspaceBalance).toBeNull();
        expect(cli.summary).toMatchObject({ workspaceId: null, balanceUsd: ada.wallet.balanceUsd });
        expect(wire.requests.map(({ method, url }) => ({ method, path: new URL(url, 'http://cli.invalid').pathname })))
          .toEqual([{ method: 'GET', path: '/api/workspace/billing' }]);
        const sent = wire.requests[0]!;
        expect(Object.fromEntries(new URL(sent.url, 'http://cli.invalid').searchParams)).toEqual({
          scope: 'workspace', workspaceId: team.workspaceId, includePreflight: '1', modelId: 'model with spaces',
        });
        expect(sent.headers.cookie, 'the CLI identity must not come from a cookie').toBeUndefined();
        evidence.push({ case: 'M06-06 real od CLI argument preservation', request: { method: sent.method, url: sent.url }, body: cli });

        // M07-08: once the cloud refuses Ada's token, the scoped billing read
        // fails closed. The daemon may answer from its directory lease until it
        // consults the cloud again (a refused events poll drops the lease within
        // seconds; without a live stream it lapses after at most 15 s); from
        // the first refused directory read on, every answer is 401
        // AMR_AUTH_REQUIRED, never 200 and never "unavailable".
        const lastSeq = () => cloud.requests().at(-1)?.seq ?? 0;
        const refusedDirectoryReads = (since: number) => cloud.requests({
          area: 'design', resource: 'collaboration', operation: 'workspace.list', fromHarness: false,
        }).filter((entry) => entry.seq > since && (entry.status === 401 || entry.status === 403));
        async function expectBillingFailsClosed(name: string, since: number) {
          const answers: Array<{ status: number; refusedBefore: number }> = [];
          const deadline = Date.now() + 30_000;
          for (;;) {
            const refusedBefore = refusedDirectoryReads(since).length;
            const result = await read(personal, 'model-covered');
            answers.push({ status: result.status, refusedBefore });
            if (result.status !== 200) {
              expect(result, `${name}: ${JSON.stringify(answers)}`).toEqual({ status: 401, body: AUTH_REQUIRED });
              break;
            }
            expect(refusedBefore, `${name}: answered 200 after the cloud refused the token`).toBe(0);
            expect(result.body.workspaceRuntime, name).toMatchObject({
              workspaceId: personal.workspaceId,
              workspaceMemberId: personal.workspaceMemberId,
            });
            if (Date.now() >= deadline) {
              throw new Error(`${name}: still 200 after 30 s; the daemon never consulted the cloud's refusal: ${JSON.stringify(answers)}`);
            }
            await delay(500);
          }
          expect(refusedDirectoryReads(since).length, `${name}: the fail-closed answer must follow the cloud's refusal`).toBeGreaterThan(0);
          const again = await read(personal, 'model-covered');
          expect(again, `${name}: a refusal must not settle into another answer`).toEqual({ status: 401, body: AUTH_REQUIRED });
          evidence.push({ case: `M07-08 auth cannot degrade: ${name}`, answers, final: again });
        }
        for (const status of [401, 403] as const) {
          const since = lastSeq();
          collaborationRefusal = status;
          await expectBillingFailsClosed(`collaboration ${status}`, since);
        }
        collaborationRefusal = null;
        const restored = await read(personal, 'model-covered');
        expect(restored.status, 'an accepted token restores the scoped read').toBe(200);
        expect(restored.body.workspaceRuntime).toMatchObject({ workspaceId: personal.workspaceId });

        async function preflight(model: string, init: { cookie?: string } = {}): Promise<ConnectionResult> {
          const response = await daemon.request('/api/test/connection', {
            method: 'POST',
            headers: { 'content-type': 'application/json', ...(init.cookie ? { cookie: init.cookie } : {}) },
            body: JSON.stringify({ mode: 'agent', agentId: 'tokentosea', model }),
          });
          expect(response.status).toBe(200);
          const result = await response.json() as ConnectionResult;
          if (result.kind === 'agent_not_installed') {
            throw new Error('the tools-dev daemon has no bundled pi (FANTAY_PI_BIN), so the TokenToSea agent is not installed');
          }
          return result;
        }
        async function expectNoPaidCall(name: string, kind: string, detail?: string) {
          const before = paidCalls.length;
          const result = await preflight('e2e-chat');
          expect(result, name).toMatchObject({ ok: false, kind, ...(detail ? { detail } : {}) });
          expect(paidCalls.length, `${name} must not reach a paid call`).toBe(before);
          evidence.push({ case: name, result });
        }

        // Covered by the wallet (no app grant): exact subject, model and ceiling.
        const covered = await preflight('e2e-chat');
        expect(covered).toMatchObject({ ok: true, kind: 'success', model: 'e2e-chat', sample: 'ok' });
        expect(paidCalls.at(-1)).toEqual({ member: 'ada', model: 'e2e-chat', priceVersion: 1, maxCostUsd: '0.010000' });
        evidence.push({ case: 'wallet-funded exact subject/model', covered, paid: paidCalls.at(-1) });

        const otherModel = await preflight('e2e-chat-b');
        expect(otherModel).toMatchObject({ ok: true, model: 'e2e-chat-b' });
        expect(paidCalls.at(-1)).toEqual({ member: 'ada', model: 'e2e-chat-b', priceVersion: 7, maxCostUsd: '0.010000' });

        // An app grant below the call cap is the ceiling, and the wallet is not consulted.
        grantReply = { json: { perCallUsd: '0.004', remainingUsd: '1.5' } };
        const walletReadsBefore = cloud.requests({ area: 'connect', member: 'ada', resource: 'wallet' }).length;
        expect(await preflight('e2e-chat')).toMatchObject({ ok: true });
        expect(paidCalls.at(-1)).toMatchObject({ member: 'ada', maxCostUsd: '0.004000' });
        expect(cloud.requests({ area: 'connect', member: 'ada', resource: 'wallet' })).toHaveLength(walletReadsBefore);

        const corruptions: Array<[string, unknown]> = [
          ['negative-per-call', { perCallUsd: '-1', remainingUsd: null }],
          ['negative-remaining', { perCallUsd: null, remainingUsd: '-0.5' }],
          ['non-numeric', { perCallUsd: 'NaN', remainingUsd: null }],
          ['garbage', { perCallUsd: '0.01', remainingUsd: 'abc' }],
          ['infinite', { perCallUsd: 'Infinity', remainingUsd: null }],
          ['missing-fields', {}],
        ];
        for (const [name, grant] of corruptions) {
          grantReply = { json: grant };
          await expectNoPaidCall(`corrupt grant: ${name}`, 'upstream_unavailable');
        }
        // No app grant: the wallet is the only evidence, and it must be valid.
        grantReply = null;
        const wallet = { ...ada.wallet };
        ada.wallet = { ...wallet, availableUsd: 'NaN' };
        await expectNoPaidCall('corrupt wallet fallback', 'upstream_unavailable');
        const stopEmptyWallet = cloud.handle('connect', 'GET', 'wallet', ({ member }) =>
          member?.name === 'ada' ? { json: {} } : undefined);
        await expectNoPaidCall('wallet fallback without availableUsd', 'upstream_unavailable');
        stopEmptyWallet();
        ada.wallet = { ...wallet, availableUsd: '0.000000' };
        await expectNoPaidCall('exhausted wallet', 'forbidden', 'TokenToSea authorization budget is exhausted.');
        ada.wallet = wallet;
        grantReply = { json: { perCallUsd: null, remainingUsd: '0' } };
        await expectNoPaidCall('exhausted grant', 'forbidden', 'TokenToSea authorization budget is exhausted.');

        // Unavailable evidence stays "unavailable"; authorization failures never degrade into it.
        grantReply = { status: 503, json: { message: 'upstream temporarily unavailable' } };
        await expectNoPaidCall('grant unavailable', 'upstream_unavailable');
        grantReply = { status: 401, json: { message: 'TokenToSea 登录已失效，请重新登录' } };
        await expectNoPaidCall('grant 401', 'agent_auth_required');
        grantReply = { status: 403, json: { message: 'forbidden' } };
        const forbidden = await preflight('e2e-chat');
        expect(forbidden).toEqual(expect.objectContaining({ ok: false, kind: 'forbidden' }));
        expect(forbidden).not.toHaveProperty('detail');

        // Concurrent subjects remain independent: Ada's evidence is held while
        // Bo, signed in on the same daemon, completes with his own grant.
        grantReply = { json: { perCallUsd: '0.003', remainingUsd: null } };
        bo.grant = { perCallUsd: '0.007', remainingUsd: null };
        let releaseHeld!: () => void;
        const held = new Promise<void>((resolve) => {
          holdGrant = { signal: resolve, release: new Promise<void>((release) => { releaseHeld = release; }) };
        });
        const delayedAda = preflight('e2e-chat');
        await held;
        try {
          const currentBo = await preflight('e2e-chat-b', { cookie: boSession.cookieHeader });
          expect(currentBo).toMatchObject({ ok: true, model: 'e2e-chat-b' });
          expect(paidCalls.at(-1)).toEqual({ member: 'bo', model: 'e2e-chat-b', priceVersion: 7, maxCostUsd: '0.007000' });
        } finally {
          holdGrant = null;
          releaseHeld();
        }
        expect(await delayedAda).toMatchObject({ ok: true, model: 'e2e-chat' });
        expect(paidCalls.at(-1)).toEqual({ member: 'ada', model: 'e2e-chat', priceVersion: 1, maxCostUsd: '0.003000' });
        expect(await preflight('e2e-chat-b', { cookie: boSession.cookieHeader })).toMatchObject({ ok: true });
        expect(paidCalls.at(-1)).toMatchObject({ member: 'bo', maxCostUsd: '0.007000' });
        evidence.push({ case: 'concurrent subjects remain independent', paidCalls: paidCalls.slice(-3) });

        // A revoked TokenToSea authorization is an auth failure, not "unavailable".
        grantReply = null;
        const revokedSince = lastSeq();
        cloud.revokeTokens('ada');
        await expectNoPaidCall('revoked authorization', 'agent_auth_required');
        await expectBillingFailsClosed('revoked token', revokedSince);
        await suite.report.json('billing-preflight-evidence.json', evidence);
        await suite.report.json('tokentosea-paid-calls.json', paidCalls);
      }, { env: PACKAGED_TRANSPORT_ENV });
      console.log(`Billing preflight evidence: ${suite.report.root}`);

      expect(cloud.requests({ area: 'connect', resource: 'chat/completions' }).map((entry) => entry.member))
        .toEqual(paidCalls.map((call) => call.member));
      expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      expect(await cloud.egress.external('daemon')).toEqual([]);
    } finally {
      holdGrant = null;
      collaborationRefusal = null;
      stopCollaborationRefusal();
      stopGrantOverride();
      stopObservingPaidCalls();
      await cloud.close();
    }
  });
