import { expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createShareServer } from '../../apps/share/src/server.js';
import { TokenToSeaRuntime, configureTokenToSeaRuntime } from '../../apps/daemon/src/integrations/tokentosea-runtime.js';
import { createVelaCliTeamProjectCatalog } from '../../apps/daemon/src/collab/vela-cli-team-projects.js';
import { createVelaCliResourceAdapter } from '../../apps/daemon/src/collab/vela-cli-resource-adapter.js';
import { createVelaCliCollabClient } from '../../apps/daemon/src/collab/vela-cli-collab-client.js';
import { stageAuthorizedTeamProjectPull } from '../../apps/daemon/src/collab/authorized-team-project-pull.js';
import { fetchTokenToSeaWorkspaceDirectory } from '../../apps/daemon/src/collab/tokentosea-workspace.js';
import { publishVelaShareVersion } from '../../apps/daemon/src/collab/vela-share-publish.js';
import { readVelaShareStatus } from '../../apps/daemon/src/collab/vela-share-status.js';
import { resumeVelaShareVersion } from '../../apps/daemon/src/collab/vela-share-binding.js';
import { stopVelaShare } from '../../apps/daemon/src/collab/vela-share-stop.js';
import { runVelaCommand, velaWorkspaceCommandOptions } from '../../apps/daemon/src/integrations/vela-command.js';
import { createVelaResourcePullBatcher } from '../../apps/daemon/src/collab/vela-cli-resource-pull-batcher.js';

