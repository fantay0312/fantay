// @vitest-environment node

// Workspace switching and scoped billing through real tools-dev daemons signed
// in to the fake TokenToSea cloud (`@/vitest/tokentosea-cloud`).
//
// Ported from the Vela-era original (fake B directory + fake `vela billing`
// binary). TokenToSea billing is one account wallet, so:
// - `summary` is that wallet (account-scoped, `workspaceId: null`) for every
//   workspace read; TokenToSea has no per-workspace wallet and no plan
//   snapshot, so `workspaceBalance` stays null, no `workspaceSnapshot` is
//   returned, and the exact-scope runtime entry reports `status: 'error'`
//   instead of borrowing the account wallet as a workspace balance;
// - TokenToSea has no team-subscription checkout: the compatibility checkout
//   route stays Team-gated and answers `checkoutUrl: null` rather than a URL.
// The directory membership remains the authority for billing reads: a
// workspace the account does not hold is refused.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

type DirectoryItem = Pick<
  TokenToSeaWorkspaceView,
  'workspaceId' | 'workspaceName' | 'workspaceType' | 'workspaceMemberId' | 'role'
> & { memberStatus: string; lifecycleState: string };

type WorkspaceBilling = {
  summary: { workspaceId: null; balanceUsd: string } | null;
  workspaceBalance: unknown;
  workspaceSnapshot?: unknown;
  workspaceRuntime?: { workspaceId: string; workspaceMemberId: string; status: string };
};

async function directory(daemon: TokenToSeaSuiteContext) {
  return daemon.requestJson<{ activeWorkspaceId: string | null; items: DirectoryItem[] }>(
    '/api/workspace/directory',
  );
}

async function personalView(cloud: TokenToSeaCloud, member: string): Promise<TokenToSeaWorkspaceView> {
  const { workspaces } = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>(
    member,
    { operation: 'workspace.list' },
  );
  const personal = workspaces.find((workspace) => workspace.workspaceType === 'personal');
  if (!personal) throw new Error(`fake TokenToSea cloud has no personal workspace for ${member}`);
  return personal;
}

async function expectStatus(
  daemon: TokenToSeaSuiteContext,
  path: string,
  expected: number,
  init: RequestInit = {},
): Promise<Record<string, unknown>> {
  const response = await daemon.request(path, init);
  const body = (await response.json()) as Record<string, unknown>;
  expect(response.status, `${path} -> ${JSON.stringify(body)}`).toBe(expected);
  return body;
}

