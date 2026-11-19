import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PaConversation, PaSnapshot, PaSoulSnapshot, PersonalAgent } from '@open-design/contracts';
import { closeDatabase, openDatabase, type SqliteDb } from '../src/db.js';
import { registerPersonalAgentRoutes } from '../src/routes/personal-agent.js';
import { createPaKernel, type PaKernel } from '../src/services/pa/kernel.js';
import type { PersonalAgentChannels } from '../src/services/personal-agent-channels.js';
import { paDigest } from '../src/services/personal-agent-gateway.js';
import { PersonalAgentService } from '../src/services/personal-agent-service.js';

let root: string, db: SqliteDb;
const servers: http.Server[] = [];
const cleanup: Array<() => Promise<void> | void> = [];
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'pa-org-link-'));
  db = openDatabase(root, { dataDir: root });
});
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise<void>(resolve => server.close(() => resolve()));
  for (const step of cleanup.splice(0).reverse()) await step();
  closeDatabase();
  rmSync(root, { recursive: true, force: true });
});

const token = () => randomBytes(32).toString('base64url');
const card = (name: string, tagline: string) => ({
  spec: 'chara_card_v2', spec_version: '2.0',
  data: { name, description: `${name}，${tagline}`, personality: '温和', scenario: '', first_mes: `你好，我是${name}。`, mes_example: '', creator_notes: tagline, tags: [] },
});

/** The organization server as the daemon sees it: the two sync answers, changed by the test between syncs. */
function organization() {
  const tokens = { boss: token(), alice: token(), bob: token() };
  const expiresAt = Date.now() + 600_000;
  const entry = (id: keyof typeof tokens, role: string, groups: string[], grantVersion = 1) =>
    ({ id, role, group: groups[0] ?? 'default', tokenSha256: paDigest(tokens[id]), grantVersion, expiresAt, permissions: [], groups });
  const item = (id: string, name: string, version: number, audience: unknown = { kind: 'everyone' }, kind = 'character', document: unknown = card(name, '第一版')) =>
    ({ id, kind, name, status: 'published', version, audience, assets: [], updatedBy: 'boss', document, revision: version, createdAt: 1, updatedAt: 1 });
  const state = {
    online: true, tenantId: 'acme', calls: [] as string[],
    policy: { companion: { enabled: true, memory: true, personas: true }, models: [] as string[], retentionDays: null as number | null },
    directory: { version: 1, members: [entry('boss', 'admin', []), entry('alice', 'operator', ['g1']), entry('bob', 'operator', [])] },
    library: { version: 3, items: [item('lib-a', '小月', 1), item('lib-b', '客服小助', 2, { kind: 'groups', groupIds: ['g1'] }),
      item('lib-p', '简洁', 3, { kind: 'everyone' }, 'preset', { name: '简洁', description: '短句', main: '用短句回答。' })] },
  };
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    state.calls.push(`${url.pathname}${url.search}`);
    if (!state.online) throw new TypeError('fetch failed');
    if (new Headers(init?.headers).get('authorization') !== 'Bearer fts_controller') return new Response('{}', { status: 401 });
    const reply = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.pathname === '/v1/sync/directory') return reply({ tenantId: state.tenantId, generatedAt: Date.now(), ...state.directory, policy: state.policy });
    if (url.pathname === '/v1/sync/library') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return reply({ version: state.library.version, items: state.library.items.filter(entry => entry.version > since), current: state.library.items.map(entry => entry.id) });
    }
    return new Response('{}', { status: 404 });
  }) as typeof fetch;
  return { state, tokens, entry, item, fetcher };
}

