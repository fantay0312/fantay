// @vitest-environment node

// P0: a Team plugin retraction must converge on an already-running member
// daemon through the real hub-event -> reconciliation -> registry gate chain.
// A fresh/restarted daemon is not enough: the regression fixed by #6335 lived
// in stale local materialization state and delayed positive hub reads.
//
// Both daemons are real tools-dev runtimes signed in to the hermetic TokenToSea
// cloud (`@/vitest/tokentosea-cloud`): the owner and the member are distinct
// TokenToSea accounts, the Team workspace and its membership live in the
// cloud's apps/share collaboration service, and the "hub" signal is the
// `resource.removed` event the member daemon reads through `events.list`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  startTokenToSeaCloud,
  type TokenToSeaCloud,
  type TokenToSeaWorkspaceView,
} from '@/vitest/tokentosea-cloud';
import { createSmokeSuite, type TokenToSeaSuiteContext } from '@/vitest/suite';

const PLUGIN_ID = 'workspace-retraction-plugin';

let cloud: TokenToSeaCloud | null = null;

afterEach(async () => {
  await cloud?.close();
  cloud = null;
});

function workspaceHeaders(view: TokenToSeaWorkspaceView): Record<string, string> {
  const owner = view.role === 'owner';
  return {
    'x-od-workspace-id': view.workspaceId,
    'x-od-workspace-type': 'team',
    'x-od-workspace-member-id': view.workspaceMemberId,
    'x-od-workspace-role': view.role,
    'x-od-workspace-member-status': 'active',
    'x-od-workspace-lifecycle-state': 'active',
    'x-od-workspace-can-share-projects': owner ? 'true' : 'false',
    'x-od-workspace-can-write-synced-files': owner ? 'true' : 'false',
    'x-od-workspace-can-manage-shared-resources': owner ? 'true' : 'false',
  };
}

async function installPlugin(
  daemon: TokenToSeaSuiteContext,
  source: string,
  view: TokenToSeaWorkspaceView,
): Promise<void> {
  const response = await daemon.request('/api/plugins/install', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...workspaceHeaders(view),
    },
    body: JSON.stringify({ source }),
  });
  expect(response.status).toBe(200);
  expect(await response.text()).toContain('event: success');
}

async function applyStatus(
  daemon: TokenToSeaSuiteContext,
  view: TokenToSeaWorkspaceView,
): Promise<number> {
  return (await daemon.request(`/api/plugins/${PLUGIN_ID}/apply`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...workspaceHeaders(view),
    },
    body: JSON.stringify({ inputs: { topic: 'workspace authority' } }),
  })).status;
}

type CloudEvent = { seq: number; type: string; payload: Record<string, unknown> };

