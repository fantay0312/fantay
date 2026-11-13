import { createHash, createPublicKey, randomBytes, verify, type JsonWebKey, type KeyObject } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, readFile, rename, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import type { TokenToSeaUser } from '@open-design/contracts';
import { renderCallbackPage, type CallbackPageDetail, type RenderedCallbackPage } from './callback-page.js';

export { renderCallbackPage, type CallbackPageDetail, type RenderedCallbackPage };

export const TOKENTOSEA_ISSUER = 'https://tokentosea.com/api/oauth';
/** Production connect services: models, wallet, grant, tools, official runs, chat and `fantay/identity`. */
export const TOKENTOSEA_CONNECT_BASE = 'https://tokentosea.com/api/v1/connect';
/** Production design service (`apps/share`): shares, comments, collaboration, stock search. */
export const TOKENTOSEA_DESIGN_BASE = 'https://design.tokentosea.com/api';
export const TOKENTOSEA_CALLBACK = 'http://127.0.0.1:47654/callback';
export const TOKENTOSEA_SCOPES = 'openid profile email offline_access tools:read tools:invoke models:read models:invoke wallet:read';
const FLOW_TTL = 10 * 60_000;
const JWKS_TTL = 5 * 60_000;
const SESSION_TTL = 30 * 24 * 60 * 60_000;
const random = () => randomBytes(32).toString('base64url');
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');
/** OAuth token endpoint answers that end a grant (RFC 6749 §5.2: invalid_grant/invalid_client). */
const isRefreshRejection = (status: number) => status === 400 || status === 401 || status === 403;

interface TokenResponse { access_token: string; refresh_token?: string; id_token?: string; expires_in: number; }
interface Session { user: TokenToSeaUser; accessToken: string; refreshToken?: string; expiresAt: number; validUntil: number; clientId: string; }
interface Flow { session: string; verifier: string; nonce: string; expiresAt: number; clientId: string; redirectUri: string; generation: number; configuration: number; }
interface Saved { clientId?: string; sessions: Record<string, Session>; }
/**
 * Where one identity sends OAuth, connect and design traffic. Every omitted
 * field keeps its production value. The package only enforces transport
 * shape (HTTPS, or HTTP on loopback); whether an override is allowed at all is
 * the caller's policy, never this package's.
 */
export interface TokenToSeaEndpoints { issuer?: string; connectBase?: string; designBase?: string; }
export type ResolvedTokenToSeaEndpoints = Readonly<Required<TokenToSeaEndpoints>>;
interface Options { dataDir: string; clientId?: string; redirectUri?: string; scopes?: string; fetch?: typeof fetch; now?: () => number; endpoints?: TokenToSeaEndpoints; }

const isLoopbackHttp = (url: URL) => url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
function endpointBase(value: string, name: keyof TokenToSeaEndpoints): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' && !isLoopbackHttp(url)) throw new Error(`TokenToSea ${name} requires HTTPS or loopback HTTP`);
  if (url.username || url.password || url.search || url.hash) throw new Error(`Invalid TokenToSea ${name}`);
  return url.href.replace(/\/+$/, '');
}
function resolveEndpoints(endpoints: TokenToSeaEndpoints = {}): ResolvedTokenToSeaEndpoints {
  return Object.freeze({
    issuer: endpoints.issuer === undefined ? TOKENTOSEA_ISSUER : endpointBase(endpoints.issuer, 'issuer'),
    connectBase: endpoints.connectBase === undefined ? TOKENTOSEA_CONNECT_BASE : endpointBase(endpoints.connectBase, 'connectBase'),
    designBase: endpoints.designBase === undefined ? TOKENTOSEA_DESIGN_BASE : endpointBase(endpoints.designBase, 'designBase'),
  });
}

export class TokenToSeaIdentity {
  private readonly file: string;
  private readonly request: typeof fetch;
  private readonly now: () => number;
  private saved: Saved = { sessions: {} };
  private readonly flows = new Map<string, Flow>();
  private readonly failures = new Map<string, string>();
  private readonly refreshes = new Map<string, Promise<Session | null>>();
  private listener: Server | null = null;
  private listenerStarting: Promise<void> | null = null;
  private listenerTimer: ReturnType<typeof setTimeout> | null = null;
  private generations = new Map<string, number>();
  private configuration = 0;
  private jwksCache: { expiresAt: number; keys: Map<string, KeyObject> } | null = null;
  private writes: Promise<void> = Promise.resolve();
  private readonly ready: Promise<void>;
  readonly redirectUri: string;
  readonly endpoints: ResolvedTokenToSeaEndpoints;

