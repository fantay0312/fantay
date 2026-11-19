// SPDX-License-Identifier: AGPL-3.0-only
// Single sign-on: an OpenID Connect relying party (authorization code flow with PKCE), nothing more.
// The provider answers one question: who is signing in. What that person may do is decided here, by their role.
import { createHash, createPublicKey, randomBytes, verify as verifySignature, type JsonWebKey } from 'node:crypto';
import { OrgError } from './store.js';
import type { SsoProfile, SsoSettings } from './service.js';

type Fetch = typeof fetch;
interface Discovery { authorization_endpoint: string; token_endpoint: string; jwks_uri: string }
interface Pending { nonce: string; verifier: string; expires: number }
type Jwk = JsonWebKey & { kid?: string; use?: string; alg?: string };

const TEN_MINUTES = 600_000;
const SKEW_MS = 60_000;
const base64url = (bytes: Buffer) => bytes.toString('base64url');
const failed = (code: string, message: string) => new OrgError(502, code, message);
const refused = (message: string) => new OrgError(403, 'ORG_SSO_REJECTED', message);
const sameIssuer = (a: string, b: string) => a.replace(/\/+$/, '') === b.replace(/\/+$/, '');

/** A provider endpoint must be HTTPS. Plain HTTP is accepted only on loopback, for a provider run on the same host. */
function endpoint(value: unknown, name: string): string {
  let url: URL;
  try { url = new URL(String(value)); } catch { throw failed('ORG_SSO_PROVIDER', `身份提供方的 ${name} 无效`); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname);
  if (url.username || url.password || !(url.protocol === 'https:' || url.protocol === 'http:' && loopback))
    throw failed('ORG_SSO_PROVIDER', `身份提供方的 ${name} 必须使用 HTTPS`);
  return url.toString();
}

