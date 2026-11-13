import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, request, type Server } from 'node:http';

const runtime = vi.hoisted(() => ({
  identity: { begin: vi.fn(async () => 'https://accounts.example.test/authorize') },
  revokeSession: vi.fn(),
}));
vi.mock('../../src/integrations/tokentosea-runtime.js', () => ({
  tokenToSeaRuntime: () => runtime,
  tokenToSeaCookie: () => 'existing-session',
}));
import { registerTokenToSeaRoutes } from '../../src/routes/tokentosea.js';

describe('TokenToSea login request origin', () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    registerTokenToSeaRoutes(app, '/unused-login-fixture');
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  beforeEach(() => vi.clearAllMocks());
  afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });

  it('starts browser authorization for the desktop proxy with an existing cookie and no Origin', async () => {
    const response = await fetch(`${base}/api/tokentosea/login`, {
      method: 'POST', headers: { Cookie: 'fantay_session=existing-session', 'sec-fetch-site': 'none' },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toHaveProperty('authorizeUrl');
    expect(runtime.identity.begin).toHaveBeenCalledWith('existing-session');
  });

  it('accepts the matching browser origin', async () => {
    const response = await fetch(`${base}/api/tokentosea/login`, {
      method: 'POST', headers: { Origin: base, Cookie: 'fantay_session=existing-session' },
    });
    expect(response.status).toBe(200);
    expect(runtime.identity.begin).toHaveBeenCalledOnce();
  });

  it.each(['null', 'https://untrusted.example', 'od://other-app'])('rejects %s without starting an authorization flow', async origin => {
    const response = await fetch(`${base}/api/tokentosea/login`, {
      method: 'POST', headers: { Origin: origin, Cookie: 'fantay_session=existing-session' },
    });
    expect(response.status).toBe(403);
    expect(runtime.identity.begin).not.toHaveBeenCalled();
  });

  it('rejects a forged non-local Host even without cookies', async () => {
    // Fetch owns Host, so use the HTTP client to actually send a forged value.
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const call = request(`${base}/api/tokentosea/login`, {
        method: 'POST', headers: { Host: 'untrusted.example' },
      }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      call.on('error', reject); call.end();
    });
    expect(status).toBe(403);
    expect(runtime.identity.begin).not.toHaveBeenCalled();
  });
});
