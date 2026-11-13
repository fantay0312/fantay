import express from 'express';
import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { registerTokenToSeaCloudRoutes } from '../../src/routes/tokentosea-cloud.js';

const session = 'a'.repeat(43);
const cookie = `fantay_session=${session}`;
const user = { id: 'fixture-user', name: 'Fixture' };
const runtime = {
  identity: { session: vi.fn(async (raw: string) => raw === session ? user : null), pending: vi.fn(() => false) },
  json: vi.fn(async () => ({ availableUsd: '12.34' })),
  chatModels: vi.fn(async () => []),
  cliStatus: vi.fn(async () => ({ loggedIn: true, provider: 'tokentosea' })),
  current: vi.fn(() => ({ user })),
  close: vi.fn(),
};

describe('current TokenToSea cloud HTTP routes', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerTokenToSeaCloudRoutes(app, runtime as unknown as TokenToSeaRuntime);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it('resolves the current account and signed-out status', async () => {
    const signed = await fetch(`${base}/api/tokentosea/cloud/status`, { headers: { cookie } });
    expect(await signed.json()).toMatchObject({ loggedIn: true, provider: 'tokentosea', user });
    const anonymous = await fetch(`${base}/api/tokentosea/cloud/status`);
    expect(await anonymous.json()).toMatchObject({ loggedIn: false, sessionState: 'signed_out' });
  });

  it('preserves wallet and model catalog endpoints', async () => {
    const response = await fetch(`${base}/api/tokentosea/cloud/wallet`, { headers: { cookie } });
    expect(await response.json()).toMatchObject({ status: 'available', balanceUsd: '12.34' });
    expect(runtime.json).toHaveBeenCalledWith('wallet');
    const models = await fetch(`${base}/api/tokentosea/cloud/models`);
    expect(await models.json()).toEqual({ source: 'remote', refreshing: false, models: [] });
  });

  it('answers signed-out wallet reads locally', async () => {
    const response = await fetch(`${base}/api/tokentosea/cloud/wallet`);
    expect(await response.json()).toMatchObject({ status: 'signed_out', balanceUsd: null });
    expect(runtime.json).not.toHaveBeenCalled();
  });

  it('keeps the current inbox and retires campaign delivery endpoints', async () => {
    const inbox = await fetch(`${base}/api/tokentosea/cloud/message-center/messages`);
    expect(await inbox.json()).toEqual({ messages: [], nextCursor: null, unreadCount: 0 });
    const campaign = await fetch(`${base}/api/touchpoints/production-runtime`);
    expect(campaign.status).toBe(404);
  });

  it('requires the local CLI request marker', async () => {
    expect((await fetch(`${base}/api/tokentosea/cli/status`)).status).toBe(403);
    const response = await fetch(`${base}/api/tokentosea/cli/status`, { headers: { 'x-fantay-cli': '1' } });
    expect(await response.json()).toMatchObject({ loggedIn: true, provider: 'tokentosea' });
  });
});
