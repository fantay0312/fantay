// @vitest-environment node

// Workspace invite create (owner daemon) and continuation acceptance (a second,
// isolated invitee daemon/account) against the fake TokenToSea cloud
// (`@/vitest/tokentosea-cloud`), whose design service is the real apps/share
// collaboration store.
//
// Ported from the Vela-era original (fake B invite + continuation endpoints).
// What TokenToSea changes:
// - an invite is a bearer link token; the invitee e-mail never reaches the
//   cloud, so B's per-address `active_pending_invite` conflict cannot occur.
//   The per-row partial-failure contract is kept by having the cloud reject
//   one row, which the daemon reports as `invite_rejected`;
// - a continuation failure keeps the upstream HTTP status, but its error code
//   is always `continuation_unreachable` (Vela returned `continuation_<status>`);
// - "consumed" depends on the subject: a token another account consumed is
//   410, while the accepting account may replay its own token idempotently.

import { describe, expect, test } from 'vitest';

import { startTokenToSeaCloud, type TokenToSeaWorkspaceView } from '@/vitest/tokentosea-cloud';
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

type ContextBody = {
  context: {
    workspaceId: string;
    workspaceMemberId: string;
    role: string;
    workspaceName?: string;
    seatSummary?: { usedSeats: number };
  } | null;
};

async function directoryItems(daemon: TokenToSeaSuiteContext): Promise<DirectoryItem[]> {
  return (await daemon.requestJson<{ items: DirectoryItem[] }>('/api/workspace/directory')).items;
}

