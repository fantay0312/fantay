import { afterEach, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { registerCliUpdateRoutes } from '../../src/routes/cli-updates.js';
import { createCliUpdateService } from '../../src/services/cli-updates.js';
import { requireLocalDaemonRequest } from '../../src/http/local-daemon-request.js';

let server: Server | undefined;
afterEach(async () => { if (server) { server.closeAllConnections(); await new Promise<void>(resolve => server!.close(() => resolve())); server = undefined; } });

it('rejects cross-origin updates and arbitrary commands, and runs validated IDs asynchronously', async () => {
  let version = '1.0.0';
  const execute = vi.fn(async () => { version = '1.1.0'; });
  const cliUpdates = createCliUpdateService({
    discover: async () => [{ agentId: 'claude', version, selectedPath: '/test/claude', identity: 'test-claude', method: 'native', env: {} }],
    latest: async () => '1.1.0', execute,
  });
  const app = express(); app.use(express.json());
  registerCliUpdateRoutes(app, { cliUpdates, requireLocalDaemonRequest });
  server = createServer(app);
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No port');
  const base = `http://127.0.0.1:${address.port}/api/agents/updates`;
  const post = (url: string, body: object, origin?: string) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  expect((await post(base, { agentIds: ['claude'] }, 'https://attacker.example')).status).toBe(403);
  expect((await post(base, { command: 'npm anything' })).status).toBe(400);
  expect((await post(base + '/check', {})).status).toBe(202);
  await cliUpdates.settled();
  expect((await post(base, { agentIds: ['injected;command'] })).status).toBe(409);
  expect((await post(base, { agentIds: ['claude'] })).status).toBe(202);
  await cliUpdates.settled();
  expect(execute).toHaveBeenCalledTimes(1);
  expect(await (await fetch(base)).json()).toMatchObject({ items: [{ state: 'updated', installedVersion: '1.1.0' }] });
});