export class OidcClient {
  private readonly discovery = new Map<string, { value: Discovery; until: number }>();
  private readonly keys = new Map<string, { value: Jwk[]; until: number }>();
  private readonly pending = new Map<string, Pending>();
  constructor(private readonly fetcher: Fetch = fetch, private readonly now: () => number = Date.now) {}

  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    } catch {
      throw failed('ORG_SSO_PROVIDER', '无法连接身份提供方');
    }
    const body = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !body || typeof body !== 'object') throw failed('ORG_SSO_PROVIDER', '身份提供方返回了错误');
    return body;
  }
  private async discover(issuer: string): Promise<Discovery> {
    const cached = this.discovery.get(issuer);
    if (cached && cached.until > this.now()) return cached.value;
    const document = await this.json(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`);
    // A discovery document that names another issuer is not this provider's (RFC 8414 section 3.3).
    if (typeof document.issuer !== 'string' || !sameIssuer(document.issuer, issuer)) throw failed('ORG_SSO_PROVIDER', '身份提供方的发现文档与配置的地址不一致');
    const value: Discovery = {
      authorization_endpoint: endpoint(document.authorization_endpoint, '授权地址'),
      token_endpoint: endpoint(document.token_endpoint, '令牌地址'),
      jwks_uri: endpoint(document.jwks_uri, '公钥地址'),
    };
    this.discovery.set(issuer, { value, until: this.now() + TEN_MINUTES });
    return value;
  }
  private async jwks(uri: string, fresh: boolean): Promise<Jwk[]> {
    const cached = this.keys.get(uri);
    if (!fresh && cached && cached.until > this.now()) return cached.value;
    const document = await this.json(uri);
    const value = Array.isArray(document.keys) ? document.keys as Jwk[] : [];
    this.keys.set(uri, { value, until: this.now() + TEN_MINUTES });
    return value;
  }

  /** Starts a sign-in: returns where to send the browser. `state` ties the callback to this attempt, the nonce ties
   *  the ID token to it, and the PKCE verifier stays here so a stolen code is useless elsewhere. */
  async begin(settings: SsoSettings, redirectUri: string): Promise<string> {
    const at = this.now();
    for (const [key, entry] of this.pending) if (entry.expires < at) this.pending.delete(key);
    if (this.pending.size >= 2000) throw new OrgError(429, 'ORG_RATE_LIMITED', '登录请求过多，请稍后再试');
    const { authorization_endpoint } = await this.discover(settings.issuer);
    const state = base64url(randomBytes(24)), nonce = base64url(randomBytes(24)), verifier = base64url(randomBytes(48));
    this.pending.set(state, { nonce, verifier, expires: at + TEN_MINUTES });
    const url = new URL(authorization_endpoint);
    for (const [key, value] of Object.entries({
      response_type: 'code', client_id: settings.clientId, redirect_uri: redirectUri, scope: 'openid email profile',
      state, nonce, code_challenge: base64url(createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256',
    })) url.searchParams.set(key, value);
    return url.toString();
  }

  /** Finishes a sign-in: trades the code for an ID token and checks everything the token claims. */
  async complete(settings: SsoSettings, redirectUri: string, state: string, code: string): Promise<SsoProfile> {
    const attempt = this.pending.get(state);
    this.pending.delete(state);                                 // a state works once
    if (!attempt || attempt.expires < this.now()) throw refused('登录请求已过期，请重新开始');
    const { token_endpoint, jwks_uri } = await this.discover(settings.issuer);
    const tokens = await this.json(token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: settings.clientId,
        client_secret: settings.clientSecret, code_verifier: attempt.verifier,
      }).toString(),
    });
    if (typeof tokens.id_token !== 'string') throw failed('ORG_SSO_PROVIDER', '身份提供方没有返回身份令牌');
    const claims = await this.verify(tokens.id_token, jwks_uri);
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (typeof claims.iss !== 'string' || !sameIssuer(claims.iss, settings.issuer)) throw refused('身份令牌的签发方不符');
    if (!audience.includes(settings.clientId) || audience.length > 1 && claims.azp !== settings.clientId) throw refused('身份令牌不是签发给这个应用的');
    if (typeof claims.exp !== 'number' || claims.exp * 1000 < this.now() - SKEW_MS) throw refused('身份令牌已过期');
    if (typeof claims.iat === 'number' && claims.iat * 1000 > this.now() + SKEW_MS) throw refused('身份令牌的签发时间无效');
    if (claims.nonce !== attempt.nonce) throw refused('身份令牌与本次登录不匹配');
    if (typeof claims.sub !== 'string' || !claims.sub) throw refused('身份令牌缺少用户标识');
    if (typeof claims.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(claims.email)) throw refused('身份提供方没有提供邮箱');
    if (claims.email_verified === false || claims.email_verified === 'false') throw refused('邮箱尚未在身份提供方验证');
    return { subject: claims.sub, email: claims.email, name: typeof claims.name === 'string' ? claims.name : '' };
  }

  /** Verifies the token's signature with the provider's published keys. Only asymmetric algorithms are accepted, so a
   *  token can never be "signed" with the client secret or with no key at all. */
  private async verify(token: string, jwksUri: string): Promise<Record<string, unknown>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw refused('身份令牌格式无效');
    let header: { alg?: string; kid?: string }, claims: Record<string, unknown>;
    try {
      header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString('utf8')) as { alg?: string; kid?: string };
      claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
    } catch { throw refused('身份令牌格式无效'); }
    const kind = header.alg === 'RS256' ? 'RSA' : header.alg === 'ES256' ? 'EC' : null;
    if (!kind) throw refused('身份令牌使用了不支持的签名算法');
    const pick = (keys: Jwk[]) => keys.filter(key => key.kty === kind && key.use !== 'enc' && (header.kid ? key.kid === header.kid : true));
    let candidates = pick(await this.jwks(jwksUri, false));
    if (!candidates.length) candidates = pick(await this.jwks(jwksUri, true));        // the provider rotated its keys
    const data = Buffer.from(`${parts[0]}.${parts[1]}`);
    const signature = Buffer.from(parts[2]!, 'base64url');
    const valid = candidates.some(jwk => {
      try {
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        return kind === 'RSA' ? verifySignature('RSA-SHA256', data, key, signature)
          : verifySignature('SHA256', data, { key, dsaEncoding: 'ieee-p1363' }, signature);
      } catch { return false; }
    });
    if (!valid) throw refused('身份令牌签名无效');
    return claims;
  }
}
