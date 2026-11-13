import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ShareStore } from '../src/store.js';
import { clientAddress, createShareServer } from '../src/server.js';
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), 'fantay-share-')); dirs.push(dir); return dir; }
const alice = { id: 'issuer|alice', name: 'Alice' }, bob = { id: 'issuer|bob', name: 'Bob' };
function payload(text = '<h1>Design</h1>') { const bytes = Buffer.from(text); return { title: 'Design', documentKey: 'project:a:file:b', requestKey: 'first-publish', files: [{ path: 'index.html', contentBase64: bytes.toString('base64'), sha256: createHash('sha256').update(bytes).digest('hex') }] }; }
describe('durable share ownership and comments', () => {
  it('preserves links and comments across updates, stop/resume and restart', async () => {
    const dir = await directory(), store = new ShareStore(dir, 'https://design.tokentosea.com');
    const first = await store.publish(alice, payload());
    expect(await store.publish(alice, payload())).toEqual(first);
    expect(() => store.changeState(bob, first.id, 'stopped', 1)).toThrow('仅发布者');
    const comments = store.addComment(bob, first.id, { text: 'Change title', version: first.version, target: { selector: 'h1', position: { x: .3, y: .2 } }, requestKey: 'comment-1', author: alice });
    expect(comments[0]?.author.name).toBe('Bob');
    expect(store.addComment(bob, first.id, { text: 'Change title', version: first.version, target: { selector: 'h1', position: { x: .3, y: .2 } }, requestKey: 'comment-1' })).toHaveLength(1);
    const newer = await store.publish(alice, { ...payload('<h1>New design</h1>'), requestKey: 'second', expectedRevision: first.revision });
    expect(newer.id).toBe(first.id); expect(newer.version).not.toBe(first.version);
    expect(store.comments(first.id)[0]?.version).toBe(first.version);
    expect(() => store.addComment(bob, first.id, { text: 'Stale', version: first.version, requestKey: 'stale' })).toThrow('作品已更新');
    const stopped = store.changeState(alice, first.id, 'stopped', newer.revision);
    expect(() => store.get(first.id)).toThrow('分享已停用');
    await expect(store.asset(first.id, first.version, 'index.html')).rejects.toThrow('分享已停用');
    expect(() => store.comments(first.id)).toThrow('分享已停用');
    const resumed = store.changeState(alice, first.id, 'active', stopped.revision); expect(resumed.version).toBe(newer.version);
    store.close(); const reopened = new ShareStore(dir, 'https://design.tokentosea.com');
    expect(reopened.get(first.id).id).toBe(first.id); expect(reopened.comments(first.id)).toHaveLength(1); reopened.close();
  });
  it('rejects traversal, aliases, tampered hashes and stale concurrent updates', async () => {
    const store = new ShareStore(await directory(), 'https://design.tokentosea.com');
    const input = payload();
    await expect(store.publish(alice, { ...input, files: [{ ...input.files[0]!, path: '../secret' }] })).rejects.toThrow('文件路径');
    await expect(store.publish(alice, { ...input, files: [{ ...input.files[0]!, sha256: '0'.repeat(64) }] })).rejects.toThrow('校验');
    await expect(store.publish(alice, { ...input, files: [...input.files, { ...input.files[0]!, path: 'INDEX.HTML' }] })).rejects.toThrow('重复');
    const first = await store.publish(alice, input);
    await expect(store.publish(alice, { ...input, requestKey: 'stale', expectedRevision: first.revision + 1 })).rejects.toThrow('请刷新');
    await expect(store.asset(first.id, first.version, '%2e%2e/secret')).rejects.toThrow('文件不存在');
    store.close();
  });
  it('reserves quota across concurrent documents and refuses invisible overflow comments', async () => {
    const store = new ShareStore(await directory(), 'https://design.tokentosea.com');
    const first = await store.publish(alice, payload());
    store.db.prepare('UPDATE versions SET size=?').run(1024 * 1024 * 1024 - 20);
    const outcomes = await Promise.allSettled([
      store.publish(alice, { ...payload(), requestKey: 'parallel-a', documentKey: 'a' }),
      store.publish(alice, { ...payload(), requestKey: 'parallel-b', documentKey: 'b' }),
    ]);
    expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
    const insert = store.db.prepare('INSERT INTO comments(id,share_id,version,author,author_name,text,status,request_key,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)');
    for (let i = 0; i < 500; i++) insert.run(`comment-${i}`, first.id, first.version, alice.id, alice.name, 'test', 'open', `request-${i}`, 'now', 'now');
    expect(() => store.addComment(bob, first.id, { text: 'overflow', version: first.version, requestKey: 'overflow' })).toThrow('500');
    store.close();
  });
});
describe('HTTP authority and artifact isolation', () => {
  it('uses forwarded client addresses only behind the loopback proxy', () => {
    const input = { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.5' } };
    expect(clientAddress(input as never)).toBe('203.0.113.5');
    expect(clientAddress({ ...input, socket: { remoteAddress: '198.51.100.2' } } as never)).toBe('198.51.100.2');
  });
  it('refuses unauthenticated or invalid writes and isolates raw HTML', async () => {
    const app = createShareServer({ dataDir: await directory(), origin: 'https://design.tokentosea.com', secret: 'x'.repeat(48), publicDir: path.resolve('public'), verifyToken: async token => { if (token !== 'test-token') throw new Error('invalid'); return alice; } });
    await new Promise<void>(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const address = app.server.address() as { port: number }, base = `http://127.0.0.1:${address.port}`;
    try {
      const anonymous = await fetch(`${base}/api/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) }); expect(anonymous.status).toBe(403);
      const crossOrigin = await fetch(`${base}/api/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token', Origin: 'null' }, body: JSON.stringify(payload()) }); expect(crossOrigin.status).toBe(403);
      const published = await fetch(`${base}/api/shares`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' }, body: JSON.stringify(payload()) }); expect(published.status).toBe(201);
      const receipt = await published.json();
      const raw = await fetch(`${base}/content/${receipt.id}/${receipt.version}/index.html`);
      expect(raw.headers.get('content-security-policy')).toContain('sandbox allow-scripts');
      expect(raw.headers.get('content-security-policy')).not.toContain('allow-same-origin');
      expect(raw.headers.get('content-security-policy')).toContain("connect-src 'none'");
      expect(raw.headers.get('set-cookie')).toBeNull();
    } finally { await new Promise<void>(resolve => app.server.close(() => resolve())); app.close(); }
  });
});
