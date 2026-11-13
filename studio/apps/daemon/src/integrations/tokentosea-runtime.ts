import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { TokenToSeaIdentity } from './tokentosea.js';
import { tokenToSeaEndpointsFromEnvironment } from './tokentosea-endpoints.js';
import type { TokenToSeaUser, AiUsageContext } from '@open-design/contracts';
import { AiUsageStore, UsageReceiptObserver } from './usage-store.js';
import { tokenToSeaNativeChat } from './tokentosea-native-chat.js';
import { applyTokenToSeaReasoning, resolveTokenToSeaReasoning, tokenToSeaReasoningOptions, type TokenToSeaReasoningEffort } from './tokentosea-reasoning.js';
import { tokenToSeaNativePath, tokenToSeaNativeProtocol, tokenToSeaUsesClaudeMessages, tokenToSeaClaudeIdentityConflict } from './tokentosea-claude.js';
export { tokenToSeaReasoningOptions, tokenToSeaInterleavedReasoning } from './tokentosea-reasoning.js';
export type { TokenToSeaReasoningEffort } from './tokentosea-reasoning.js';

export interface TokenToSeaModel {
  id: string;
  model: string;
  name?: string;
  provider?: string;
  priceVersion: string | number;
  maxOutputTokens?: number;
  outputLimitField?: string;
  reasoning?: { efforts: string[]; default?: string; maxOutputTokens?: number } | null;
  billingMode?: string;
  supportsTools?: boolean;
  toolCalling?: boolean;
  available?: boolean;
  modality?: string;
  executionKind?: string;
  examples?: Array<{ path: string; mode: string; body: Record<string, unknown> }>;
  [key: string]: unknown;
}
interface SessionContext { raw: string; user: TokenToSeaUser | null }
interface InferenceLease { session: SessionContext; model: TokenToSeaModel; reasoningEffort: TokenToSeaReasoningEffort; maxCostUsd: string; expires: number; abort: AbortController; usageContext: AiUsageContext }

/** Delegated chat without an explicit reasoning effort accepts at most 4096 output tokens. */
export function tokenToSeaAgentOutputLimit(model: TokenToSeaModel, reasoning: TokenToSeaReasoningEffort = 'off'): number {
  const thinking = reasoning !== 'off' && tokenToSeaReasoningOptions(model).some(option => option.id === reasoning);
  if (model.executionKind === 'official') {
    return typeof model.maxOutputTokens === 'number' && Number.isSafeInteger(model.maxOutputTokens) && model.maxOutputTokens > 0 ? model.maxOutputTokens : 4096;
  }
  const limit = thinking ? model.reasoning?.maxOutputTokens ?? model.maxOutputTokens : model.maxOutputTokens;
  const ceiling = thinking ? 65_536 : 4096;
  return typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0
    ? Math.min(limit, ceiling)
    : ceiling;
}

export function authorizedCallBudget(grant:{perCallUsd:string|null;remainingUsd:string|null},walletAvailable?:string):number {
  const values=[grant.perCallUsd,grant.remainingUsd].filter(value=>value!==null);
  if(!values.length&&walletAvailable!==undefined)values.push(walletAvailable);
  const amounts=values.map(Number);
  if(!amounts.length||amounts.some(value=>!Number.isFinite(value)||value<0))throw new Error('TokenToSea authorization budget is unavailable');
  return Math.min(...amounts);
}

/**
 * A request from a local non-browser client such as the od CLI: loopback, and
 * none of the headers every browser request carries (Origin, Sec-Fetch-*,
 * Referer) or a cookie. A web page cannot produce such a request.
 *
 * One exception: Node's fetch (undici, which the od CLI uses) adds
 * `Sec-Fetch-Mode: cors` to every request and no other fetch metadata. A
 * browser that sends Sec-Fetch-Mode always sends Sec-Fetch-Site with it, so
 * that value without Sec-Fetch-Site/Dest is not a browser signal; any other
 * mode still is.
 */