describe('workspace invite create and acceptance handoff', () => {
  test(
    '[P0] creates scoped invites and accepts the continuation in an isolated invitee daemon',
    { timeout: 300_000 },
    async () => {
      const cloud = await startTokenToSeaCloud({
        members: [
          { name: 'owner', displayName: 'Owner' },
          { name: 'invitee', displayName: 'Invitee' },
          { name: 'other', displayName: 'Other' },
        ],
      });
      try {
        const team = await cloud.createTeamWorkspace('owner', 'Invited team');
        const ownerSuite = await createSmokeSuite('collab-workspace-invite-owner');
        const inviteeSuite = await createSmokeSuite('collab-workspace-invite-invitee');

        await ownerSuite.with.tokenToSea(cloud, 'owner', async (owner) => {
          const initialOwnerContext = await owner.requestJson<ContextBody>('/api/workspace/context', {
            headers: cloud.workspaceHeaders(team),
          });
          expect(initialOwnerContext.context).toMatchObject({
            workspaceId: team.workspaceId,
            workspaceMemberId: team.workspaceMemberId,
            role: 'owner',
            workspaceName: 'Invited team',
          });

          // Record every invitation.create body the daemon sends, and have the
          // cloud reject the batch's second row so the daemon must report a
          // typed per-row failure without aborting the rest of the batch.
          const sentInvites: Array<{ workspaceId?: unknown; role?: unknown; body: Record<string, unknown> }> = [];
          const stopObserving = cloud.handle('design', 'POST', 'collaboration', ({ body, member }) => {
            const payload = body as Record<string, unknown>;
            if (payload.operation !== 'invitation.create' || member?.name !== 'owner') return undefined;
            sentInvites.push({ workspaceId: payload.workspaceId, role: payload.role, body: payload });
            if (sentInvites.length === 2) return { status: 409, json: { error: 'invitation rejected by the e2e cloud' } };
            return undefined;
          });
          let created: { results: Array<{ email: string; ok: boolean; inviteId?: string; inviteUrl?: string; error?: string }> };
          try {
            created = await owner.requestJson('/api/workspace/invite', {
              headers: cloud.workspaceHeaders(team),
              body: {
                invites: [
                  { email: 'new@example.com', role: 'member' },
                  { email: 'already@example.com', role: 'admin' },
                  // `owner` is never assignable; the daemon must normalize it
                  // to the safe default instead of letting the client mint an
                  // owner membership.
                  { email: 'owner-role@example.com', role: 'owner' },
                ],
              },
            });
          } finally {
            stopObserving();
          }
          expect(created.results).toEqual([
            {
              email: 'new@example.com',
              ok: true,
              inviteId: expect.any(String),
              inviteUrl: `${cloud.origin}/?invite=${created.results[0]?.inviteId}`,
            },
            { email: 'already@example.com', ok: false, error: 'invite_rejected' },
            {
              email: 'owner-role@example.com',
              ok: true,
              inviteId: expect.any(String),
              inviteUrl: `${cloud.origin}/?invite=${created.results[2]?.inviteId}`,
            },
          ]);
          // Scoped to the caller's verified workspace; roles reach the cloud
          // as requested except `owner`, which became `member`. No e-mail is
          // part of a TokenToSea invitation.
          expect(sentInvites.map(({ workspaceId, role }) => [workspaceId, role])).toEqual([
            [team.workspaceId, 'member'],
            [team.workspaceId, 'admin'],
            [team.workspaceId, 'member'],
          ]);
          expect(sentInvites.every(({ body }) => !JSON.stringify(body).includes('@example.com'))).toBe(true);
          const [memberToken, , ownerRoleToken] = created.results.map((result) => result.inviteId ?? '');

          // Another account consumes the first token before the invitee does.
          await cloud.collaboration('other', { operation: 'invitation.accept', token: memberToken });
          // A token the owner issued that the cloud then reports as expired.
          const expired = await cloud.collaboration<{ token: string }>('owner', {
            operation: 'invitation.create',
            workspaceId: team.workspaceId,
            role: 'member',
          });
          const stopExpiring = cloud.handle('design', 'POST', 'collaboration', ({ body }) => {
            const payload = body as Record<string, unknown>;
            return payload.operation === 'invitation.accept' && payload.token === expired.token
              ? { status: 410, json: { error: '邀请已失效' } }
              : undefined;
          });

          // Acceptance runs through a second isolated daemon/data directory,
          // matching the real owner -> invitee account handoff instead of
          // mutating the inviter's local workspace selection.
          try {
            await inviteeSuite.with.tokenToSea(cloud, 'invitee', async (invitee) => {
              expect(invitee.session.cookie).not.toBe(owner.session.cookie);
              const before = await directoryItems(invitee);
              expect(before.map((item) => item.workspaceType)).toEqual(['personal']);

              // Desktop's deeplink parser/dispatcher owns the thin URL ->
              // nonce POST bridge and is pinned in apps/desktop tests. This
              // cross-process witness starts at that public daemon boundary so
              // E2E stays outside the guarded packaged-leaf implementation.
              const accepted = await invitee.requestJson<{
                context: { workspaceId: string; workspaceType: string; workspaceMemberId: string; role: string };
                workspaceMemberId: string;
              }>('/api/workspace/invite/continue', { body: { nonce: ownerRoleToken } });
              const inviteeView = await cloud.workspace('invitee', team.workspaceId);
              expect(accepted.workspaceMemberId).toBe(inviteeView.workspaceMemberId);
              expect(accepted.context).toMatchObject({
                workspaceId: team.workspaceId,
                workspaceType: 'team',
                workspaceMemberId: inviteeView.workspaceMemberId,
                role: 'member',
              });

              // The membership authority now lists the Team with the role the
              // cloud granted, not the `owner` the client asked for.
              const membership = (await directoryItems(invitee)).find(
                (item) => item.workspaceId === team.workspaceId,
              );
              expect(membership).toMatchObject({
                workspaceType: 'team',
                workspaceMemberId: inviteeView.workspaceMemberId,
                role: 'member',
                memberStatus: 'active',
              });
              const inviteeContext = await invitee.requestJson<ContextBody>('/api/workspace/context', {
                headers: cloud.workspaceHeaders(membership!),
              });
              expect(inviteeContext.context).toMatchObject({
                workspaceId: team.workspaceId,
                workspaceMemberId: inviteeView.workspaceMemberId,
                role: 'member',
              });

              // The accepting account may replay its own continuation.
              const replayed = await invitee.requestJson<{ workspaceMemberId: string }>(
                '/api/workspace/invite/continue',
                { body: { nonce: ownerRoleToken } },
              );
              expect(replayed.workspaceMemberId).toBe(inviteeView.workspaceMemberId);

              for (const [nonce, status] of [
                [expired.token, 410],
                [memberToken, 410],
              ] as const) {
                const response = await invitee.request('/api/workspace/invite/continue', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({ nonce }),
                });
                expect(response.status).toBe(status);
                expect(await response.json()).toEqual({ error: 'continuation_unreachable' });
              }
              // Neither failed continuation granted anything new.
              expect((await directoryItems(invitee)).map((item) => item.workspaceId).sort())
                .toEqual([before[0]!.workspaceId, team.workspaceId].sort());
            }, { env: PACKAGED_TRANSPORT_ENV });
          } finally {
            stopExpiring();
          }

          const ownerContext = await owner.requestJson<ContextBody>('/api/workspace/context', {
            headers: cloud.workspaceHeaders(team),
          });
          expect(ownerContext.context).toMatchObject({
            workspaceId: team.workspaceId,
            workspaceMemberId: team.workspaceMemberId,
            role: 'owner',
            // owner + the account that took the first token + the invitee
            seatSummary: expect.objectContaining({ usedSeats: 3 }),
          });
        }, { env: PACKAGED_TRANSPORT_ENV });

        const daemonOperations = (member: string) => cloud
          .requests({ area: 'design', member, fromHarness: false })
          .map((entry) => [entry.operation, entry.status]);
        expect(daemonOperations('owner').filter(([operation]) => operation === 'invitation.create'))
          .toEqual([['invitation.create', 200], ['invitation.create', 409], ['invitation.create', 200]]);
        expect(daemonOperations('invitee').filter(([operation]) => operation === 'invitation.accept'))
          .toEqual([['invitation.accept', 200], ['invitation.accept', 200], ['invitation.accept', 410], ['invitation.accept', 410]]);
        expect(cloud.requests({ handledBy: 'unhandled' })).toEqual([]);
        expect(cloud.requests().filter((entry) => entry.status >= 500)).toEqual([]);
        expect(await cloud.egress.external('daemon')).toEqual([]);
      } finally {
        await cloud.close();
      }
    },
  );
});