it('publishes and materializes an authenticated TokenToSea team project without a Vela process', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tts-end-to-end-'));
  const aliceKey = 'a'.repeat(43), bobKey = 'b'.repeat(43);
  const users = new Map([[aliceKey, { id: 'issuer|alice', name: 'Alice' }], [bobKey, { id: 'issuer|bob', name: 'Bob' }]]);
  const app = createShareServer({ dataDir: path.join(root, 'cloud'), publicDir: path.resolve('..', 'apps/share/public'), origin: 'https://design.tokentosea.com', secret: 's'.repeat(40), verifyToken: async key => {
    const user = users.get(key); if (!user) throw new Error('invalid'); return user;
  } });
  await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
  const runtime = new TokenToSeaRuntime(path.join(root, 'daemon'), {
    session: async (key: string) => users.get(key) ?? null,
    share: async (key: string, resource: string, method: string, body: unknown) => fetch(`${base}/api/${resource}`, { method, headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    close: () => {},
  } as never);
  configureTokenToSeaRuntime(runtime);
  const asUser = <T>(key: string, fn: () => Promise<T>): Promise<T> => new Promise((resolve, reject) => {
    runtime.middleware({ headers: { cookie: `fantay_session=${key}` }, originalUrl: '/api/test' } as never, {} as never, () => { void fn().then(resolve, reject); });
  });
  try {
    const workspace = await asUser(aliceKey, () => runtime.collaboration<{ workspaceId: string; workspaceMemberId: string }>({ operation: 'workspace.create', name: 'Team' }));
    const workspaceId = workspace.workspaceId;
    const invitation = await asUser(aliceKey, () => runtime.collaboration<{ token: string }>({ operation: 'invitation.create', workspaceId }));
    const bobMember = await asUser(bobKey, async () => {
      await runtime.collaboration({ operation: 'invitation.accept', token: invitation.token });
      return (await runtime.collaboration<{ workspaceMemberId: string }>({ operation: 'workspace.get', workspaceId })).workspaceMemberId;
    });
    const owner = { memberId: workspace.workspaceMemberId, teamId: workspaceId, role: 'owner' as const, lifecycleState: 'active' as const, workspaceType: 'team' as const };
    const folder = path.join(root, 'project'); await mkdir(folder); await writeFile(path.join(folder, 'index.html'), '<h1>Shared design</h1>'); await writeFile(path.join(folder, '.env'), 'never-publish');
    const catalog = createVelaCliTeamProjectCatalog();
    const published = await asUser(aliceKey, async () => {
      const directory = await fetchTokenToSeaWorkspaceDirectory(); expect(directory.items.some(item => item.workspaceId === workspaceId)).toBe(true);
      const registered = await catalog.ensurePrivate('project-one', owner);
      const adapter = createVelaCliResourceAdapter({ resolveProjectDir: () => folder, resolveResourceId: () => registered.resourceId, hasTeamIdentity: () => true, describeProject: () => ({ projectId: 'project-one', displayName: 'Design' }) });
      const result = await adapter.publish({ projectId: 'project-one', principal: owner, reason: 'integration-test' });
      expect(result?.version).toBe(1);
      expect((await catalog.list(workspaceId))[0]?.projectId).toBe('project-one');
      return { result: result!, resourceId: registered.resourceId };
    });
    await asUser(aliceKey, async () => {
      const slug = randomUUID(), sourceFileId = randomUUID();
      const result = await publishVelaShareVersion({ projectId: 'project-one', workspaceId, resourceId: published.resourceId, versionId: published.result.versionId!,
        slug, filePath: 'index.html', entryPath: 'index.html', name: 'Design', sourceKey: `comment-file-v1:x:${sourceFileId}` });
      expect(result.status).toBe('published');
      expect((await readVelaShareStatus({ workspaceId, projectId: 'project-one', slug }))).toMatchObject({ known: true, status: 'active' });
      await stopVelaShare('project-one', slug, args => runVelaCommand(args, velaWorkspaceCommandOptions(workspaceId)));
      expect((await fetch(`${base}/artifact/project-one/${slug}`)).status).toBe(410);
      await resumeVelaShareVersion({ projectId: 'project-one', workspaceId, resourceId: published.resourceId, versionId: published.result.versionId!, version: published.result.version,
        slug, sourceFilePath: 'index.html' });
      expect((await fetch(`${base}/artifact/project-one/${slug}`)).status).toBe(200);
    });
    const mirror = path.join(root, 'mirror'); await mkdir(mirror);
    await asUser(bobKey, async () => {
      const staged = await stageAuthorizedTeamProjectPull({ projectId: 'project-one', liveDir: mirror, expectedVersion: published.result.version,
        scope: { workspaceId, resourceTeamId: workspaceId, viewerMemberId: bobMember, ownerMemberId: owner.memberId, resourceId: published.resourceId } as never });
      expect(await readFile(path.join(staged.stageDir, 'index.html'), 'utf8')).toContain('Shared design');
      await expect(readFile(path.join(staged.stageDir, '.env'))).rejects.toThrow();
      await staged.cleanup();
      const collab = createVelaCliCollabClient();
      await collab.pushComment(workspaceId, 'project-one', {
        id: 'comment-one', projectId: 'project-one', memberId: 'forged', filePath: 'index.html', elementId: '', selector: 'h1', position: { x: 0.5, y: 0.5, width: 1, height: 1 }, status: 'attached', createdAt: Date.now(), updatedAt: Date.now(), text: 'Change title',
      } as never);
      const result = await collab.pullMemberPage(workspaceId, 'project-one', { mode: 'snapshot' });
      expect(result.kind).toBe('page');
      if (result.kind === 'page') { expect(result.page.comments).toHaveLength(1); expect(result.page.skipped).toHaveLength(0); }
    });
    await asUser(aliceKey, async () => {
      const command = ['resource', 'push', 'skill', 'skill-test', folder, '--exclude', '.env', '--json'];
      await runVelaCommand(command, velaWorkspaceCommandOptions(workspaceId));
      const first = await runtime.collaboration<any>({ operation: 'resource.list', workspaceId });
      expect(first.resources.find((resource: any) => resource.id === 'skill-test').publishedVersion.version).toBe(1);
      await writeFile(path.join(folder, 'index.html'), '<h1>Updated skill</h1>');
      await runVelaCommand(command, velaWorkspaceCommandOptions(workspaceId));
      const second = await runtime.collaboration<any>({ operation: 'resource.list', workspaceId });
      expect(second.resources.find((resource: any) => resource.id === 'skill-test').publishedVersion.version).toBe(2);
    });
    await asUser(bobKey, async () => {
      const batch = createVelaResourcePullBatcher(), destination = path.join(root, 'skill-copy');
      const results = await Promise.allSettled([
        batch.pull({ workspaceId, kind: 'skill', resourceId: 'skill-test', dir: destination }),
        batch.pull({ workspaceId, kind: 'skill', resourceId: 'missing', dir: path.join(root, 'missing') }),
      ]);
      expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected']);
      expect(await readFile(path.join(destination, 'index.html'), 'utf8')).toContain('Updated skill');
    });
    await asUser(aliceKey, () => runtime.collaboration({ operation: 'member.remove', workspaceId, memberId: bobMember }));
    await asUser(bobKey, async () => { await expect(runtime.collaboration({ operation: 'resource.pull', workspaceId, resourceId: published.resourceId })).rejects.toThrow(); });
  } finally { runtime.close(); await new Promise<void>(resolve => app.server.close(() => resolve())); app.close(); await rm(root, { recursive: true, force: true }); }
});