export function isLocalCliRequest(req: { headers: Request['headers']; socket?: { remoteAddress?: string | undefined } | null }): boolean {
  const address = req.socket?.remoteAddress ?? '';
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  const h = req.headers;
  // A loopback Host keeps DNS-rebound pages out.
  let host = '';
  try { host = new URL(`http://${String(h.host ?? '')}`).hostname; } catch { return false; }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return false;
  // Every browser identifies as Mozilla/…, including ones too old to send
  // Fetch Metadata; Node's fetch, curl and the od CLI do not.
  if (/mozilla\//i.test(String(h['user-agent'] ?? ''))) return false;
  // Node's fetch sends `sec-fetch-mode: cors` on its own; a browser that sends
  // Fetch Metadata always adds Sec-Fetch-Site.
  const mode = h['sec-fetch-mode'];
  return !h.origin && !h.referer && !h.cookie && !h['sec-fetch-site'] && !h['sec-fetch-dest'] && (!mode || mode === 'cors');
}

export function tokenToSeaCookie(req: Pick<Request, 'headers'>): string {
  const values = req.headers.cookie?.split(';').map(part => part.trim()) ?? [];
  // Prefer the migrated cookie if both the former narrow and new broad path exist.
  for (const name of ['fantay_session', 'fantay_identity']) {
    const value = values.find(part => part.startsWith(`${name}=`))?.slice(name.length + 1);
    if (value && /^[\w-]{43}$/.test(value)) return value;
  }
  return '';
}

function inferenceError(res: Response, status: number, message: string, protocol: 'openai' | 'anthropic', code?: string): void {
  if (status >= 400 && status < 500 && status !== 429) res.setHeader('x-should-retry', 'false');
  if (protocol === 'anthropic') {
    const type = status === 401 ? 'authentication_error' : status === 403 ? 'permission_error' : status === 429 ? 'rate_limit_error' : status >= 500 ? 'api_error' : 'invalid_request_error';
    res.status(status).json({ type: 'error', error: { type, message, ...(code ? { code } : {}) } });
  } else res.status(status).json({ error: { message, type: 'tokentosea_error', ...(code ? { code } : {}) }, message });
}

/** OAuth secrets stay in Identity; child processes receive only revocable local leases. */
export class TokenToSeaRuntime {
  readonly identity: TokenToSeaIdentity;
  readonly usage: AiUsageStore;
  private readonly usageContexts = new AsyncLocalStorage<AiUsageContext>();
  private readonly usageReconciliations = new Map<string,{at:number;work:Promise<void>}>();
  private readonly sessions = new AsyncLocalStorage<SessionContext>();
  private readonly leases = new Map<string, InferenceLease>();
  private readonly workspaceSessions = new Map<string, Map<string, SessionContext>>();
  private readonly accounts = new Map<string, SessionContext>();
  private cliSession = '';
  private readonly toolSessions = new Map<string, { context: SessionContext; expires: number }>();
  private readonly modelCatalogs = new Map<string, { at: number; work: Promise<TokenToSeaModel[]> }>();

  constructor(dataDir: string, identity?: TokenToSeaIdentity) {
    this.usage = new AiUsageStore(dataDir);
    this.identity = identity ?? TokenToSeaRuntime.identityFromEnvironment(dataDir);
  }

  private static identityFromEnvironment(dataDir: string): TokenToSeaIdentity {
    const endpoints = tokenToSeaEndpointsFromEnvironment();
    return new TokenToSeaIdentity({ dataDir,
      ...(process.env.TOKENTOSEA_CLIENT_ID ? { clientId: process.env.TOKENTOSEA_CLIENT_ID } : {}),
      ...(process.env.TOKENTOSEA_REDIRECT_URI ? { redirectUri: process.env.TOKENTOSEA_REDIRECT_URI } : {}),
      ...(endpoints ? { endpoints } : {}),
    });
  }

  middleware = (req: Request, res: Response, next: NextFunction): void => {
    const bearer = /^Bearer (\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
    const tool = bearer && (req.originalUrl.startsWith('/api/tools/') || req.originalUrl.startsWith('/api/media/tasks/')) ? this.toolSessions.get(bearer) : undefined;
    const raw = tool && tool.expires > Date.now() ? tool.context.raw : tokenToSeaCookie(req);
    if (!raw && isLocalCliRequest(req)) {
      // The od CLI (a local non-browser client) carries no session cookie. It
      // acts as this machine's signed-in TokenToSea account, as the Vela CLI
      // login did, but only when exactly one account is signed in.
      void this.uniqueSignedInAccount().then(
        context => this.sessions.run(context ?? { raw: '', user: null }, next),
        () => this.sessions.run({ raw: '', user: null }, next),
      );
      return;
    }
    void (raw ? this.identity.session(raw) : Promise.resolve(null)).then(user => {
      if (user) this.accounts.set(user.id, { raw, user });
      this.sessions.run({ raw, user }, next);
    }, () => this.sessions.run({ raw: '', user: null }, next));
  };

  private async uniqueSignedInAccount(): Promise<SessionContext | null> {
    const valid: SessionContext[] = [];
    for (const context of this.accounts.values()) if (await this.identity.session(context.raw)) valid.push(context);
    return valid.length === 1 ? valid[0]! : null;
  }

  current(): Readonly<SessionContext> | null { return this.sessions.getStore() ?? null; }
  withUsageContext<T>(context: AiUsageContext, work: () => Promise<T>): Promise<T> { return this.usageContexts.run({ ...context }, work); }

  async trackedService(raw: string, resource: string, method: 'GET'|'POST', body?: unknown, query: Record<string,unknown> = {}, signal?: AbortSignal, expectedUserId?: string, explicitContext?: AiUsageContext,modelLabel?:string): Promise<globalThis.Response> {
    const paid = method === 'POST' && ['chat/completions','official/prepare','tools/invoke'].includes(resource);
    const run = /^(official|models|tools)\/runs\/([\w-]+)(?:\/(invoke|stream|cancel))?$/.exec(resource);
    if (!paid && !run) return this.identity.service(raw,resource,method,body,query,signal,expectedUserId);
    const user = await this.identity.session(raw);
    if (!user || expectedUserId && user.id !== expectedUserId) throw new Error('TokenToSea account changed');
    const kind = resource.startsWith('official/') ? 'official' : resource.startsWith('tools/') ? 'tool' : 'chat';
    const input = body && typeof body === 'object' ? body as Record<string,unknown> : {};
    const key = run ? this.usage.keyForExternal(user.id,kind,run[2]!) ?? `receipt:${kind}:${run[2]}` : typeof input.requestKey === 'string' ? input.requestKey : randomUUID();
    this.usage.begin(user.id,key,modelLabel ?? (typeof input.model==='string'?input.model:kind),kind,explicitContext ?? this.usageContexts.getStore());
    if(run)this.usage.observe(user.id,key,{},run[2]);
    try {
      const upstream = await this.identity.service(raw,resource,method,body,query,signal,user.id);
      if (!upstream.body) { this.usage.finish(user.id,key,!upstream.ok); return upstream; }
      const store = this.usage;
      const observer = new UsageReceiptObserver(upstream.headers.get('content-type')?.includes('text/event-stream')??false,payload=>store.observe(user.id,key,payload,run?.[2]));
      const reader=upstream.body.getReader();
      return new globalThis.Response(new ReadableStream<Uint8Array>({
        async pull(controller) {
          try { const chunk=await reader.read();if(chunk.done){observer.finish();store.finish(user.id,key,!upstream.ok);controller.close();}else{observer.push(chunk.value);controller.enqueue(chunk.value);} }
          catch(error){store.finish(user.id,key,true);controller.error(error);}
        },
        async cancel(reason){store.finish(user.id,key,true);await reader.cancel(reason);},
      }),{status:upstream.status,statusText:upstream.statusText,headers:upstream.headers});
    } catch(error){this.usage.finish(user.id,key,true);throw error;}
  }

  async reconcileUsage(): Promise<void> {
    const context=this.current();if(!context?.user)return;
    const last=this.usageReconciliations.get(context.user.id);
    if(last&&Date.now()-last.at<30_000)return last.work;
    const pending=this.usage.pending(context.user.id).slice(0,20);
    const history=(async()=>{
      const response=await this.identity.service(context.raw,'official/runs','GET',undefined,{},undefined,context.user!.id);
      if(!response.ok)return;
      const rows:unknown=await response.json();if(!Array.isArray(rows))return;
      for(const raw of rows.slice(0,50)){
        if(!raw||typeof raw!=='object')continue;const row=raw as Record<string,unknown>;
        if(typeof row.id!=='string'||!/^[\w-]+$/.test(row.id))continue;
        const at=typeof row.createdAt==='string'?Date.parse(row.createdAt):typeof row.createdAt==='number'?row.createdAt:NaN;
        if(!Number.isFinite(at))continue;
        const key=this.usage.keyForExternal(context.user!.id,'official',row.id)??`history:official:${row.id}`;
        this.usage.begin(context.user!.id,key,typeof row.model==='string'?row.model:'official','official',{},'tokentosea',at);
        this.usage.observe(context.user!.id,key,row,row.id);
      }
    })();
    const work=Promise.allSettled([history,...pending.map(async row=>{
      const resource=`${row.kind==='official'?'official':row.kind==='tool'?'tools':'models'}/runs/${row.externalRunId}`;
      try {
        const response=await this.identity.service(context.raw,resource,'GET',undefined,{},undefined,context.user!.id);
        if(response.ok)this.usage.observe(context.user!.id,row.requestKey,await response.json(),row.externalRunId);
      } finally { this.usage.markReconciled(context.user!.id,row.requestKey); }
    })]).then(()=>undefined);
    this.usageReconciliations.set(context.user.id,{at:Date.now(),work});
    await work;
  }
  bindToolToken(token: string, ttlMs: number): () => void {
    const context = this.current();
    if (context?.user) this.toolSessions.set(token, { context: { ...context }, expires: Date.now() + ttlMs });
    return () => { this.toolSessions.delete(token); };
  }
  revokeSession(raw: string): void {
    for (const [token, lease] of this.leases) if (lease.session.raw === raw) { lease.abort.abort(); this.leases.delete(token); }
    for (const [token, session] of this.toolSessions) if (session.context.raw === raw) this.toolSessions.delete(token);
    for (const sessions of this.workspaceSessions.values()) for (const [user, session] of sessions) if (session.raw === raw) sessions.delete(user);
    for (const [user, session] of this.accounts) {
      if (session.raw === raw) {
        this.modelCatalogs.delete(createHash('sha256').update(`${user}:${raw}`).digest('hex'));
        this.accounts.delete(user);
      }
    }
  }
  identityKey(): string {
    const context = this.current();
    return context?.user ? createHash('sha256').update(`${context.user.id}:${context.raw}`).digest('hex') : 'signed-out';
  }
  rememberWorkspace(workspaceId: string): void {
    const context = this.current(); if (!context?.user) return;
    const sessions = this.workspaceSessions.get(workspaceId) ?? new Map<string, SessionContext>();
    sessions.set(context.user.id, { ...context }); this.workspaceSessions.set(workspaceId, sessions);
  }
  async inWorkspace<T>(workspaceId: string | undefined, operation: () => Promise<T>): Promise<T> {
    const current = this.current();
    if (current) {
      if (!current.user) throw Object.assign(new Error('请先使用 TokenToSea 登录'), { status: 401 });
      return operation();
    }
    const sessions = workspaceId ? this.workspaceSessions.get(workspaceId) ?? this.accounts : this.accounts;
    const valid: SessionContext[] = [];
    for (const context of sessions?.values() ?? []) if (await this.identity.session(context.raw)) valid.push(context);
    if (valid.length !== 1) throw new Error('TokenToSea 后台操作缺少唯一账号绑定');
    return this.sessions.run(valid[0]!, operation);
  }
  backgroundInWorkspace<T>(workspaceId: string, operation: () => Promise<T>): Promise<T> {
    return this.sessions.exit(() => this.inWorkspace(workspaceId, operation));
  }
  async beginCliLogin(): Promise<string> {
    if (this.cliSession) this.revokeSession(this.cliSession);
    this.cliSession = randomBytes(32).toString('base64url');
    return this.identity.begin(this.cliSession);
  }
  async cliStatus() {
    if (this.cliSession) {
      const user = await this.identity.session(this.cliSession);
      if (user) this.accounts.set(user.id, { raw: this.cliSession, user });
      if (user || this.identity.pending(this.cliSession)) return { loggedIn: Boolean(user), user, loginInFlight: this.identity.pending(this.cliSession), profile: 'tokentosea' };
    }
    try { return await this.sessions.exit(() => this.inWorkspace(undefined, async () => ({ loggedIn: true, user: this.current()?.user ?? null, loginInFlight: false, profile: 'tokentosea' }))); }
    catch { return { loggedIn: false, user: null, loginInFlight: false, profile: 'tokentosea' }; }
  }
  async cliLogout(): Promise<void> {
    await this.sessions.exit(() => this.inWorkspace(undefined, async () => {
      const raw = this.current()!.raw; this.revokeSession(raw); await this.identity.logout(raw);
    }));
    this.cliSession = '';
  }

  async response(resource: string, method: 'GET' | 'POST' = 'GET', body?: unknown, query: Record<string, unknown> = {}, signal?: AbortSignal): Promise<globalThis.Response> {
    const context = this.sessions.getStore();
    if (!context?.raw || !context.user) throw Object.assign(new Error('请先使用 TokenToSea 登录'), { status: 401 });
    return this.trackedService(context.raw, resource, method, body, query, signal, context.user.id);
  }

  async json<T>(resource: string, method: 'GET' | 'POST' = 'GET', body?: unknown, query: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> {
    const response = await this.response(resource, method, body, query, signal);
    const value = await response.json() as T & { error?: unknown; message?: unknown };
    if (!response.ok) throw Object.assign(new Error(typeof value.message === 'string' ? value.message : 'TokenToSea 请求失败'), { status: response.status });
    return value;
  }

  async authorizationBudget():Promise<number> {
    const grant=await this.json<{perCallUsd:string|null;remainingUsd:string|null}>('grant');
    const wallet=grant.perCallUsd===null&&grant.remainingUsd===null ? await this.json<{availableUsd:string}>('wallet'):null;
    return authorizedCallBudget(grant,wallet?.availableUsd);
  }

  async models(): Promise<TokenToSeaModel[]> {
    const context = this.sessions.getStore();
    if (!context?.raw || !context.user) throw Object.assign(new Error('请先使用 TokenToSea 登录'), { status: 401 });
    const key = this.identityKey();
    const hit = this.modelCatalogs.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.work;
    const work = (async () => {
      const catalog = await this.json<{ data: TokenToSeaModel[] }>('models', 'GET', undefined, { includeOfficial: '1' });
      if (!Array.isArray(catalog.data)) throw new Error('TokenToSea 模型目录无效');
      return catalog.data;
    })();
    this.modelCatalogs.set(key, { at: Date.now(), work });
    work.catch(() => { if (this.modelCatalogs.get(key)?.work === work) this.modelCatalogs.delete(key); });
    return work;
  }
  async chatModels(): Promise<TokenToSeaModel[]> {
    return (await this.models()).filter(isTokenToSeaAgentModel);
  }

  async collaboration<T>(body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const session = this.sessions.getStore();
    if (!session?.raw || !session.user) throw Object.assign(new Error('请先使用 TokenToSea 登录'), { status: 401 });
    const response = await this.identity.share(session.raw, 'collaboration', 'POST', body, signal, session.user.id);
    const result = await response.json() as T & { error?: string; errorCode?: unknown; code?: unknown };
    if (!response.ok) {
      // Keep the API error code (e.g. 410 SHARE_STOPPED): collaboration
      // clients decide terminal vs retryable failures from status + code.
      const code = typeof result.errorCode === 'string' ? result.errorCode : typeof result.code === 'string' ? result.code : undefined;
      throw Object.assign(new Error(result.error ?? 'TokenToSea 协作请求失败'), { status: response.status, ...(code ? { code } : {}) });
    }
    return result;
  }
  async stockSearch(body: unknown, signal?: AbortSignal): Promise<unknown> {
    const current = this.current();
    if (!current?.user) throw new Error('请先使用 TokenToSea 登录');
    const response = await this.identity.share(current.raw, 'stock-search', 'POST', body, signal, current.user.id);
    if (!response.ok) throw new Error('TokenToSea 素材搜索暂时不可用');
    return response.json();
  }

  async createInferenceLease(modelId: string, usageContext: AiUsageContext = {}, requestedReasoning?: string | null): Promise<{ token: string; model: TokenToSeaModel; reasoningEffort: TokenToSeaReasoningEffort; userKey: string; release: () => void }> {
    const session = this.sessions.getStore();
    if (!session?.raw || !session.user) throw new Error('请先使用 TokenToSea 登录');
    const [models, maximum] = await Promise.all([
      this.chatModels(), this.authorizationBudget(),
    ]);
    const requested = models.find(item => item.id === modelId || item.model === modelId);
    if (requested && tokenToSeaClaudeIdentityConflict(requested)) throw new Error('此通道返回的模型能力与标称型号冲突，已暂停用于对话，请切换通道。');
    if (requested?.provider === 'anthropic' && requested.executionKind === 'official' && !tokenToSeaUsesClaudeMessages(requested)) throw new Error('此 Claude 转换通道尚未验证原生思考和工具协议，请选择其他 Claude 通道。');
    const allowed = models.filter(isTokenToSeaAgentModel);
    const model = modelId && modelId !== 'default'
      ? allowed.find(item => item.id === modelId || item.model === modelId)
      : allowed[0];
    if (!model) throw new Error('请选择支持工具调用的 TokenToSea 对话模型');
    const reasoningEffort = resolveTokenToSeaReasoning(model, requestedReasoning);
    if (!Number.isFinite(maximum) || maximum < 0) throw new Error('TokenToSea 授权额度不足，请调整应用授权限额');
    const token = randomBytes(32).toString('base64url');
    const lease: InferenceLease = { session: { ...session }, model, reasoningEffort, maxCostUsd: maximum.toFixed(6), expires: Date.now() + 30 * 60_000, abort: new AbortController(), usageContext: { ...usageContext } };
    this.leases.set(token, lease);
    return { token, model, reasoningEffort, userKey: createHash('sha256').update(session.user.id).digest('hex').slice(0, 24), release: () => { lease.abort.abort(); this.leases.delete(token); } };
  }

  async inference(req: Request, res: Response, protocol: 'openai' | 'anthropic' = 'openai'): Promise<void> {
    const token = /^Bearer ([\w-]{43})$/.exec(String(req.headers.authorization ?? ''))?.[1]
      ?? (protocol === 'anthropic' && /^[\w-]{43}$/.test(String(req.headers['x-api-key'] ?? '')) ? String(req.headers['x-api-key']) : undefined);
    const lease = token ? this.leases.get(token) : undefined;
    if (!lease || lease.expires < Date.now() || lease.abort.signal.aborted) { inferenceError(res, 401, 'TokenToSea 推理授权已失效', protocol); return; }
    if ((await this.identity.session(lease.session.raw))?.id !== lease.session.user?.id) { this.revokeSession(lease.session.raw); inferenceError(res, 401, 'TokenToSea 账号已变化', protocol); return; }
    const input = req.body as Record<string, unknown>;
    if (!input || input.model !== lease.model.id || !Array.isArray(input.messages) || protocol !== tokenToSeaNativeProtocol(lease.model)) { inferenceError(res, 400, '推理请求与所选模型或协议不一致', protocol); return; }
    const disconnect = new AbortController();
    const onClose = () => { if (!res.writableEnded) disconnect.abort(); };
    res.once('close', onClose);
    try {
      const outputLimit = Math.min(tokenToSeaAgentOutputLimit(lease.model, lease.reasoningEffort),
        ...[input.max_tokens, input.max_completion_tokens].filter((value): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0));
      const wire: Record<string, unknown> = {
        ...input, model: lease.model.id, priceVersion: lease.model.priceVersion,
        reasoning_effort: lease.reasoningEffort,
        max_tokens: outputLimit,
        requestKey: randomUUID(), maxCostUsd: lease.maxCostUsd,
      };
      const signal = AbortSignal.any([lease.abort.signal, disconnect.signal, AbortSignal.timeout(20 * 60_000)]);
      let upstream: globalThis.Response;
      if (lease.model.executionKind === 'official') {
        delete wire.priceVersion; delete wire.requestKey; delete wire.maxCostUsd; delete wire.reasoning_effort;
        applyTokenToSeaReasoning(lease.model, lease.reasoningEffort, wire);
        upstream = await tokenToSeaNativeChat(lease.model, wire, lease.maxCostUsd,
          (resource, method, body, requestSignal) => this.trackedService(lease.session.raw, resource, method, body, {}, requestSignal, lease.session.user!.id, lease.usageContext, lease.model.model), signal,
          createHash('sha256').update(token!).update(JSON.stringify(wire)).digest('hex'), tokenToSeaNativePath(lease.model));
      } else {
        upstream = await this.trackedService(lease.session.raw, 'chat/completions', 'POST', wire, {}, signal, lease.session.user!.id, lease.usageContext, lease.model.model);
      }
      res.status(upstream.status).setHeader('Content-Type', upstream.headers.get('content-type') ?? 'application/json');
      const retryAfter = upstream.headers.get('retry-after');
      if (retryAfter) res.setHeader('Retry-After', retryAfter);
      res.setHeader('Cache-Control', 'no-store, no-transform');
      if (upstream.headers.get('content-type')?.includes('text/event-stream')) { res.setHeader('X-Accel-Buffering', 'no'); res.flushHeaders?.(); }
      if (upstream.body) {
        const reader = upstream.body.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (!res.write(chunk.value)) await new Promise<void>((resolve, reject) => {
              const done = () => { res.off('close', close); resolve(); };
              const close = () => { res.off('drain', done); reject(new Error('Client disconnected')); };
              res.once('drain', done); res.once('close', close);
            });
          }
        } finally { await reader.cancel().catch(() => undefined); }
      }
      res.end();
    } catch (error) {
      const { status, code, retryAfter } = (error ?? {}) as { status?: number; code?: string; retryAfter?: string };
      const message = error instanceof Error ? error.message : 'TokenToSea 推理连接中断';
      if (!res.headersSent) {
        if (retryAfter) res.setHeader('Retry-After', retryAfter);
        inferenceError(res, typeof status === 'number' && Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502, message, protocol, code);
      }
      else {
        if (code === 'tokentosea_billing_pending' || code === 'tokentosea_run_failed') {
          const error = protocol === 'anthropic'
            ? { type: 'error', error: { type: 'invalid_request_error', message, code } }
            : { error: { type: 'invalid_request_error', message, code } };
          res.write(`${protocol === 'anthropic' ? 'event: error\n' : ''}data: ${JSON.stringify(error)}\n\n`);
        }
        res.end();
      }
    } finally { res.off('close', onClose); }
  }

  close(): void { for (const lease of this.leases.values()) lease.abort.abort(); this.leases.clear(); this.toolSessions.clear(); this.workspaceSessions.clear(); this.accounts.clear(); this.identity.close(); }
}

/**
 * A model the agent runtime can drive: token-billed, not withdrawn, and reachable through the OpenAI
 * chat-completions route the inference proxy forwards to. The catalog stopped sending `toolCalling` and now
 * tags every model with an `executionKind` (2026-11: chat models carry `official`), so a chat model that
 * verifies `/v1/chat/completions` qualifies on its own; the legacy `toolCalling: true` without an
 * `executionKind` still does. An explicit `toolCalling`/`supportsTools: false` always excludes it.
 */
export function isTokenToSeaAgentModel(model: TokenToSeaModel): boolean {
  if (tokenToSeaClaudeIdentityConflict(model)) return false;
  // Claude signed thinking and tool history require the verified native Messages adapter.
  if (model.provider === 'anthropic' && model.executionKind === 'official' && !tokenToSeaUsesClaudeMessages(model)) return false;
  if (model.available === false || model.billingMode !== 'token') return false;
  if (typeof model.status === 'string' && model.status !== 'active') return false;
  if (typeof model.modality === 'string' && model.modality !== 'chat') return false;
  if (!model.modality && typeof model.category === 'string' && ['vision', 'audio', 'vector', 'specialized', 'system_one'].includes(model.category)) return false;
  if (model.executionKind && model.executionKind !== 'official') return false;
  // These Qwen task models do not support the system/tool history required by the agent.
  // https://help.aliyun.com/zh/model-studio/text-generation-model
  const upstream = String(model.upstreamModel ?? model.model).split('/').at(-1)!.replace(/^official:/, '').toLowerCase();
  if (model.provider === 'qwen' && /^(?:qwen-mt-|qwen-(?:plus|flash)-character(?:-|$)|qwen-long(?:-|$)|qwen-vl-ocr(?:-|$)|qwen3\.5-ocr(?:-|$))/.test(upstream)) return false;
  // GLM-4-Voice has a native speech contract rather than the text/tool agent contract.
  // https://docs.bigmodel.cn/cn/guide/models/sound-and-video/glm-4-voice
  if (model.provider === 'zhipu' && upstream === 'glm-4-voice') return false;
  // These specialized voice/visual agents failed the standard tool_calls contract in the live audit.
  // Keep them in the service catalogue; the desktop agent needs dedicated adapters before offering them.
  // docs.bigmodel.cn/cn/guide/models/vlm/autoglm-phone; platform.stepfun.com/docs/zh/guides/models/audio
  if (model.provider === 'zhipu' && ['autoglm-phone', 'glm-4v-flash', 'glm-4.1v-thinking-flash', 'glm-4.1v-thinking-flashx'].includes(upstream)) return false;
  if (model.provider === 'stepfun' && ['step-audio-2', 'step-audio-2-mini', 'stepaudio-2.5-chat', 'step-audio-r1.5'].includes(upstream)) return false;
  // The current supplier account rejects all 6.1 Sol tool calls without Responses access.
  if (model.model === 'lingzhigongfang/global/gpt-6.1-sol') return false;
  if (!hasUsableTextStream(model)) return false;
  const tools = model.toolCalling ?? model.supportsTools;
  if (tools === false) return false;
  if (speaksChatCompletions(model)) return true;
  return tools === true && !model.executionKind;
}

function speaksChatCompletions(model: TokenToSeaModel): boolean {
  if (model.modality !== 'chat') return false;
  if (typeof model.status === 'string' && model.status !== 'active') return false;
  const endpoints = Array.isArray(model.verifiedEndpoints) ? model.verifiedEndpoints : [];
  const protocols = Array.isArray(model.protocols) ? model.protocols : [];
  return tokenToSeaUsesClaudeMessages(model) || endpoints.includes('/v1/chat/completions') || protocols.includes('openai-chat');
}

function hasUsableTextStream(model: TokenToSeaModel): boolean {
  const chat = tokenToSeaNativePath(model);
  const modes = model.verifiedModes as Record<string, { sse?: boolean }> | undefined;
  if (modes?.[chat]?.sse === false) return false;
  const inputs = model.verifiedInputs as Record<string, { sse?: string[] }> | undefined;
  if (Array.isArray(inputs?.[chat]?.sse) && !inputs[chat]!.sse!.includes('text')) return false;
  const examples = model.examples?.filter(example => example.path === chat && example.mode === 'sse');
  if (examples?.length && examples.every(example => Array.isArray(example.body.modalities) && !example.body.modalities.includes('text'))) return false;
  if (model.executionKind === 'official' && !examples?.length) return false;
  return true;
}

let currentRuntime: TokenToSeaRuntime | undefined;
export function configureTokenToSeaRuntime(runtime: TokenToSeaRuntime | undefined): void { currentRuntime = runtime; }
export function optionalTokenToSeaRuntime(): TokenToSeaRuntime | undefined { return currentRuntime; }
export function tokenToSeaRuntime(): TokenToSeaRuntime {
  if (!currentRuntime) throw new Error('TokenToSea runtime is not initialized');
  return currentRuntime;
}
