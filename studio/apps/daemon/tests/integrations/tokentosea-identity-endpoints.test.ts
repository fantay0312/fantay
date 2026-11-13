import { afterEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TokenToSeaIdentity, TOKENTOSEA_CONNECT_BASE, TOKENTOSEA_DESIGN_BASE, TOKENTOSEA_ISSUER,
  type TokenToSeaEndpoints,
} from '../../src/integrations/tokentosea.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'endpoint-key' };
const clientId = 'fantay-design';
const start = 1_800_000_000_000;
const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });

function jwt(iss: string, nonce: string, now: number): string {
  const body = [
    Buffer.from(JSON.stringify({ alg: 'RS256', kid: 'endpoint-key' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss, aud: clientId, sub: 'user-1', nonce, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + 900 })).toString('base64url'),
  ].join('.');
  return `${body}.${sign('RSA-SHA256', Buffer.from(body), keys.privateKey).toString('base64url')}`;
}

/** A TokenToSea stand-in behind an injected fetch that records every URL the identity requests. */
async function harness(endpoints?: TokenToSeaEndpoints, dataDir?: string) {
  const folder = dataDir ?? await mkdtemp(path.join(tmpdir(), 'tts-endpoints-'));
  if (!dataDir) folders.push(folder);
  let now = start;
  let nonce = '';
  let idTokenIssuer = '';
  const calls: string[] = [];
  const identityIssuer = () => identity.endpoints.issuer;
  const request: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    calls.push(url);
    const pathname = new URL(url).pathname;
    if (pathname.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (pathname.endsWith('/userinfo')) return Response.json({ sub: 'user-1', name: 'Tester' });
    if (pathname.endsWith('/revoke')) return Response.json({});
    if (pathname.endsWith('/fantay/identity')) return Response.json({ issuer: identityIssuer(), client_id: clientId, sub: 'user-1', name: 'Tester' });
    if (pathname.endsWith('/token')) {
      const params = init?.body as URLSearchParams;
      if (params.get('grant_type') === 'refresh_token') return Response.json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 900 });
      return Response.json({ access_token: 'access-1', refresh_token: 'refresh-1', expires_in: 900, id_token: jwt(idTokenIssuer || identityIssuer(), nonce, now) });
    }
    return Response.json({ ok: true });
  };
  const identity = new TokenToSeaIdentity({
    dataDir: folder, clientId, redirectUri: 'https://fantay.example/api/tokentosea/callback', fetch: request, now: () => now,
    ...(endpoints ? { endpoints } : {}),
  });
  async function signIn(callbackIssuer = identity.endpoints.issuer) {
    const authorize = new URL(await identity.begin('browser'));
    nonce = authorize.searchParams.get('nonce')!;
    await identity.complete(new URLSearchParams({ state: authorize.searchParams.get('state')!, iss: callbackIssuer, code: 'code-1' }));
    return authorize;
  }
  /** Drive every endpoint family: OAuth exchange, identity check, design, connect reads/writes, refresh, revoke. */
  async function exercise() {
    const authorize = await signIn();
    const user = await identity.session('browser');
    await identity.verifiedUser('browser');
    await identity.share('browser', 'collaboration', 'POST', { operation: 'workspace.get' });
    await identity.service('browser', 'wallet', 'GET');
    await identity.service('browser', 'chat/completions', 'POST', { model: 'm' });
    now += 901_000; await identity.session('browser');
    await identity.logout('browser');
    return { authorize: `${authorize.origin}${authorize.pathname}`, userId: user?.id };
  }
  return { identity, calls, folder, signIn, exercise, issueIdTokenFrom: (iss: string) => { idTokenIssuer = iss; } };
}

