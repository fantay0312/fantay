import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import type { TokenToSeaIdentity } from '@fantay/tokentosea';
import { registerTokenToSeaShareRoutes } from '../../src/routes/tokentosea-share.js';
const dirs: string[] = [], servers: Server[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await new Promise<void>(r => s.close(() => r())); for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }); });
async function harness() {
  const directory = await mkdtemp(path.join(tmpdir(), 'fantay-share-proxy-')); dirs.push(directory);
  await writeFile(path.join(directory, 'page.html'), '<h1>Design</h1><img src="image.svg">');
  await writeFile(path.join(directory, 'image.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(path.join(directory, '.env'), 'PRIVATE=never-share');
  const share = vi.fn(async (_raw, resource, method, _body) => Response.json(method === 'GET' ? { shares: [] } : { id: 'share-id', url: 'https://design.tokentosea.com/s/share-id', resource }));
  const identity = { session: vi.fn(async raw => raw ? { id: 'issuer|user', name: 'User' } : null), share } as unknown as TokenToSeaIdentity;
  const app = express(); app.use(express.json());
  registerTokenToSeaShareRoutes(app, identity, { resolve: async () => ({ directory, metadata: {}, sourceFileId: 'source-file-id', title: 'Design' }) }, directory);
  const server = createServer(app); servers.push(server); await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as { port: number }).port}`, share };
}
describe('TokenToSea public share proxy', () => {
  it('publishes only the planned artifact and never forwards a caller author or token to the browser', async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/api/tokentosea/shares/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: h.base, Cookie: `fantay_session=${'x'.repeat(43)}` }, body: JSON.stringify({ projectId: 'project', fileName: 'page.html', requestKey: 'request', author: 'forged' }) });
    expect(response.status).toBe(200);
    const call = h.share.mock.calls[0]!;
    expect(call[1]).toBe('shares');
    const payload = call[3] as { documentKey: string; files: { path: string; contentBase64: string }[] };
    expect(payload.documentKey).toBe('project:project:source-file-id');
    expect(payload.files.map(f => f.path)).toEqual(expect.arrayContaining(['index.html', 'image.svg']));
    expect(JSON.stringify(payload)).not.toContain('forged');
    expect(payload.files.some(f => Buffer.from(f.contentBase64, 'base64').toString().includes('PRIVATE='))).toBe(false);
    expect(JSON.stringify(await response.json())).not.toContain('accessToken');
  });
  it('turns a non-JSON upstream answer into a readable error instead of a raw SyntaxError', async () => {
    const h = await harness();
    h.share.mockImplementation(async () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } }));
    const cookie = `fantay_session=${'x'.repeat(43)}`;
    const listed = await fetch(`${h.base}/api/tokentosea/shares?projectId=project&fileName=page.html`, { headers: { Cookie: cookie } });
    expect(listed.status).toBe(502);
    const listedBody = await listed.json() as { error: string };
    expect(listedBody.error).toBe('分享服务暂时不可用');
    expect(JSON.stringify(listedBody)).not.toMatch(/SyntaxError|Unexpected token|JSON/);
    h.share.mockImplementation(async () => new Response('not json', { status: 200 }));
    const okButBroken = await fetch(`${h.base}/api/tokentosea/shares?projectId=project&fileName=page.html`, { headers: { Cookie: cookie } });
    expect(okButBroken.status).toBe(502);
    expect((await okButBroken.json() as { error: string }).error).toBe('分享服务返回了无效内容');
  });
  it('refuses a cross-site cookie write before contacting the share service', async () => {
    const h = await harness();
    const response = await fetch(`${h.base}/api/tokentosea/shares/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://untrusted.example', Cookie: 'fantay_identity=session' }, body: JSON.stringify({ projectId: 'project', fileName: 'page.html' }) });
    expect(response.status).toBe(403); expect(h.share).not.toHaveBeenCalled();
  });
});
