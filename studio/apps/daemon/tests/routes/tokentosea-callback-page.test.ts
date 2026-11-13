import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenToSeaIdentity, renderCallbackPage } from '../../src/integrations/tokentosea.js';

const runtimeState = vi.hoisted(() => ({
  identity: null as unknown as TokenToSeaIdentity,
  revokeSession: vi.fn(),
}));

vi.mock('../../src/integrations/tokentosea-runtime.js', () => ({
  tokenToSeaRuntime: () => runtimeState,
  tokenToSeaCookie: () => 'callback-test-session',
}));

import { registerTokenToSeaRoutes } from '../../src/routes/tokentosea.js';

describe('TokenToSea OAuth callback result page', () => {
  let dataDir: string;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dataDir = await mkdtemp(path.join(tmpdir(), 'fantay-callback-page-'));
    runtimeState.identity = new TokenToSeaIdentity({
      dataDir,
      clientId: 'fantay_callback_test',
      redirectUri: 'https://fantay.example/api/tokentosea/callback',
    });
    const app = express();
    registerTokenToSeaRoutes(app, dataDir);
    server = createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dataDir, { recursive: true, force: true });
  });

  it('renders an authenticated studio pass with CSP nonce, user details, and XSS escaping', () => {
    const { html, csp } = renderCallbackPage(true, {
      user: {
        name: '林星 <script>alert(1)</script>',
        email: 'star"quote@example.com',
      },
    });

    const nonceMatch = csp.match(/script-src 'nonce-([^']+)'/);
    expect(nonceMatch).not.toBeNull();
    expect(csp).toContain("default-src 'none'");
    expect(html).toContain(`<script nonce="${nonceMatch![1]}">`);
    expect(html).toContain('data-state="ok"');
    expect(html).toContain('<meta name="color-scheme" content="light dark" />');
    expect(html).toContain('已登录');
    expect(html).toContain('请返回 Fantay 工作台，可以关闭此页面。');
    expect(html).toContain('林星 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('star&quot;quote@example.com');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('@media (prefers-reduced-motion: no-preference)');
  });

  it('renders HTTP 200 with user card when /api/tokentosea/callback completes', async () => {
    const completeSpy = vi.spyOn(runtimeState.identity, 'complete').mockResolvedValueOnce({
      id: 'https://tokentosea.com/api/oauth|u_1',
      name: 'Fantasy Studio',
      email: 'fantasy@tokentosea.com',
    });

    const response = await fetch(`${base}/api/tokentosea/callback?code=ok_code&state=ok_state`);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    const csp = response.headers.get('content-security-policy') ?? '';
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+'/);

    const body = await response.text();
    expect(body).toContain('Fantasy Studio');
    expect(body).toContain('fantasy@tokentosea.com');
    expect(body).toContain('授权已生效');
    completeSpy.mockRestore();
  });

  it('renders HTTP 400 with escaped failure reason when /api/tokentosea/callback fails', async () => {
    const response = await fetch(`${base}/api/tokentosea/callback?state=expired_state`);
    expect(response.status).toBe(400);
    const body = await response.text();
    expect(body).toContain('data-state="fail"');
    expect(body).toContain('登录未完成');
    expect(body).toContain('授权状态无效或已使用');
  });
});