describe('workspace Team plugin retraction', () => {
  test(
    '[P0] an already-running member daemon stops listing and applying a retracted Team plugin',
    { timeout: 300_000 },
    async () => {
      const ownerSuite = await createSmokeSuite('collab-plugin-retraction-owner');
      const memberSuite = await createSmokeSuite('collab-plugin-retraction-member');
      const pluginSource = join(ownerSuite.scratchDir, 'workspace-retraction-plugin-source');
      await mkdir(pluginSource, { recursive: true });
      await writeFile(
        join(pluginSource, 'open-design.json'),
        JSON.stringify({
          name: PLUGIN_ID,
          version: '1.0.0',
          title: 'Workspace Retraction Plugin',
          description: 'Pins live Team resource retraction.',
          od: {
            kind: 'skill',
            taskKind: 'new-generation',
            useCase: { query: 'Build a {{topic}} brief.' },
            inputs: [{ name: 'topic', type: 'string', required: true }],
          },
        }, null, 2),
        'utf8',
      );

      const tts = await startTokenToSeaCloud({
        members: [
          { name: 'owner', displayName: 'Plugin Owner' },
          { name: 'member', displayName: 'Plugin Member' },
        ],
      });
      cloud = tts;
      const ownerView = await tts.createTeamWorkspace('owner', 'Plugin Retraction Team');
      const workspaceId = ownerView.workspaceId;
      const memberView = await tts.addWorkspaceMember('owner', workspaceId, 'member', 'member');
      expect(memberView).toMatchObject({ workspaceId, workspaceType: 'team', role: 'member' });

      const cloudPluginResources = async () => (await tts.collaboration<{
        resources: Array<{ id: string; kind: string; ownerMemberId: string }>;
      }>('owner', { operation: 'resource.list', workspaceId })).resources
        .filter((resource) => resource.kind === 'plugin');

      await ownerSuite.with.tokenToSea(tts, 'owner', async (owner) => {
        await owner.requestJson('/api/workspace/active', {
          method: 'PUT',
          body: { workspaceId, workspaceMemberId: ownerView.workspaceMemberId },
        });
        await installPlugin(owner, pluginSource, ownerView);
        expect(await applyStatus(owner, ownerView)).toBe(200);

        await owner.requestJson(
          `/api/workspace/plugins/${encodeURIComponent(PLUGIN_ID)}/share`,
          { method: 'POST', headers: workspaceHeaders(ownerView) },
        );
        // The share is an owner-authored resource in the cloud, not a local stub.
        const shared = await cloudPluginResources();
        expect(shared).toEqual([
          expect.objectContaining({ kind: 'plugin', ownerMemberId: ownerView.workspaceMemberId }),
        ]);
        const pluginResourceId = shared[0]!.id;
        expect(pluginResourceId).toContain(PLUGIN_ID);

        await memberSuite.with.tokenToSea(tts, 'member', async (member) => {
          await member.requestJson('/api/workspace/active', {
            method: 'PUT',
            body: { workspaceId, workspaceMemberId: memberView.workspaceMemberId },
          });
          // Hub streams are leased by explicit workspace billing interests.
          // Establish the same lease the open shell owns before asserting
          // push-driven resource convergence: the member daemon then polls the
          // cloud's `events.list` for this workspace as the member.
          await member.requestJson(
            `/api/workspace/billing?scope=workspace&workspaceId=${workspaceId}`,
            { headers: workspaceHeaders(memberView) },
          );
          await expect.poll(() => tts.requests({
            area: 'design', member: 'member', operation: 'events.list', fromHarness: false,
          }).filter((entry) => entry.workspaceId === workspaceId && entry.status === 200).length, {
            timeout: 20_000,
          }).toBeGreaterThan(0);

          await expect.poll(async () => {
            const team = await member.requestJson<{ ids: string[] }>(
              '/api/workspace/plugins/team',
              { headers: workspaceHeaders(memberView) },
            );
            return team.ids;
          }, { timeout: 30_000 }).toContain(PLUGIN_ID);
          await expect.poll(() => applyStatus(member, memberView), {
            timeout: 30_000,
          }).toBe(200);

          const eventsBefore = (await tts.collaboration<{ cursor: number }>('owner', {
            operation: 'events.list', workspaceId, after: 0,
          })).cursor;
          await owner.requestJson(
            `/api/workspace/plugins/${encodeURIComponent(PLUGIN_ID)}/share`,
            { method: 'DELETE', headers: workspaceHeaders(ownerView) },
          );
          // The retraction is a cloud-side removal of exactly that plugin
          // resource, published to the workspace's event stream with its kind
          // (the daemon routes `team-resources-changed` reconciliation by it).
          await expect.poll(async () => {
            const page = await tts.collaboration<{ events: CloudEvent[] }>('owner', {
              operation: 'events.list', workspaceId, after: eventsBefore,
            });
            return page.events.some((event) =>
              event.type === 'resource.removed'
              && event.payload.kind === 'plugin'
              && event.payload.resourceId === pluginResourceId);
          }, { timeout: 20_000 }).toBe(true);
          expect(await cloudPluginResources()).toEqual([]);

          // No focus event, daemon restart, or explicit Team-list refresh
          // precedes this assertion. The hub signal itself must retire the
          // binding before the next apply can use stale local bytes.
          await expect.poll(() => applyStatus(member, memberView), {
            timeout: 30_000,
          }).toBe(404);
          const teamAfterRetraction = await member.requestJson<{ ids: string[] }>(
            '/api/workspace/plugins/team',
            { headers: workspaceHeaders(memberView) },
          );
          expect(teamAfterRetraction.ids).not.toContain(PLUGIN_ID);

          // Retraction removes the Team projection, not the owner's
          // independent Personal resource with the same manifest id.
          expect(await applyStatus(owner, ownerView)).toBe(200);
        }, { env: { AMR_HOME: join(memberSuite.scratchDir, 'empty-amr-home') } });
      }, { env: { AMR_HOME: join(ownerSuite.scratchDir, 'empty-amr-home') } });

      // Every hop went through the cloud as the right account.
      const daemonOperations = (name: string) => tts
        .requests({ area: 'design', member: name, fromHarness: false })
        .map((entry) => entry.operation);
      expect(daemonOperations('owner')).toEqual(expect.arrayContaining(['resource.push', 'resource.remove']));
      expect(daemonOperations('member')).toEqual(expect.arrayContaining(['resource.list', 'resource.pull']));
      expect(daemonOperations('member')).not.toContain('resource.push');
      expect(daemonOperations('member')).not.toContain('resource.remove');
    },
  );
});
