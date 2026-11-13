import { describe, it, expect, vi } from 'vitest';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { TokenToSeaIdentity, TOKENTOSEA_ISSUER, TOKENTOSEA_SCOPES } from '../../src/integrations/tokentosea.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'test-key' };
const clientId = 'fantay_test_client';
function jwt(nonce: string, now: number, patch: Record<string, unknown> = {}) {
  const body = [Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'test-key' })).toString('base64url'), Buffer.from(JSON.stringify({ iss: TOKENTOSEA_ISSUER, aud: clientId, sub: 'test-user', nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900, ...patch })).toString('base64url')].join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}
async function harness(patch: Record<string, unknown> = {}, serviceRequest?: typeof fetch, refreshAnswer?: () => Response | Promise<Response>) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'fantay-identity-'));
  let now = 1_800_000_000_000;
  let nonce = ''; let exchanges = 0; let refreshes = 0; let revokes = 0;
  let blocker: Promise<void> | null = null;
  const request: typeof fetch = async (url, init) => {
    const endpoint = String(url);
    if (endpoint.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (endpoint.endsWith('/userinfo')) return Response.json({ sub: 'test-user', name: '测试用户', email: 'test@example.com' });
    if (endpoint.endsWith('/revoke')) { revokes++; return Response.json({}); }
    if (endpoint.includes('/v1/connect/') && serviceRequest) return serviceRequest(url, init);
    const params = init?.body as URLSearchParams;
    if (params.get('grant_type') === 'refresh_token') { refreshes++; if (refreshAnswer) return refreshAnswer(); return Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 900 }); }
    exchanges++; if (blocker) await blocker;
    expect(params.has('client_secret')).toBe(false);
    return Response.json({ access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 900, id_token: jwt(nonce, now, patch) });
  };
  const identity = new TokenToSeaIdentity({ dataDir, clientId, redirectUri: 'https://fantay.example/api/tokentosea/callback', fetch: request, now: () => now });
  async function begin(session = 'browser-one') {
    const url = new URL(await identity.begin(session)); nonce = url.searchParams.get('nonce')!;
    return { url, callback: new URLSearchParams({ state: url.searchParams.get('state')!, iss: TOKENTOSEA_ISSUER, code: 'test-code' }) };
  }
  return { identity, begin, dataDir, counters: () => ({ exchanges, refreshes, revokes }), block: (value: Promise<void>) => { blocker = value; }, advance: () => { now += 901_000; }, cleanup: () => rm(dataDir, { recursive: true, force: true }) };
}
describe('TokenToSea public-client identity', () => {
  it('keeps an official model stream alive beyond two minutes without weakening read or caller deadlines', async () => {
    const h = await harness({}, async (url, init) => {
      if (!String(url).endsWith('/stream')) return Response.json({});
      return new Promise<Response>((resolve, reject) => {
        const timer = setTimeout(() => resolve(new Response('data: [DONE]\n\n')), 125_000);
        init?.signal?.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason); }, { once: true });
      });
    });
    try {
      const { callback } = await h.begin(); await h.identity.complete(callback);
      vi.useFakeTimers();
      const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(ms => {
        const controller = new AbortController(); setTimeout(() => controller.abort(new DOMException('Timeout', 'TimeoutError')), ms); return controller.signal;
      });
      const pending = h.identity.service('browser-one', 'official/runs/test-run/stream', 'POST', { input: {} }).then(response => ({ ok: response.ok }), () => ({ ok: false }));
      await vi.advanceTimersByTimeAsync(125_000);
      expect(await pending).toEqual({ ok: true });
      expect(timeout).toHaveBeenLastCalledWith(1_200_000);
      await h.identity.service('browser-one', 'wallet', 'GET');
      expect(timeout).toHaveBeenLastCalledWith(120_000);
      const controller = new AbortController();
      const cancelled = h.identity.service('browser-one', 'official/runs/test-run/stream', 'POST', {}, {}, controller.signal).catch(error => error);
      await vi.advanceTimersByTimeAsync(1); controller.abort(new Error('user_cancelled'));
      expect((await cancelled).message).toBe('user_cancelled');
    } finally { vi.restoreAllMocks(); vi.useRealTimers(); await h.cleanup(); }
  });
  it('uses S256, verifies signed identity, rotates refresh once and persists private sessions', async () => {
    const h = await harness();
    try {
      const { url, callback } = await h.begin();
      expect(url.origin + url.pathname).toBe(`${TOKENTOSEA_ISSUER}/authorize`);
      expect(url.searchParams.get('code_challenge_method')).toBe('S256');
      expect(url.searchParams.get('scope')).toBe(TOKENTOSEA_SCOPES);
      await h.identity.complete(callback);
      expect((await h.identity.session('browser-one'))?.name).toBe('测试用户');
      expect(await h.identity.session('browser-two')).toBeNull();
      await expect(h.identity.complete(callback)).rejects.toThrow('授权状态');
      h.advance(); await Promise.all([h.identity.session('browser-one'), h.identity.session('browser-one')]);
      expect(h.counters().refreshes).toBe(1);
      const file = path.join(h.dataDir, 'identity/tokentosea.json');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      const reloaded = new TokenToSeaIdentity({ dataDir: h.dataDir });
      expect((await reloaded.session('browser-one'))?.name).toBe('测试用户');
    } finally { await h.cleanup(); }
  });
  it.each([
    ['a network failure', () => { throw new TypeError('fetch failed'); }],
    ['a server error', () => new Response('upstream down', { status: 503 })],
    ['rate limiting', () => new Response('slow down', { status: 429 })],
    ['a malformed answer', () => Response.json({ unexpected: true })],
  ])('keeps the sign-in through %s while refreshing, and refreshes once the service answers', async (_name, failure) => {
    let failing = true;
    const h = await harness({}, undefined, () => (failing ? failure() : Response.json({ access_token: 'rotated-access', refresh_token: 'rotated-refresh', expires_in: 900 })));
    try {
      const { callback } = await h.begin();
      await h.identity.complete(callback);
      h.advance();
      expect((await h.identity.session('browser-one'))?.name).toBe('测试用户');
      expect(h.identity.error('browser-one')).toBeFalsy();
      const reloaded = new TokenToSeaIdentity({ dataDir: h.dataDir, now: () => 1_800_000_000_000 });
      expect((await reloaded.session('browser-one'))?.name).toBe('测试用户');
      failing = false;
      expect((await h.identity.session('browser-one'))?.name).toBe('测试用户');
      expect(h.counters().refreshes).toBe(2);
    } finally { await h.cleanup(); }
  });

  it.each([400, 401, 403])('ends the sign-in when the token endpoint refuses the grant (%s)', async (status) => {
    const h = await harness({}, undefined, () => Response.json({ error: 'invalid_grant' }, { status }));
    try {
      const { callback } = await h.begin();
      await h.identity.complete(callback);
      h.advance();
      expect(await h.identity.session('browser-one')).toBeNull();
      expect(h.identity.error('browser-one')).toBe('登录已过期，请重新登录');
      expect(await new TokenToSeaIdentity({ dataDir: h.dataDir }).session('browser-one')).toBeNull();
    } finally { await h.cleanup(); }
  });

  it('rejects invalid nonce before accepting userinfo', async () => {
    const h = await harness({ nonce: 'wrong-nonce' });
    try { const { callback } = await h.begin(); await expect(h.identity.complete(callback)).rejects.toThrow('身份令牌校验失败'); expect(await h.identity.session('browser-one')).toBeNull(); }
    finally { await h.cleanup(); }
  });
  it('does not restore a session when sign-out cancels an in-flight exchange', async () => {
    const h = await harness();
    try {
      let release!: () => void; h.block(new Promise(resolve => { release = resolve; }));
      const { callback } = await h.begin();
      const completing = h.identity.complete(callback);
      await h.identity.logout('browser-one'); release();
      await expect(completing).rejects.toThrow('本次授权已取消');
      expect(await h.identity.session('browser-one')).toBeNull();
      expect(h.counters().revokes).toBe(1);
    } finally { await h.cleanup(); }
  });
});