describe('workspace switching and scoped billing', () => {
  test(
    'switches the local workspace and never authorizes personal or foreign billing scopes',
    { timeout: 240_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{
          name: 'ada',
          displayName: 'Ada',
          wallet: { balanceUsd: '12.500000', availableUsd: '12.500000' },
        }],
      });
      try {
        const team = await cloud.createTeamWorkspace('ada', 'Ada team');
        const personal = await personalView(cloud, 'ada');
        const suite = await createSmokeSuite('collab-workspace-switch-and-billing');
        await suite.with.tokenToSea(cloud, 'ada', async (daemon) => {
          const initial = await daemon.requestJson<{ context: { workspaceId: string } | null }>(
            '/api/workspace/context',
            { headers: cloud.workspaceHeaders(personal) },
          );
          expect(initial.context?.workspaceId).toBe(personal.workspaceId);

          const switched = await daemon.requestJson<{
            activeWorkspaceId: string;
            context: { workspaceId: string; workspaceName?: string; workspaceType: string };
          }>('/api/workspace/active', {
            method: 'PUT',
            body: {
              workspaceId: team.workspaceId,
              workspaceMemberId: team.workspaceMemberId,
            },
          });
          expect(switched).toMatchObject({
            activeWorkspaceId: team.workspaceId,
            context: {
              workspaceId: team.workspaceId,
              workspaceName: 'Ada team',
              workspaceType: 'team',
            },
          });

          expect((await directory(daemon)).activeWorkspaceId).toBe(team.workspaceId);
          const selected = await daemon.requestJson<{
            context: { workspaceId: string; workspaceMemberId: string } | null;
          }>('/api/workspace/context', { headers: cloud.workspaceHeaders(team) });
          expect(selected.context).toMatchObject({
            workspaceId: team.workspaceId,
            workspaceMemberId: team.workspaceMemberId,
          });

          // Team billing: the account wallet, never re-labelled as a Team wallet.
          const billing = await daemon.requestJson<WorkspaceBilling>(
            `/api/workspace/billing?scope=workspace&workspaceId=${encodeURIComponent(team.workspaceId)}`,
            { headers: cloud.workspaceHeaders(team) },
          );
          expect(billing.summary?.workspaceId).toBeNull();
          expect(billing.summary?.balanceUsd).toBe('12.500000');
          expect(billing.workspaceBalance).toBeNull();
          expect(billing).not.toHaveProperty('workspaceSnapshot');
          expect(billing.workspaceRuntime).toMatchObject({
            workspaceId: team.workspaceId,
            workspaceMemberId: team.workspaceMemberId,
            status: 'error',
          });

          // No TokenToSea team-subscription checkout: no URL is fabricated, and
          // the route still refuses a Personal scope.
          const checkout = await daemon.requestJson<{ checkoutUrl: string | null }>(
            '/api/workspace/billing/checkout',
            {
              method: 'POST',
              headers: cloud.workspaceHeaders(team),
              body: { planId: 'team_pro', seats: 3 },
            },
          );
          expect(checkout).toEqual({ checkoutUrl: null });
          await expectStatus(daemon, '/api/workspace/billing/checkout', 403, {
            method: 'POST',
            headers: { ...cloud.workspaceHeaders(personal), 'content-type': 'application/json' },
            body: JSON.stringify({ planId: 'team_pro', seats: 3 }),
          });

          // Personal and Team balances both use an exact Workspace subject.
          // The directory membership is the authority; an unknown Workspace
          // must still fail closed below.
          const personalBilling = await daemon.requestJson<WorkspaceBilling>(
            `/api/workspace/billing?scope=workspace&workspaceId=${encodeURIComponent(personal.workspaceId)}`,
            { headers: cloud.workspaceHeaders(personal) },
          );
          expect(personalBilling.summary).toMatchObject({ workspaceId: null, balanceUsd: '12.500000' });
          expect(personalBilling.workspaceBalance).toBeNull();
          expect(personalBilling).not.toHaveProperty('workspaceSnapshot');
          expect(personalBilling.workspaceRuntime).toMatchObject({
            workspaceId: personal.workspaceId,
            workspaceMemberId: personal.workspaceMemberId,
          });
          expect(await expectStatus(
            daemon,
            '/api/workspace/billing?scope=workspace&workspaceId=ws-foreign',
            403,
            { headers: { 'x-od-workspace-id': 'ws-foreign', 'x-od-workspace-member-id': 'mem-foreign' } },
          )).toEqual({ error: 'workspace_not_authorized' });
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ area: 'connect', member: 'ada', resource: 'wallet' }).length).toBeGreaterThan(0);
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
        expect(await cloud.egress.external('daemon')).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );

  test(
    'rejects a removed Team request identity while Personal remains selectable',
    { timeout: 300_000 },
    async () => {
      // TokenToSea never removes a Team owner, so the removed identity is a
      // member's: Ada owns the Team, Bo is the member whose seat is revoked.
      const cloud = await startTokenToSeaCloud({
        members: [{ name: 'ada', displayName: 'Ada' }, { name: 'bo', displayName: 'Bo' }],
      });
      const externalRoot = await mkdtemp(join(tmpdir(), 'od-workspace-restart-e2e-'));
      const sharedDataDir = join(externalRoot, 'daemon-data');
      try {
        const team = await cloud.createTeamWorkspace('ada', 'Ada team');
        const boTeam = await cloud.addWorkspaceMember('ada', team.workspaceId, 'bo');
        const boPersonal = await personalView(cloud, 'bo');

        const first = await createSmokeSuite('collab-workspace-stale-pin-first', {
          dataDir: sharedDataDir,
        });
        await first.with.tokenToSea(cloud, 'bo', async (daemon) => {
          await daemon.requestJson('/api/workspace/active', {
            method: 'PUT',
            body: {
              workspaceId: boTeam.workspaceId,
              workspaceMemberId: boTeam.workspaceMemberId,
            },
          });
          expect((await directory(daemon)).activeWorkspaceId).toBe(boTeam.workspaceId);
        }, { env: PACKAGED_TRANSPORT_ENV });

        // Start a new daemon over the same persisted data after the Team
        // membership disappears. No in-memory directory lease survives this
        // boundary, so the stale restart default must be cleared.
        await cloud.collaboration('ada', {
          operation: 'member.remove',
          workspaceId: team.workspaceId,
          memberId: boTeam.workspaceMemberId,
        });
        const restarted = await createSmokeSuite('collab-workspace-stale-pin-restarted', {
          dataDir: sharedDataDir,
        });
        await restarted.with.tokenToSea(cloud, 'bo', async (daemon) => {
          const afterRemoval = await directory(daemon);
          expect(afterRemoval.activeWorkspaceId).toBeNull();
          expect(afterRemoval.items.map((item) => item.workspaceId)).toEqual([boPersonal.workspaceId]);

          // The removed Team identity can neither be re-selected nor billed.
          expect(await expectStatus(daemon, '/api/workspace/active', 404, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              workspaceId: boTeam.workspaceId,
              workspaceMemberId: boTeam.workspaceMemberId,
            }),
          })).toEqual({ error: 'workspace_not_visible' });
          await expectStatus(
            daemon,
            `/api/workspace/billing?scope=workspace&workspaceId=${encodeURIComponent(boTeam.workspaceId)}`,
            403,
            { headers: cloud.workspaceHeaders(boTeam) },
          );

          const recovered = await daemon.requestJson<{
            context: {
              workspaceId: string;
              workspaceName?: string;
              workspaceType: string;
            } | null;
          }>('/api/workspace/context', {
            headers: cloud.workspaceHeaders(boPersonal),
          });
          expect(recovered.context).toMatchObject({
            workspaceId: boPersonal.workspaceId,
            workspaceName: 'Bo',
            workspaceType: 'personal',
          });
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
        expect(await cloud.egress.external('daemon')).toEqual([]);
      } finally {
        await cloud.close();
        await rm(externalRoot, { force: true, recursive: true });
      }
    },
  );
});
