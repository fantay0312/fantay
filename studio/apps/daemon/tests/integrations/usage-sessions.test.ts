import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { AiUsageStore } from '../../src/integrations/usage-store.js';
import { registerUsageRoutes } from '../../src/routes/usage.js';
import type { AiUsageSummary } from '@open-design/contracts';

const resources: Array<{ dir: string; store: AiUsageStore }> = [];
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  for (const { dir, store } of resources.splice(0)) { store.close(); rmSync(dir, { recursive: true, force: true }); }
});
const at = Date.parse('2026-11-14T01:00:00Z');
function fixture() {
  const dir = mkdtempSync(path.join(tmpdir(), 'usage-sessions-'));
  const store = new AiUsageStore(dir); resources.push({ dir, store });
  for (let i = 0; i < 502; i++) store.recordLocal({ key: `muse-${i}`, provider: 'muse', model: 'test-model', origin: 'external', sessionId: 'shared', context: {}, at: at + i,
    usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 4 }, estimatedUsd: 0.01 });
  store.recordLocal({ key: 'other', provider: 'codex', model: 'other', origin: 'external', sessionId: 'shared', context: {}, at, usage: { input_tokens: 999 }, reportedUsd: 2 });
  store.recordLocal({ key: 'hidden', provider: 'muse', model: 'test-model', origin: 'external', sessionId: 'hidden', context: { projectId: 'denied' }, at, usage: { input_tokens: 999 } });
  return store;
}

it('groups full-range sessions independently of the recent limit and respects provider, scope and project access', () => {
  const store = fixture();
  const options = { scope: 'device' as const, from: '2026-11-14', to: '2026-11-14', now: at, limit: 0 };
  const data = store.summary(null, 30, undefined, new Set(), 'UTC', options);
  expect(data.recent).toEqual([]);
  expect(data.sessions).toHaveLength(2);
  expect(data.sessions?.[0]).toMatchObject({ provider: 'muse', sessionId: 'shared', firstUsedAt: at, lastUsedAt: at + 501,
    totals: { requests: 502, inputTokens: 5020, cachedTokens: 2008, reportedUsd: '0.000000', estimatedUsd: '5.020000', unknown: 502 } });
  const filtered = store.summary(null, 30, undefined, new Set(), 'UTC', { ...options, provider: 'muse', sessionId: 'shared', limit: 1, activity: true });
  expect(filtered.totals.requests).toBe(502);
  expect(filtered.recent).toHaveLength(1);
  expect(filtered.models).toHaveLength(1);
  expect(filtered.activity?.days[0]?.requests).toBe(502);
  expect(store.summary(null, 30, undefined, new Set(), 'UTC', { ...options, scope: 'fantay' }).sessions).toEqual([]);
  expect(store.summary(null, 30, undefined, new Set(), 'UTC', { ...options, fantaySessions: new Set(['muse:shared']) }).sessions).toHaveLength(1);
});

it('filters session requests at the API and rejects ambiguous or malformed session filters', async () => {
  const usage = fixture(), app = express(), sync = vi.fn();
  registerUsageRoutes(app, { runtime: { usage, current: () => null } as never, requireLocalDaemonRequest: (_req, _res, next) => next(),
    authorizeProject: async () => true, canReadProject: async () => false, syncLocal: sync });
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/usage`;
  const result = await (await fetch(`${base}?scope=device&provider=muse&sessionId=shared&from=2026-11-14&to=2026-11-14&timeZone=UTC&limit=1000`)).json() as AiUsageSummary;
  expect(result.sessionId).toBe('shared');
  expect(result.recent).toHaveLength(502);
  expect(result.recent.every(row => row.provider === 'muse')).toBe(true);
  for (const query of ['sessionId=shared', 'provider=muse&sessionId=', 'provider=muse&sessionId=%00', 'provider=muse&sessionId=a&sessionId=b']) {
    expect((await fetch(`${base}?${query}`)).status).toBe(400);
  }
  expect(sync).toHaveBeenCalledOnce();
});