  constructor(private readonly options: Options) {
    this.file = path.join(options.dataDir, 'identity', 'tokentosea.json');
    this.request = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.endpoints = resolveEndpoints(options.endpoints);
    this.redirectUri = options.redirectUri ?? TOKENTOSEA_CALLBACK;
    const redirect = new URL(this.redirectUri);
    if (redirect.protocol !== 'https:' && !isLoopbackHttp(redirect)) throw new Error('TokenToSea callback requires HTTPS or loopback HTTP');
    if (redirect.username || redirect.password || redirect.search || redirect.hash) throw new Error('Invalid TokenToSea callback');
    this.ready = this.load();
  }

  private async load(): Promise<void> {
    try {
      const value = JSON.parse(await readFile(this.file, 'utf8')) as Saved;
      if (value.sessions && typeof value.sessions === 'object') this.saved = value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }

  private persist(): Promise<void> {
    const value = JSON.stringify(this.saved);
    const write = this.writes.then(async () => {
      await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const temp = `${this.file}.tmp`;
      await writeFile(temp, value, { mode: 0o600 });
      await rename(temp, this.file);
      await chmod(this.file, 0o600);
    });
    this.writes = write.catch(() => undefined);
    return write;
  }

  async clientId(): Promise<string | null> {
    await this.ready;
    return this.options.clientId?.trim() || this.saved.clientId || 'fantay-design';
  }

  async configure(clientId: string): Promise<void> {
    await this.ready;
    if (!/^[A-Za-z0-9_-]{8,160}$/.test(clientId)) throw new Error('请填写 TokenToSea 为 Fantay 分配的 Client ID');
    if (this.options.clientId) throw new Error('Client ID 由启动配置管理');
    this.saved.clientId = clientId;
    this.configuration += 1;
    this.jwksCache = null;
    this.flows.clear();
    await this.persist();
  }

  private prune(): void {
    for (const [state, flow] of this.flows) {
      if (flow.expiresAt <= this.now()) {
        this.flows.delete(state);
        this.failures.set(flow.session, '授权已超时，请重新登录');
      }
    }
  }

  pending(session: string): boolean {
    this.prune();
    const sessionId = digest(session);
    for (const flow of this.flows.values()) {
      if (flow.session === sessionId) return true;
    }
    return false;
  }

  error(session: string): string | undefined { return this.failures.get(digest(session)); }

  async begin(session: string): Promise<string> {
    const clientId = await this.clientId();
    if (!clientId) throw new Error('请先登记 Fantay 的 TokenToSea 应用并配置 Client ID');
    this.prune();
    const sessionId = digest(session);
    for (const [state, flow] of this.flows) if (flow.session === sessionId) this.flows.delete(state);
    this.failures.delete(sessionId);
    if (this.redirectUri === TOKENTOSEA_CALLBACK) await this.listen();
    const state = random();
    const verifier = random();
    const nonce = random();
    const generation = (this.generations.get(sessionId) ?? 0) + 1;
    this.generations.set(sessionId, generation);
    this.flows.set(state, { session: sessionId, verifier, nonce, expiresAt: this.now() + FLOW_TTL, clientId, redirectUri: this.redirectUri, generation, configuration: this.configuration });
    if (this.listener) {
      if (this.listenerTimer) clearTimeout(this.listenerTimer);
      this.listenerTimer = setTimeout(() => this.close(), FLOW_TTL + 5000);
      this.listenerTimer.unref();
    }
    const url = new URL(`${this.endpoints.issuer}/authorize`);
    url.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: this.redirectUri, scope: this.options.scopes ?? TOKENTOSEA_SCOPES, state, nonce, code_challenge: digest(verifier), code_challenge_method: 'S256' }).toString();
    return url.href;
  }

  private async listen(): Promise<void> {
    if (this.listener) return;
    if (this.listenerStarting) return this.listenerStarting;
    this.listenerStarting = this.startListener();
    try { await this.listenerStarting; } finally { this.listenerStarting = null; }
  }

  private async startListener(): Promise<void> {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', TOKENTOSEA_CALLBACK);
      if (req.method !== 'GET' || url.pathname !== '/callback') { res.writeHead(404).end(); return; }
      void this.complete(url.searchParams).then(
        user => this.resultPage(res, true, { user }),
        (error: unknown) => this.resultPage(res, false, { error: error instanceof Error ? error.message : undefined }),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(47654, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    }).catch(() => { throw new Error('登录回调端口 47654 正在使用，请关闭另一处 Fantay 登录后重试'); });
    this.listener = server;
    server.unref();
  }

  resultPage(res: import('node:http').ServerResponse, ok: boolean, detail?: CallbackPageDetail): void {
    const { html, csp } = renderCallbackPage(ok, detail);
    res.writeHead(ok ? 200 : 400, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': csp,
      'Referrer-Policy': 'no-referrer',
    });
    res.end(html);
  }

  private async json(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const response = await this.request(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
    if (!response.ok) throw new Error('TokenToSea 暂时无法完成授权，请重试');
    return await response.json() as Record<string, unknown>;
  }

  private async resolveSigningKey(kid: string): Promise<KeyObject | null> {
    const now = this.now();
    if (this.jwksCache && this.jwksCache.expiresAt > now) {
      const cached = this.jwksCache.keys.get(kid);
      if (cached) return cached;
    }
    const jwks = await this.json(`${this.endpoints.issuer}/jwks`);
    const items = Array.isArray(jwks.keys) ? jwks.keys as Array<JsonWebKey & { kid?: string }> : [];
    const keys = new Map<string, KeyObject>();
    for (const item of items) {
      if (typeof item.kid === 'string' && item.kty === 'RSA') {
        try {
          keys.set(item.kid, createPublicKey({ key: item, format: 'jwk' }));
        } catch {
          // Ignore malformed unrelated JWKs while preserving strict verification on the requested kid.
        }
      }
    }
    this.jwksCache = { expiresAt: this.now() + JWKS_TTL, keys };
    return keys.get(kid) ?? null;
  }

  private async validateIdToken(token: string, flow: Flow): Promise<string> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('身份令牌格式无效');
    const header = JSON.parse(Buffer.from(parts[0]!, 'base64url').toString()) as { alg?: string; kid?: string };
    const claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString()) as Record<string, unknown>;
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new Error('身份签名算法无效');
    const key = await this.resolveSigningKey(header.kid);
    if (!key || !verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`), key, Buffer.from(parts[2]!, 'base64url'))) throw new Error('身份签名校验失败');
    const now = this.now() / 1000;
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== this.endpoints.issuer || !audience.includes(flow.clientId) || (audience.length > 1 && claims.azp !== flow.clientId) || claims.nonce !== flow.nonce || typeof claims.exp !== 'number' || claims.exp <= now || typeof claims.iat !== 'number' || claims.iat > now + 60 || typeof claims.sub !== 'string' || !claims.sub) throw new Error('身份令牌校验失败');
    return claims.sub;
  }

  async complete(params: URLSearchParams): Promise<TokenToSeaUser> {
    this.prune();
    const state = params.get('state') ?? '';
    const flow = this.flows.get(state);
    if (!flow) throw new Error('授权状态无效或已使用');
    this.flows.delete(state); // Consume before any asynchronous work or token exchange.
    try {
      if (params.get('error')) throw new Error('你取消了 TokenToSea 授权，请重新登录');
      if (params.get('iss') !== this.endpoints.issuer) throw new Error('授权来源校验失败');
      const code = params.get('code');
      if (!code || code.length > 4096) throw new Error('缺少有效授权码');
      const tokens = await this.json(`${this.endpoints.issuer}/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: flow.clientId, redirect_uri: flow.redirectUri, code, code_verifier: flow.verifier }) });
      if (typeof tokens.access_token !== 'string' || typeof tokens.id_token !== 'string' || typeof tokens.expires_in !== 'number') throw new Error('授权响应不完整');
      const sub = await this.validateIdToken(tokens.id_token, flow);
      const user = await this.json(`${this.endpoints.issuer}/userinfo`, { headers: { Authorization: `Bearer ${tokens.access_token}` } });
      if (user.sub !== sub) throw new Error('账户身份不一致');
      if (this.generations.get(flow.session) !== flow.generation || this.configuration !== flow.configuration) {
        await this.json(`${this.endpoints.issuer}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: flow.clientId, token: String(tokens.refresh_token ?? tokens.access_token) }) }).catch(() => undefined);
        throw new Error('本次授权已取消');
      }
      const savedUser: TokenToSeaUser = {
        id: `${this.endpoints.issuer}|${sub}`,
        name: typeof user.name === 'string' ? user.name : 'TokenToSea 用户',
        ...(typeof user.email === 'string' ? { email: user.email } : {}),
        ...(typeof user.picture === 'string' && user.picture.startsWith('https://') ? { picture: user.picture } : {}),
      };
      this.saved.sessions[flow.session] = {
        user: savedUser,
        accessToken: tokens.access_token, ...(typeof tokens.refresh_token === 'string' ? { refreshToken: tokens.refresh_token } : {}),
        expiresAt: this.now() + Math.min(tokens.expires_in, 900) * 1000, validUntil: this.now() + SESSION_TTL, clientId: flow.clientId,
      };
      await this.persist();
      return savedUser;
    } catch (error) {
      if (this.generations.get(flow.session) === flow.generation && this.configuration === flow.configuration) this.failures.set(flow.session, error instanceof Error ? error.message : '登录未完成');
      throw error;
    }
  }

  /**
   * A session is usable only against the issuer that minted it, so tokens
   * persisted under one set of endpoints are never sent to another.
   */
  private minted(session: Session): boolean { return session.user.id.startsWith(`${this.endpoints.issuer}|`); }

  async session(raw: string): Promise<TokenToSeaUser | null> {
    await this.ready;
    const key = digest(raw);
    const session = this.saved.sessions[key];
    if (!session || !this.minted(session)) return null;
    if (session.validUntil <= this.now()) { delete this.saved.sessions[key]; await this.persist(); return null; }
    if (session.expiresAt > this.now() + 30_000) return session.user;
    let pending = this.refreshes.get(key);
    if (!pending) {
      pending = this.refresh(key, session);
      this.refreshes.set(key, pending);
      void pending.then(() => this.refreshes.delete(key), () => this.refreshes.delete(key));
    }
    return (await pending)?.user ?? null;
  }

  private async refresh(key: string, session: Session): Promise<Session | null> {
    if (!session.refreshToken) { delete this.saved.sessions[key]; await this.persist(); return null; }
    let response: Response;
    try {
      response = await this.request(`${this.endpoints.issuer}/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken }),
        redirect: 'error',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      // Unreachable or timed out: the grant may still be good. Keep the
      // session; the next request with a stale access token retries.
      return this.saved.sessions[key] === session ? session : null;
    }
    if (isRefreshRejection(response.status)) {
      // The authorization server refused the grant (revoked, expired or
      // already rotated): only then is the sign-in really over.
      if (this.saved.sessions[key] !== session) return null;
      delete this.saved.sessions[key];
      this.failures.set(key, '登录已过期，请重新登录');
      await this.persist();
      return null;
    }
    let token: Record<string, unknown> | null = null;
    if (response.ok) {
      try { token = await response.json() as Record<string, unknown>; } catch { token = null; }
    }
    if (!token || typeof token.access_token !== 'string' || typeof token.refresh_token !== 'string' || typeof token.expires_in !== 'number') {
      // A 5xx/429 or a malformed answer says nothing about the grant.
      return this.saved.sessions[key] === session ? session : null;
    }
    if (this.saved.sessions[key] !== session) return null; // A sign-out wins over an in-flight refresh.
    Object.assign(session, { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: this.now() + Math.min(token.expires_in, 900) * 1000, validUntil: this.now() + SESSION_TTL });
    await this.persist();
    return session;
  }

  async logout(raw: string): Promise<void> {
    await this.ready;
    const key = digest(raw);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
    const session = this.saved.sessions[key];
    delete this.saved.sessions[key];
    for (const [state, flow] of this.flows) if (flow.session === key) this.flows.delete(state);
    this.failures.delete(key);
    await this.persist();
    if (session && this.minted(session)) await this.json(`${this.endpoints.issuer}/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: session.clientId, token: session.refreshToken ?? session.accessToken }) }).catch(() => undefined);
  }

  /** Fresh authority check for public writes; cached local identity is not sufficient. */
  async verifiedUser(raw: string): Promise<TokenToSeaUser | null> {
    if (!await this.session(raw)) return null;
    const current = this.saved.sessions[digest(raw)];
    if (!current) return null;
    const info = await this.json(`${this.endpoints.connectBase}/fantay/identity`, {
      headers: { Authorization: `Bearer ${current.accessToken}` },
    });
    if (info.issuer !== this.endpoints.issuer || info.client_id !== 'fantay-design'
      || typeof info.sub !== 'string' || `${this.endpoints.issuer}|${info.sub}` !== current.user.id) {
      throw new Error('TokenToSea 账号验证失败，请重新登录');
    }
    return { id: current.user.id, name: typeof info.name === 'string' ? info.name : current.user.name };
  }

  /** The only public-sharing destination. Credentials never cross into the renderer. */
  async share(raw: string, resource: string, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', body?: unknown, signal?: AbortSignal, expectedUserId?: string): Promise<Response> {
    if (!/^(stock-search|collaboration|shares(?:\/[a-zA-Z0-9_-]+(?:\/(?:state|comments))?)?|comments\/[a-zA-Z0-9_-]+)$/.test(resource)) throw new Error('无效的分享路径');
    if (!await this.session(raw)) throw new Error('请先使用 TokenToSea 登录');
    const current = this.saved.sessions[digest(raw)];
    if (!current) throw new Error('登录已过期');
    if (expectedUserId && current.user.id !== expectedUserId) throw new Error('TokenToSea 账号已变化，请重新发起操作');
    return this.request(`${this.endpoints.designBase}/${resource}`, {
      method, headers: { Authorization: `Bearer ${current.accessToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(resource === 'stock-search' ? 185_000 : 90_000)]) : AbortSignal.timeout(resource === 'stock-search' ? 185_000 : 90_000),
    });
  }

  /** Keep upstream credentials inside the daemon; never return them to renderer or agents. */
  async service(raw: string, resource: string, method: 'GET' | 'POST', body?: unknown, query: Record<string, unknown> = {}, signal?: AbortSignal, expectedUserId?: string): Promise<Response> {
    const allowedRead = /^(models|wallet|grant|tools|official\/(catalog|status|runs))$|^tools\/[\w.-]+\/actions$|^(tools|models)\/runs\/[\w-]+$|^official\/(runs\/[\w-]+(\/(output|assets\/asset_[a-f0-9]{64}))?|resources\/[\w-]+(\/content)?)$/;
    const allowedWrite = /^(chat\/completions|tools\/(quote|describe|invoke)|official\/prepare|official\/runs\/[\w-]+\/(invoke|stream|cancel|ticket))$/;
    if (!(method === 'GET' ? allowedRead : allowedWrite).test(resource)) throw new Error('不支持的 TokenToSea 服务路径');
    if (!await this.session(raw)) throw new Error('请先使用 TokenToSea 登录');
    const current = this.saved.sessions[digest(raw)];
    if (!current) throw new Error('登录已过期');
    if (expectedUserId && current.user.id !== expectedUserId) throw new Error('TokenToSea 账号已变化，请重新发起操作');
    const url = new URL(`${this.endpoints.connectBase}/${resource}`);
    for (const [key, value] of Object.entries(query)) {
      if (method !== 'GET' || !['q', 'offset', 'category', 'saved', 'featured', 'includeOfficial'].includes(key) || typeof value !== 'string' || value.length > 160) throw new Error('无效的查询参数');
      url.searchParams.set(key, value);
    }
    const longStream = method === 'POST' && /^official\/runs\/[\w-]+\/stream$/.test(resource);
    return this.request(url, {
      method, headers: { Authorization: `Bearer ${current.accessToken}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), redirect: 'error',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(1_200_000)]) : AbortSignal.timeout(longStream ? 1_200_000 : 120_000),
    });
  }

  close(): void { if (this.listenerTimer) clearTimeout(this.listenerTimer); this.listenerTimer = null; this.listener?.close(); this.listener = null; }
}
