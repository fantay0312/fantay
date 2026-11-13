// @vitest-environment node

// The fake TokenToSea cloud (`@/vitest/tokentosea-cloud`) is the hermetic
// stand-in every TokenToSea-backed collab e2e builds on. This file pins the
// properties those tests rely on:
//
// 1. Its OAuth/connect/design endpoints satisfy the real `TokenToSeaIdentity`
//    client: authorize -> code -> RS256 id_token -> userinfo, refresh rotation,
//    `fantay/identity`, apps/share collaboration, revoke.
// 2. The egress guard its `env()` installs refuses production TokenToSea hosts
//    in any process that loads it, while loopback traffic passes untouched.
// 3. `suite.with.tokenToSea` boots real tools-dev daemons signed in as two
//    distinct members through `OD_TOKENTOSEA_TEST_ORIGIN`, their collaboration
//    round trip (directory, invite, accept, roster, team catalog) lands on the
//    fake cloud, and nothing in the daemon leaves loopback.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, test } from 'vitest';

import { startTokenToSeaCloud, type TokenToSeaWorkspaceView } from '@/vitest/tokentosea-cloud';
import { createSmokeSuite } from '@/vitest/suite';
import { TokenToSeaIdentity } from '../../packages/tokentosea/src/index.ts';

/** What the packaged launcher passes the daemon (apps/packaged/src/workspace-team.ts). */
const PACKAGED_TRANSPORT_ENV = {
  OD_WORKSPACE_CONTEXT_SOURCE: 'tokentosea',
  OD_TEAM_PROJECTS_TRANSPORT: 'tokentosea',
  OD_COLLAB_TRANSPORT: 'tokentosea',
  OD_RESOURCE_TRANSPORT: 'tokentosea',
};