function boot(org: ReturnType<typeof organization>): { kernel: PaKernel; service: PersonalAgentService } {
  const secret = join(root, 'gateway.secret'), credential = join(root, 'org.credential'), configPath = join(root, 'enterprise.json');
  writeFileSync(secret, token(), { mode: 0o600 });
  writeFileSync(credential, 'fts_controller\n', { mode: 0o600 });
  const quota = { calls: 100, cpuMs: 5000000, costMicros: 1000000 };
  writeFileSync(configPath, JSON.stringify({
    version: 1, mode: 'enterprise',
    enterprise: {
      tenantId: 'acme',
      orgServer: { url: 'https://org.acme.test', credentialFile: credential, refreshSeconds: 3600 },
      budgets: { tenant: quota, groups: { default: quota }, roles: { admin: quota, operator: quota, viewer: quota } },
      gateway: { endpoint: 'http://127.0.0.1:1/model', secret: { type: 'file', path: secret }, models: [{ id: 'test', maxTokens: 1024, reserveCostMicros: 10 }] },
    },
  }), { mode: 0o600 });
  const kernel = createPaKernel({ configPath, db, dataDir: root, projectsDir: join(root, 'projects'), localRuntime: { models: async () => [], execute: async () => ({ text: '', usage: { visibility: 'unknown' } }) } });
  const service = new PersonalAgentService({
    db: kernel.storage.db, dataDir: kernel.storage.dataDir, projectsDir: kernel.storage.projectsDir, runtime: kernel.credentials.runtime, kernel, orgFetch: org.fetcher,
  });
  cleanup.push(async () => { await service.shutdown(); kernel.storage.close(); });
  return { kernel, service };
}
async function listen(service: PersonalAgentService) {
  const app = express();
  app.use('/api/pa/soul', express.json({ limit: '24mb' }));
  app.use(express.json());
  registerPersonalAgentRoutes(app, { personalAgent: service, personalAgentChannels: { pendingApprovalCount: () => 0 } as unknown as PersonalAgentChannels });
  const server = await new Promise<http.Server>(resolve => { const started: http.Server = app.listen(0, '127.0.0.1', () => resolve(started)); });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return async (bearer: string, method: string, route: string, payload?: unknown) => {
    const response = await fetch(`${base}/api/pa${route}`, {
      method, headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
}
const names = (snapshot: { characters: Array<{ id: string }> }, agents: PersonalAgent[]) =>
  snapshot.characters.map(character => agents.find(agent => agent.id === character.id)?.name).sort();

describe('following an organization server', () => {
  it('takes the member directory and the library from the server, and shows each member what their groups allow', async () => {
    const org = organization();
    const { service } = boot(org);
    const call = await listen(service);
    const status = await service.syncOrg();
    expect(status).toMatchObject({ url: 'https://org.acme.test', directory: { version: 1, count: 3, error: null }, library: { version: 3, count: 3, error: null } });
    const { boss, alice, bob } = org.tokens;
    const agents = service.store.list<PersonalAgent>('agents');
    // Nobody changes the library here any more, the admin included: it is the server's.
    expect((await call(boss, 'GET', '/mode')).body).toMatchObject({ role: 'admin', canManageLibrary: false });
    expect((await call(boss, 'POST', '/soul/characters/import', { card: card('私货', 'x') })).status).toBe(403);
    expect((await call(boss, 'GET', '')).body.org.library.count).toBe(3);
    // Alice is in g1 and sees both characters; Bob is not and sees one; the admin sees all.
    const soulOf = async (bearer: string) => (await call(bearer, 'GET', '/soul')).body as PaSoulSnapshot;
    expect(names(await soulOf(alice), agents)).toEqual(['客服小助', '小月']);
    expect(names(await soulOf(bob), agents)).toEqual(['小月']);
    expect(names(await soulOf(boss), agents)).toEqual(['客服小助', '小月']);
    expect((await soulOf(bob)).presets.map(preset => preset.name)).toEqual(['简洁']);
    const scoped = agents.find(agent => agent.name === '客服小助')!;
    const bobView = (await call(bob, 'GET', '')).body as PaSnapshot;
    expect(bobView.agents.some(agent => agent.id === scoped.id)).toBe(false);
    expect((await call(bob, 'POST', '/conversations', { agentId: scoped.id })).status).toBe(403);
    const chat = await call(alice, 'POST', '/conversations', { agentId: scoped.id });
    expect(chat.body.principalId).toBe('alice');
    // A synced character opens no shared room: every conversation with it belongs to a member.
    expect(service.store.list<PaConversation>('conversations')
      .filter(item => item.agentId === scoped.id).map(item => item.principalId)).toEqual(['alice']);
    expect((await call(alice, 'GET', '/enterprise/org')).status).toBe(403);
    expect((await call(boss, 'GET', '/enterprise/org')).body.directory.count).toBe(3);

    // The server changes: a new edition of one character, the other retired, Alice moved out of g1, Bob removed.
    const first = agents.find(agent => agent.name === '小月')!;
    org.state.library = { version: 5, items: [org.item('lib-a', '小月', 5, { kind: 'everyone' }, 'character', card('小月', '第二版'))] };
    org.state.directory = { version: 2, members: [org.entry('boss', 'admin', []), org.entry('alice', 'operator', [], 2)] };
    const next = (await call(boss, 'POST', '/enterprise/org/sync')).body;
    expect(next).toMatchObject({ directory: { version: 2, count: 2 }, library: { version: 5, count: 1, error: null } });
    expect(org.state.calls.at(-1)).toBe('/v1/sync/library?since=3');
    expect((await call(bob, 'GET', '')).status).toBe(401);
    const updated = (await soulOf(alice)).characters.find(character => character.id === first.id)!;
    expect(updated.creatorNotes ?? JSON.stringify(updated)).toContain('第二版');
    expect(service.store.require<PersonalAgent>('agents', scoped.id).enabled).toBe(false);
    expect(service.store.require<PersonalAgent>('agents', first.id).enabled).toBe(true);
    expect((await soulOf(alice)).presets).toEqual([]);

    // The organization's switches arrive with the directory and close exactly what they name.
    expect((await call(alice, 'POST', '/soul/personas', { name: '阿离', description: '' })).status).toBe(200);
    org.state.policy.companion = { enabled: false, memory: false, personas: false };
    expect((await call(boss, 'POST', '/enterprise/org/sync')).body.companion).toEqual({ enabled: false, memory: false, personas: false });
    const refused = async (route: string, payload: unknown) => (await call(alice, 'POST', route, payload)).body.error?.code;
    expect(await refused('/soul/personas', { name: '阿渡', description: '' })).toBe('PA_POLICY');
    expect(await refused('/conversations', { agentId: first.id })).toBe('PA_POLICY');
    expect(await refused('/tasks', { requestId: 'r-12345678', conversationId: chat.body.id, goal: '在吗', kind: 'chat' })).toBe('PA_POLICY');
    expect(await refused('/memories', { content: '她喜欢热可可', scope: 'agent', scopeId: first.id, source: '测试' })).toBe('PA_POLICY');
    expect((await call(alice, 'GET', '/soul')).status).toBe(200);
  });

  it('keeps working from the last directory while the server is away, and reports the failure', async () => {
    const org = organization();
    const first = boot(org);
    await first.service.syncOrg();
    await first.service.shutdown();
    first.kernel.storage.close();
    cleanup.pop();
    org.state.online = false;
    const { service } = boot(org);
    const call = await listen(service);
    const status = await service.syncOrg();
    expect(status.directory).toMatchObject({ version: 0, error: '无法连接企业服务器' });
    expect(status.library).toMatchObject({ version: 3, count: 3 });
    expect((await call(org.tokens.alice, 'GET', '/mode')).body).toMatchObject({ authorized: true, memberId: 'alice' });
    // A list from another organization is refused whole.
    org.state.online = true;
    org.state.tenantId = 'someone-else';
    expect((await service.syncOrg()).directory.error).toBe('企业服务器的组织编号与本机配置不一致');
    expect((await call(org.tokens.alice, 'GET', '/mode')).body.authorized).toBe(true);
  });
});
