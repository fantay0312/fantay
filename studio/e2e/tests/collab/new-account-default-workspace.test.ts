// @vitest-environment node

// A brand-new TokenToSea account signs in to a real tools-dev daemon backed by
// the fake TokenToSea cloud (`@/vitest/tokentosea-cloud`). TokenToSea creates
// the account's personal workspace lazily, named after the nickname, on the
// first collaboration call; the daemon must surface it as the only directory
// item without pinning a process-global active workspace, and the account
// wallet must read as zero.
//
// Ported from the Vela-era original, which faked B's `/api/v1/workspaces`
// and a `vela billing summary` binary. What changed with TokenToSea:
// - the default personal workspace is named after the nickname itself
//   (`Ada`), not `<nickname> workspace`;
// - TokenToSea marks it `billingState: 'free'` (planId null, personal BYOK)
//   where Vela's directory left `billingState` to the daemon default `active`;
// - account billing is the TokenToSea wallet: there is no membership tier and
//   no credit pools, so `membershipTier` is empty and the credit counters are 0.

import { describe, expect, test } from 'vitest';

import { startTokenToSeaCloud, type TokenToSeaWorkspaceView } from '@/vitest/tokentosea-cloud';
import { createSmokeSuite } from '@/vitest/suite';

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

type ContextBody = {
  context: {
    workspaceId: string;
    workspaceName?: string;
    workspaceType: string;
    workspaceMemberId: string;
    role: string;
    billingState: string;
    planId: string | null;
    providerMode: string;
  } | null;
};

describe('new account default workspace bootstrap', () => {
  test(
    'uses nickname workspace as the default personal free workspace with zero TokenToSea balance',
    { timeout: 240_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [{
          name: 'ada',
          displayName: 'Ada',
          wallet: { balanceUsd: '0.000000', availableUsd: '0.000000' },
        }],
      });
      try {
        const suite = await createSmokeSuite('collab-new-account-default-workspace');
        await suite.with.tokenToSea(cloud, 'ada', async (daemon) => {
          // The harness never seeded collaboration state for this account, so
          // the daemon's own directory read is what bootstraps the personal space.
          const directory = await daemon.requestJson<{
            activeWorkspaceId: string | null;
            items: DirectoryItem[];
          }>('/api/workspace/directory');
          const daemonDesignCalls = cloud.requests({ area: 'design', member: 'ada' });
          expect(daemonDesignCalls.every((entry) => !entry.fromHarness)).toBe(true);
          expect(daemonDesignCalls).toContainEqual(expect.objectContaining({
            operation: 'workspace.list',
            status: 200,
          }));

          // The cloud's own record of the account, read after the fact.
          const cloudWorkspaces = await cloud.collaboration<{ workspaces: TokenToSeaWorkspaceView[] }>(
            'ada',
            { operation: 'workspace.list' },
          );
          expect(cloudWorkspaces.workspaces).toHaveLength(1);
          const personal = cloudWorkspaces.workspaces[0]!;
          expect(personal).toMatchObject({ workspaceType: 'personal', workspaceName: 'Ada', role: 'owner' });

          expect(directory.activeWorkspaceId).toBeNull();
          expect(directory.items).toEqual([{
            workspaceId: personal.workspaceId,
            workspaceName: 'Ada',
            workspaceType: 'personal',
            workspaceMemberId: personal.workspaceMemberId,
            role: 'owner',
            memberStatus: 'active',
            lifecycleState: 'active',
          }]);
          const headers = cloud.workspaceHeaders(directory.items[0]!);

          // Fresh-account path: the explicit caller selects the personal
          // directory item without mutating a process-global active pointer.
          const firstContext = await daemon.requestJson<ContextBody>('/api/workspace/context', { headers });
          expect(firstContext.context?.workspaceId).toBe(personal.workspaceId);
          expect(firstContext.context?.workspaceName).toBe('Ada');
          expect(firstContext.context?.workspaceType).toBe('personal');
          const afterContext = await daemon.requestJson<{ activeWorkspaceId: string | null }>(
            '/api/workspace/directory',
          );
          expect(afterContext.activeWorkspaceId).toBeNull();

          // A second exact read remains on the same membership, now carrying
          // TokenToSea's free personal billing posture.
          const settledContext = await daemon.requestJson<ContextBody>('/api/workspace/context', { headers });
          expect(settledContext.context).toMatchObject({
            workspaceId: personal.workspaceId,
            workspaceMemberId: personal.workspaceMemberId,
            workspaceName: 'Ada',
            workspaceType: 'personal',
            role: 'owner',
            billingState: 'free',
            planId: null,
            providerMode: 'personal_byok',
          });

          const billing = await daemon.requestJson<{
            summary: {
              workspaceId: null;
              membershipTier: string;
              totalAvailableCredits: number;
              subscriptionCredits: number;
              rechargeCredits: number;
              balanceUsd: string;
            } | null;
            workspaceBalance: unknown;
          }>('/api/workspace/billing?scope=account');
          expect(billing.summary).toMatchObject({
            workspaceId: null,
            membershipTier: '',
            totalAvailableCredits: 0,
            subscriptionCredits: 0,
            rechargeCredits: 0,
            balanceUsd: '0.000000',
          });
          expect(billing.workspaceBalance).toBeNull();
          // The account menu's balance reads the same zero wallet.
          expect(await daemon.requestJson('/api/tokentosea/cloud/wallet')).toMatchObject({
            status: 'available',
            balanceUsd: '0.000000',
            source: 'tokentosea_api',
          });
          expect(cloud.requests({ area: 'connect', member: 'ada', resource: 'wallet' }).length).toBeGreaterThanOrEqual(2);
        }, { env: PACKAGED_TRANSPORT_ENV });

        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
        expect(await cloud.egress.external('daemon')).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});
