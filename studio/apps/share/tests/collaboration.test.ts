import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { CollaborationStore } from '../src/collaboration.js';

const alice = { id: 'issuer|alice', name: 'Alice' }, bob = { id: 'issuer|bob', name: 'Bob' }, stranger = { id: 'issuer|stranger', name: 'Stranger' };
const stores: Array<{ store: CollaborationStore; directory: string }> = [];
afterEach(async () => { for (const { store, directory } of stores.splice(0)) { store.close(); await rm(directory, { recursive: true, force: true }); } });
async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'tts-collab-'));
  const store = new CollaborationStore(directory, 'https://design.tokentosea.com'); stores.push({ store, directory });
  const run = (user: typeof alice, operation: string, input: Record<string, unknown> = {}): any => store.execute(user, { operation, ...input });
  const workspace = run(alice, 'workspace.create', { name: 'Design team' });
  const workspaceId = workspace.workspaceId;
  const invite = run(alice, 'invitation.create', { workspaceId });
  run(bob, 'invitation.accept', { token: invite.token });
  return { store, run, workspaceId };
}
describe('TokenToSea collaboration authority', () => {
  it('rejects cross-project resource reuse and leaves no blobs behind on failed pushes', async () => {
    const { store, run, workspaceId } = await fixture();
    run(alice, 'project.upsert', { workspaceId, projectId: 'public', visibility: 'team' });
    run(alice, 'project.upsert', { workspaceId, projectId: 'private' });
    const file = (content: string) => ({ path: 'index.html', contentBase64: Buffer.from(content).toString('base64'), sha256: createHash('sha256').update(content).digest('hex') });
    run(alice, 'resource.push', { workspaceId, projectId: 'public', resourceId: 'one', files: [file('public')] });
    const directory = path.join(stores.find(entry => entry.store === store)!.directory, 'collaboration-blobs');
    const before = await readdir(directory);
    expect(() => run(alice, 'resource.push', { workspaceId, projectId: 'private', resourceId: 'one', files: [file('secret')] })).toThrow('归属');
    expect(() => run(alice, 'resource.push', { workspaceId, projectId: 'public', resourceId: 'one', expectedVersion: 'stale', files: [file('discarded')] })).toThrow('版本');
    expect(await readdir(directory)).toEqual(before);
    expect(run(bob, 'resource.pull', { workspaceId, resourceId: 'one' }).files[0].contentBase64).toBe(Buffer.from('public').toString('base64'));
  });
  it('keeps personal workspaces isolated and binds team membership to authenticated users', async () => {
    const { run, workspaceId } = await fixture();
    expect(run(alice, 'workspace.list').workspaces).toHaveLength(2);
    expect(run(stranger, 'workspace.list').workspaces).toHaveLength(1);
    expect(() => run(stranger, 'member.list', { workspaceId })).toThrow('权限');
    const members = run(alice, 'member.list', { workspaceId }).members;
    expect(members.map((m: any) => m.displayName)).toEqual(['Alice', 'Bob']);
    expect(() => run(bob, 'invitation.create', { workspaceId, role: 'admin' })).toThrow('权限');
  });
  it('enforces private visibility, owner-only writes, revision checks and tombstone ownership', async () => {
    const { run, workspaceId } = await fixture();
    const p = run(alice, 'project.upsert', { workspaceId, projectId: 'project-1', name: 'Private' });
    expect(run(bob, 'project.list', { workspaceId }).projects).toHaveLength(0);
    expect(() => run(bob, 'project.get', { workspaceId, projectId: p.projectId })).toThrow('不存在');
    run(alice, 'project.upsert', { workspaceId, projectId: p.projectId, visibility: 'team', expectedRevision: p.revision });
    expect(run(bob, 'project.list', { workspaceId }).projects).toHaveLength(1);
    expect(() => run(bob, 'project.upsert', { workspaceId, projectId: p.projectId, name: 'Hijack' })).toThrow('拥有者');
    expect(() => run(alice, 'project.upsert', { workspaceId, projectId: p.projectId, expectedRevision: p.revision })).toThrow('版本');
    run(alice, 'project.remove', { workspaceId, projectId: p.projectId });
    expect(() => run(bob, 'project.upsert', { workspaceId, projectId: p.projectId })).toThrow('拥有者');
  });
  it('validates snapshots, rejects stale heads and rechecks membership on downloads', async () => {
    const { run, workspaceId } = await fixture();
    run(alice, 'project.upsert', { workspaceId, projectId: 'p', visibility: 'team' });
    const bytes = Buffer.from('hello'), sha256 = createHash('sha256').update(bytes).digest('hex');
    const input = { workspaceId, projectId: 'p', resourceId: 'r', files: [{ path: 'index.html', sha256, contentBase64: bytes.toString('base64') }] };
    expect(() => run(alice, 'resource.push', { ...input, files: [{ ...input.files[0], path: '../secret' }] })).toThrow('路径');
    const first = run(alice, 'resource.push', input);
    expect(run(bob, 'resource.pull', { workspaceId, resourceId: 'r' }).files[0].contentBase64).toBe(bytes.toString('base64'));
    expect(() => run(alice, 'resource.push', { ...input, expectedVersion: 'stale' })).toThrow('版本');
    expect(() => run(bob, 'resource.push', input)).toThrow('拥有者');
    const bobMember = run(alice, 'member.list', { workspaceId }).members.find((m: any) => m.displayName === 'Bob');
    run(alice, 'member.remove', { workspaceId, memberId: bobMember.memberId });
    expect(() => run(bob, 'resource.pull', { workspaceId, resourceId: 'r', expectedVersion: first.versionId })).toThrow('权限');
  });
  it('preserves comment authors, publishes incremental updates and expires viewer presence', async () => {
    const { store, run, workspaceId } = await fixture();
    run(alice, 'project.upsert', { workspaceId, projectId: 'p', visibility: 'team' });
    const scope = { workspaceId, projectId: 'p' };
    const first = run(bob, 'comment.push', { ...scope, comment: { id: 'c', text: 'Change this', authorKey: 'forged' } });
    expect(first.comments[0].authorKey).toBe(bob.id);
    expect(() => run(alice, 'comment.push', { ...scope, comment: { id: 'c', text: 'Forged' } })).toThrow('其他人');
    run(bob, 'comment.push', { ...scope, comment: { id: 'c', text: 'Updated' } });
    expect(run(alice, 'comment.pull', { ...scope, after: first.latestSeq }).comments[0].text).toBe('Updated');
    expect(run(bob, 'presence.heartbeat', { ...scope, clientId: 'tab-1' }).viewers).toHaveLength(1);
    store.db.prepare('UPDATE presence SET expires_at=0').run();
    expect(run(alice, 'presence.list', scope).viewers).toHaveLength(0);
    const events = run(alice, 'events.list', { workspaceId, after: 0 });
    expect(events.events.some((e: any) => e.type === 'comments.changed')).toBe(true);
    expect(run(alice, 'events.list', { workspaceId, after: events.cursor }).events).toHaveLength(0);
  });
});