describe('fake TokenToSea cloud', () => {
  test(
    '[P1] satisfies the real TokenToSeaIdentity sign-in, refresh, verify and revoke contract',
    { timeout: 60_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({ members: [{ name: 'carol', displayName: 'Carol' }] });
      const dataDir = await mkdtemp(join(tmpdir(), 'tts-cloud-identity-'));
      let clock = Date.now();
      // A redirect URI that is never listened on: the test follows the code itself.
      const identity = new TokenToSeaIdentity({
        dataDir,
        endpoints: cloud.endpoints,
        redirectUri: 'http://127.0.0.1:9/callback',
        now: () => clock,
      });
      try {
        const raw = randomBytes(32).toString('base64url');
        const authorizeUrl = new URL(await identity.begin(raw));
        expect(`${authorizeUrl.origin}${authorizeUrl.pathname}`).toBe(`${cloud.issuer}/authorize`);

        const approved = await fetch(authorizeUrl, { redirect: 'manual' });
        expect(approved.status).toBe(302);
        const callback = new URL(approved.headers.get('location') ?? '');
        expect(`${callback.origin}${callback.pathname}`).toBe('http://127.0.0.1:9/callback');
        expect(callback.searchParams.get('iss')).toBe(cloud.issuer);
        await identity.complete(callback.searchParams);

        const carol = cloud.member('carol');
        expect(await identity.session(raw)).toMatchObject({ id: carol.userId, name: 'Carol', email: carol.email });
        expect(await identity.verifiedUser(raw)).toEqual({ id: carol.userId, name: 'Carol' });

        const directory = await identity.share(raw, 'collaboration', 'POST', { operation: 'workspace.list' });
        expect(directory.status).toBe(200);
        expect(((await directory.json()) as { workspaces: unknown[] }).workspaces).toEqual([
          expect.objectContaining({ workspaceType: 'personal', role: 'owner' }),
        ]);
        expect(await (await identity.service(raw, 'wallet', 'GET')).json()).toEqual(carol.wallet);

        // The identity caps access tokens at 15 minutes; past that it must rotate.
        clock += 16 * 60_000;
        expect(await identity.session(raw)).toMatchObject({ id: carol.userId });
        expect(cloud.requests({ area: 'oauth', resource: 'token' }).map((entry) => [entry.member, entry.status]))
          .toEqual([['carol', 200], ['carol', 200]]);

        await identity.logout(raw);
        expect(cloud.requests({ area: 'oauth', resource: 'revoke' }).map((entry) => [entry.member, entry.status]))
          .toEqual([['carol', 200]]);

        // apps/share sees the cloud's 401, not a generic 503, for a token it does not know.
        const anonymous = await fetch(`${cloud.endpoints.designBase}/collaboration`, {
          method: 'POST',
          headers: { authorization: 'Bearer tts_at_unknown', 'content-type': 'application/json' },
          body: JSON.stringify({ operation: 'workspace.list' }),
        });
        expect(anonymous.status).toBe(401);
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
      } finally {
        identity.close();
        await cloud.close();
        await rm(dataDir, { recursive: true, force: true });
      }
    },
  );

  test(
    '[P1] the egress guard refuses production TokenToSea hosts and leaves loopback alone',
    { timeout: 60_000 },
    async () => {
      const cloud = await startTokenToSeaCloud();
      try {
        const env: NodeJS.ProcessEnv = { ...process.env };
        for (const [key, value] of Object.entries(cloud.env())) {
          if (value === undefined) delete env[key];
          else env[key] = value;
        }
        const script = [
          "import https from 'node:https';",
          'const origin = process.env.OD_TOKENTOSEA_TEST_ORIGIN;',
          "const loopback = (await fetch(`${origin}/api/oauth/jwks`)).status;",
          "const viaFetch = await fetch('https://design.tokentosea.com/api/collaboration', { method: 'POST' }).then(() => 'reached', (error) => String(error.message));",
          "const viaHttps = await new Promise((resolve) => https.get('https://tokentosea.com/api/oauth/token', () => resolve('reached')).on('error', (error) => resolve(String(error.code))));",
          'console.log(JSON.stringify({ loopback, viaFetch, viaHttps }));',
        ].join('\n');
        const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env });
        expect(JSON.parse(stdout.trim().split('\n').at(-1) ?? '{}')).toEqual({
          loopback: 200,
          viaFetch: expect.stringContaining('blocked by the e2e TokenToSea egress guard'),
          viaHttps: 'ENOTFOUND',
        });
        expect((await cloud.egress.blocked()).map((entry) => [entry.via, entry.host]))
          .toEqual([['fetch', 'design.tokentosea.com'], ['dns', 'tokentosea.com']]);
        expect(await cloud.egress.external()).toEqual([]);
        expect(await cloud.egress.loaded()).not.toEqual([]);
        expect(cloud.requests({ area: 'oauth', resource: 'jwks' })).toHaveLength(1);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    '[P1] two seeded daemons collaborate through the fake cloud without leaving loopback',
    { timeout: 420_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'alice', displayName: 'Alice' }, { name: 'bob', displayName: 'Bob' }],
      });
      try {
        const alice = cloud.member('alice');
        const bob = cloud.member('bob');
        // Cloud-side state the daemons must discover, seeded before either starts.
        const team = await cloud.createTeamWorkspace('alice', 'Smoke Team');
        await cloud.publishTeamProject('alice', {
          workspaceId: team.workspaceId,
          projectId: 'smoke-project',
          name: 'Smoke project',
          files: { 'index.html': '<h1>Smoke</h1>' },
        });

        const ownerSuite = await createSmokeSuite('tokentosea-cloud-owner');
        const memberSuite = await createSmokeSuite('tokentosea-cloud-member');
        const views: { bob?: TokenToSeaWorkspaceView } = {};

        await ownerSuite.with.tokenToSea(cloud, 'alice', async (owner) => {
          expect(owner.session.userId).toBe(alice.userId);
          expect(await owner.requestJson('/api/tokentosea/status')).toMatchObject({
            signedIn: true,
            user: { id: alice.userId, name: 'Alice' },
          });
          // Connect services through the daemon's own routes.
          expect(await owner.requestJson('/api/tokentosea/cloud/wallet')).toMatchObject({
            status: 'available',
            balanceUsd: alice.wallet.availableUsd,
          });
          const models = await owner.requestJson<{ models: Array<{ id: string }> }>('/api/tokentosea/cloud/models');
          expect(models.models.map((model) => model.id)).toEqual(['e2e-chat']);

          // Directory: daemon -> design `workspace.list` as alice.
          const directory = await owner.requestJson<{
            items: Array<{ workspaceId: string; workspaceType: string; workspaceMemberId: string; role: string }>;
          }>('/api/workspace/directory');
          expect(directory.items).toEqual(expect.arrayContaining([
            expect.objectContaining({
              workspaceId: team.workspaceId,
              workspaceType: 'team',
              workspaceMemberId: team.workspaceMemberId,
              role: 'owner',
            }),
            expect.objectContaining({ workspaceType: 'personal' }),
          ]));

          // Invite: daemon -> design `invitation.create`.
          const invite = await owner.requestJson<{
            results: Array<{ email: string; ok: boolean; inviteId?: string; error?: string }>;
          }>('/api/workspace/invite', {
            headers: cloud.workspaceHeaders(team),
            body: { invites: [{ email: bob.email, role: 'member' }] },
          });
          expect(invite.results).toEqual([expect.objectContaining({ email: bob.email, ok: true })]);
          const nonce = invite.results[0]?.inviteId ?? '';
          expect(nonce).not.toBe('');

          // A second device, signed in as a second member, on its own data dir.
          await memberSuite.with.tokenToSea(cloud, 'bob', async (invitee) => {
            expect(invitee.session.cookie).not.toBe(owner.session.cookie);
            expect(await invitee.requestJson('/api/tokentosea/status')).toMatchObject({
              signedIn: true,
              user: { id: bob.userId, name: 'Bob' },
            });
            const accepted = await invitee.requestJson<{
              context: { workspaceId: string; workspaceType: string; workspaceMemberId: string; role: string };
              workspaceMemberId: string;
            }>('/api/workspace/invite/continue', { body: { nonce } });
            expect(accepted.context).toMatchObject({
              workspaceId: team.workspaceId,
              workspaceType: 'team',
              role: 'member',
            });
            const bobView = await cloud.workspace('bob', team.workspaceId);
            views.bob = bobView;
            expect(accepted.workspaceMemberId).toBe(bobView.workspaceMemberId);

            // Team catalog: daemon -> design `project.list` as bob sees alice's project.
            const catalog = await invitee.requestJson<{ projects: Array<{ projectId: string; ownerMemberId: string }> }>(
              '/api/workspace/projects/team',
              { headers: cloud.workspaceHeaders(bobView) },
            );
            expect(catalog.projects).toEqual([
              expect.objectContaining({ projectId: 'smoke-project', ownerMemberId: team.workspaceMemberId }),
            ]);
          }, { env: PACKAGED_TRANSPORT_ENV });

          // Roster: daemon -> design `member.list` as alice now includes bob.
          const roster = await owner.requestJson<{ members: Array<{ memberId: string; role: string }> }>(
            '/api/workspace/members',
            { headers: cloud.workspaceHeaders(team) },
          );
          expect(roster.members).toEqual(expect.arrayContaining([
            expect.objectContaining({ memberId: team.workspaceMemberId, role: 'owner' }),
            expect.objectContaining({ memberId: views.bob?.workspaceMemberId, role: 'member' }),
          ]));
        }, { env: PACKAGED_TRANSPORT_ENV });

        // Every hop above reached the fake cloud as the right member ...
        const daemonOperations = (member: string) => cloud
          .requests({ area: 'design', member, fromHarness: false })
          .map((entry) => entry.operation);
        expect(daemonOperations('alice')).toEqual(expect.arrayContaining(['workspace.list', 'invitation.create', 'member.list']));
        expect(daemonOperations('bob')).toEqual(expect.arrayContaining(['invitation.accept', 'workspace.get', 'project.list']));
        expect(cloud.requests({ area: 'connect', member: 'alice' }).map((entry) => entry.resource))
          .toEqual(expect.arrayContaining(['wallet', 'models']));
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
        // ... and nothing in either daemon went anywhere else.
        expect(await cloud.egress.blocked()).toEqual([]);
        expect(await cloud.egress.external('daemon')).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});