describe('TokenToSea identity endpoints', () => {
  it('keeps the default build on the production TokenToSea hosts', async () => {
    const h = await harness();
    expect(h.identity.endpoints).toEqual({ issuer: TOKENTOSEA_ISSUER, connectBase: TOKENTOSEA_CONNECT_BASE, designBase: TOKENTOSEA_DESIGN_BASE });
    const { authorize, userId } = await h.exercise();
    expect(authorize).toBe('https://tokentosea.com/api/oauth/authorize');
    expect(userId).toBe('https://tokentosea.com/api/oauth|user-1');
    expect(h.calls.map(url => url.split('?')[0])).toEqual([
      'https://tokentosea.com/api/oauth/token',
      'https://tokentosea.com/api/oauth/jwks',
      'https://tokentosea.com/api/oauth/userinfo',
      'https://tokentosea.com/api/v1/connect/fantay/identity',
      'https://design.tokentosea.com/api/collaboration',
      'https://tokentosea.com/api/v1/connect/wallet',
      'https://tokentosea.com/api/v1/connect/chat/completions',
      'https://tokentosea.com/api/oauth/token',
      'https://tokentosea.com/api/oauth/revoke',
    ]);
  });

  it('sends every request to the overridden bases and binds identity to the overridden issuer', async () => {
    const h = await harness({
      issuer: 'http://127.0.0.1:43210/api/oauth',
      connectBase: 'http://localhost:43211/api/v1/connect/',
      designBase: 'http://[::1]:43212/design/api',
    });
    expect(h.identity.endpoints).toEqual({
      issuer: 'http://127.0.0.1:43210/api/oauth', connectBase: 'http://localhost:43211/api/v1/connect', designBase: 'http://[::1]:43212/design/api',
    });
    const { authorize, userId } = await h.exercise();
    expect(authorize).toBe('http://127.0.0.1:43210/api/oauth/authorize');
    expect(userId).toBe('http://127.0.0.1:43210/api/oauth|user-1');
    expect(h.calls).toEqual([
      'http://127.0.0.1:43210/api/oauth/token',
      'http://127.0.0.1:43210/api/oauth/jwks',
      'http://127.0.0.1:43210/api/oauth/userinfo',
      'http://localhost:43211/api/v1/connect/fantay/identity',
      'http://[::1]:43212/design/api/collaboration',
      'http://localhost:43211/api/v1/connect/wallet',
      'http://localhost:43211/api/v1/connect/chat/completions',
      'http://127.0.0.1:43210/api/oauth/token',
      'http://127.0.0.1:43210/api/oauth/revoke',
    ]);
    expect(h.calls.some(url => url.includes('tokentosea.com'))).toBe(false);
  });

  it('rejects a production issuer on the callback or id_token once the issuer is overridden', async () => {
    const h = await harness({ issuer: 'http://127.0.0.1:43210/api/oauth' });
    await expect(h.signIn(TOKENTOSEA_ISSUER)).rejects.toThrow('授权来源校验失败');
    expect(h.calls).toEqual([]);
    h.issueIdTokenFrom(TOKENTOSEA_ISSUER);
    await expect(h.signIn()).rejects.toThrow('身份令牌校验失败');
    expect(await h.identity.session('browser')).toBeNull();
  });

  it('never sends a session minted by another issuer to the overridden endpoints', async () => {
    const production = await harness();
    await production.signIn();
    const local = await harness({ issuer: 'http://127.0.0.1:43210/api/oauth', connectBase: 'http://127.0.0.1:43210/api/v1/connect', designBase: 'http://127.0.0.1:43210/design/api' }, production.folder);
    expect(await local.identity.session('browser')).toBeNull();
    await expect(local.identity.share('browser', 'collaboration', 'POST', {})).rejects.toThrow('请先使用 TokenToSea 登录');
    await expect(local.identity.service('browser', 'wallet', 'GET')).rejects.toThrow('请先使用 TokenToSea 登录');
    expect(await local.identity.verifiedUser('browser')).toBeNull();
    expect(local.calls).toEqual([]);
    const reloaded = await harness(undefined, production.folder);
    expect((await reloaded.identity.session('browser'))?.id).toBe('https://tokentosea.com/api/oauth|user-1');
    await local.identity.logout('browser');
    expect(local.calls).toEqual([]);
  });

  it('refuses endpoint overrides that are plaintext off loopback or carry credentials, query or fragment', async () => {
    const dataDir = await mkdtemp(path.join(tmpdir(), 'tts-endpoints-')); folders.push(dataDir);
    expect(() => new TokenToSeaIdentity({ dataDir, endpoints: { issuer: 'http://tokentosea.example/api/oauth' } })).toThrow('requires HTTPS or loopback HTTP');
    expect(() => new TokenToSeaIdentity({ dataDir, endpoints: { connectBase: 'https://user:secret@tokentosea.example/api' } })).toThrow('Invalid TokenToSea connectBase');
    expect(() => new TokenToSeaIdentity({ dataDir, endpoints: { designBase: 'https://tokentosea.example/api?x=1' } })).toThrow('Invalid TokenToSea designBase');
    expect(() => new TokenToSeaIdentity({ dataDir, endpoints: { issuer: 'not a url' } })).toThrow();
  });
});
