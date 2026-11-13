import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { isIP } from 'node:net';
import { TokenToSeaIdentity, TOKENTOSEA_ISSUER } from '@fantay/tokentosea';
import { ShareStore } from './store.js';
import { CollaborationStore } from './collaboration.js';
import { searchTokenToSeaStock } from './stock.js';
import { HttpError, type PublishInput, type User } from './types.js';

interface Options {
  dataDir: string; origin: string; secret: string; publicDir: string;
  verifyToken?: (token: string) => Promise<User>;
}
const COOKIE = '__Host-fantay_share';
const idPattern = /^[a-f0-9-]{36}$/;
export function clientAddress(req: Pick<IncomingMessage, 'socket' | 'headers'>): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && forwarded && isIP(forwarded) ? forwarded : remote;
}
const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp4': 'video/mp4', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav' };
const bridge = `<script>(()=>{let nonce='',select=false;const selector=e=>{if(e.id)return '#'+CSS.escape(e.id);let parts=[];while(e&&e!==document.body&&parts.length<7){let n=1,s=e;while(s=s.previousElementSibling)if(s.tagName===e.tagName)n++;parts.unshift(e.tagName.toLowerCase()+':nth-of-type('+n+')');e=e.parentElement}return 'body>'+parts.join('>')};addEventListener('message',e=>{if(e.source!==parent||!e.data||e.data.type!=='fantay-share:control'||typeof e.data.nonce!=='string')return;if(nonce&&nonce!==e.data.nonce)return;nonce=e.data.nonce;select=!!e.data.select;if(e.data.selector){try{const el=document.querySelector(e.data.selector);el?.scrollIntoView({block:'center',behavior:'smooth'});if(el)el.animate([{outline:'3px solid #87ea5c'},{outline:'3px solid transparent'}],{duration:2000})}catch{}}});document.addEventListener('click',e=>{if(!select||!nonce||!(e.target instanceof Element))return;e.preventDefault();e.stopPropagation();const r=e.target.getBoundingClientRect();parent.postMessage({type:'fantay-share:target',nonce,target:{selector:selector(e.target),label:e.target.tagName.toLowerCase(),text:(e.target.textContent||'').trim().slice(0,160),position:{x:Math.max(0,Math.min(1,(r.x+r.width/2)/innerWidth)),y:Math.max(0,Math.min(1,(r.y+r.height/2)/innerHeight))}}},'*')},true)})();</script>`;

async function jsonBody(req: IncomingMessage, max = 30 * 1024 * 1024): Promise<Record<string, unknown>> {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json') || req.headers['content-encoding']) throw new HttpError(415, '需要 JSON 请求');
  const chunks: Buffer[] = []; let bytes = 0;
  for await (const chunk of req) { bytes += Buffer.byteLength(chunk); if (bytes > max) throw new HttpError(413, '请求过大'); chunks.push(Buffer.from(chunk)); }
  try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!body || Array.isArray(body) || typeof body !== 'object') throw 0; return body; }
  catch { throw new HttpError(400, '请求内容无效'); }
}
function json(res: ServerResponse, value: unknown, status = 200) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
export async function verifyTokenToSea(token: string): Promise<User> {
  if (!/^tts_at_[\w-]{43}$/.test(token)) throw new HttpError(401, '请使用 TokenToSea 登录');
  const response = await fetch('https://tokentosea.com/api/v1/connect/fantay/identity', { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new HttpError(401, 'TokenToSea 登录已失效，请重新登录');
  const data = await response.json() as Record<string, unknown>;
  if (data.issuer !== TOKENTOSEA_ISSUER || data.client_id !== 'fantay-design' || typeof data.sub !== 'string' || !data.sub) throw new HttpError(401, '账号验证失败');
  return { id: `${TOKENTOSEA_ISSUER}|${data.sub}`, name: typeof data.name === 'string' && data.name ? data.name.slice(0, 100) : 'TokenToSea 用户' };
}

export function createShareServer(options: Options) {
  const origin = new URL(options.origin).origin;
  if (options.secret.length < 32) throw new Error('SHARE_SESSION_SECRET must have at least 32 characters');
  const store = new ShareStore(options.dataDir, origin);
  const collaboration = new CollaborationStore(options.dataDir, origin);
  const identity = new TokenToSeaIdentity({ dataDir: options.dataDir, redirectUri: `${origin}/api/auth/callback`, scopes: 'openid profile offline_access' });
  const flows = new Map<string, { session: string; returnTo: string; expires: number }>();
  const limits = new Map<string, { count: number; until: number }>();
  let activeUploads = 0;
  function throttle(key: string, maximum: number) {
    const now = Date.now();
    if (limits.size > 10000) for (const [k, v] of limits) if (v.until < now) limits.delete(k);
    let entry = limits.get(key); if (!entry || entry.until < now) { entry = { count: 0, until: now + 60_000 }; limits.set(key, entry); }
    if (++entry.count > maximum) throw new HttpError(429, '访问过于频繁，请稍后重试');
  }
  const session = (req: IncomingMessage) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1) ?? '';
  const csrf = (raw: string) => createHmac('sha256', options.secret).update(raw).digest('base64url');
  const bearer = (req: IncomingMessage) => /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
  async function user(req: IncomingMessage, required = false, mutation = true): Promise<User | null> {
    const token = bearer(req);
    if (token) { const found = await (options.verifyToken ?? verifyTokenToSea)(token); if (required && mutation && req.method !== 'GET') throttle(`write:${found.id}`, 60); return found; }
    const raw = session(req);
    if (!/^[\w-]{43}$/.test(raw)) { if (required) throw new HttpError(401, '请使用 TokenToSea 登录'); return null; }
    try {
      const found = required ? await identity.verifiedUser(raw) : await identity.session(raw);
      if (!found && required) throw new HttpError(401, '登录已失效，请重新登录');
      if (found && required && mutation && req.method !== 'GET') throttle(`write:${found.id}`, 60);
      return found;
    } catch (error) { if (error instanceof HttpError) throw error; if (required) throw new HttpError(401, '登录已失效，请重新登录'); return null; }
  }
  function requireWriteOrigin(req: IncomingMessage) {
    const from = req.headers.origin;
    if (bearer(req)) { if (from && from !== origin) throw new HttpError(403, '请求来源无效'); return; }
    const expected = Buffer.from(csrf(session(req))), received = Buffer.from(String(req.headers['x-csrf-token'] ?? ''));
    if (from !== origin || expected.length !== received.length || !timingSafeEqual(expected, received)) throw new HttpError(403, '请求校验失败，请刷新页面');
  }
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
    try {
      const url = new URL(req.url ?? '/', origin), p = url.pathname, method = req.method ?? 'GET';
      if (p === '/healthz') { json(res, { ok: true, service: 'fantay-share' }); return; }
      const key = clientAddress(req), now = Date.now();
      throttle(`ip:${key}`, 2000);
      if (p === '/api/auth/status' && method === 'GET') { const found = await user(req); json(res, { user: found, csrf: found ? csrf(session(req)) : null }); return; }
      if (p === '/api/auth/login' && method === 'GET') {
        throttle(`login:${key}`, 20);
        const raw = randomBytes(32).toString('base64url'), returnTo = url.searchParams.get('returnTo') ?? '/';
        if (!/^\/(?:s\/[a-f0-9-]{36})?(?:\?(?:workspace|workspaceId|invite)=[A-Za-z0-9_-]{1,160})?$/.test(returnTo)) throw new HttpError(400, '返回地址无效');
        for (const [k, flow] of flows) if (flow.expires < now) flows.delete(k);
        if (flows.size > 2000) throw new HttpError(429, '登录请求过多');
        const target = await identity.begin(raw), state = new URL(target).searchParams.get('state')!;
        flows.set(state, { session: raw, returnTo, expires: now + 600_000 });
        res.writeHead(302, { Location: target, 'Cache-Control': 'no-store', 'Set-Cookie': `${COOKIE}=${raw}; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000` }); res.end(); return;
      }
      if (p === '/api/auth/callback' && method === 'GET') {
        const state = url.searchParams.get('state') ?? '', flow = flows.get(state); flows.delete(state);
        if (!flow || flow.expires < now || flow.session !== session(req)) throw new HttpError(400, '登录已过期，请重新登录');
        await identity.complete(url.searchParams);
        res.writeHead(303, { Location: flow.returnTo, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (p === '/api/auth/logout' && method === 'POST') { requireWriteOrigin(req); await identity.logout(session(req)); res.setHeader('Set-Cookie', `${COOKIE}=; Secure; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`); json(res, { ok: true }); return; }
      if (p === '/api/collaboration' && method === 'POST') {
        requireWriteOrigin(req);
        const principal = (await user(req, true, false))!;
        if (activeUploads >= 2) throw new HttpError(429, '正在处理其他上传，请稍后重试');
        activeUploads++;
        try {
          const body = await jsonBody(req);
          if (typeof body.operation !== 'string' || !/\.(list|get|pull|head)$/.test(body.operation)) throttle(`write:${principal.id}`, 60);
          json(res, String(body.operation).startsWith('publication.') ? await collaboration.publication(principal, body, store) : collaboration.execute(principal, body));
        } finally { activeUploads--; }
        return;
      }
      if (p === '/api/stock-search' && method === 'POST') {
        requireWriteOrigin(req); const principal = (await user(req, true, false))!;
        throttle(`stock:${principal.id}`, 30);
        json(res, await searchTokenToSeaStock(await jsonBody(req, 64 * 1024))); return;
      }
      if (p === '/api/shares' && method === 'GET') { json(res, { shares: store.list((await user(req, true))!) }); return; }
      if (p === '/api/shares' && method === 'POST') {
        requireWriteOrigin(req); const owner = (await user(req, true))!;
        if (activeUploads >= 2) throw new HttpError(429, '正在处理其他上传，请稍后重试');
        activeUploads++;
        try { const body = await jsonBody(req); json(res, await store.publish(owner, body as unknown as PublishInput), 201); }
        finally { activeUploads--; }
        return;
      }
      const shareRoute = /^\/api\/shares\/([a-f0-9-]{36})(?:\/(state|comments))?$/.exec(p);
      if (shareRoute) {
        const id = shareRoute[1]!, action = shareRoute[2];
        if (!action && method === 'GET') { json(res, store.get(id, await user(req))); return; }
        if (action === 'comments' && method === 'GET') { json(res, { comments: store.comments(id, await user(req)) }); return; }
        requireWriteOrigin(req); const owner = (await user(req, true))!, body = await jsonBody(req, 64 * 1024);
        if (action === 'state' && method === 'POST') { json(res, store.changeState(owner, id, body.status, body.revision)); return; }
        if (action === 'comments' && method === 'POST') { json(res, { comments: store.addComment(owner, id, body) }, 201); return; }
      }
      const commentRoute = /^\/api\/comments\/([a-f0-9-]{36})$/.exec(p);
      if (commentRoute && method === 'PATCH') { requireWriteOrigin(req); const owner = (await user(req, true))!; json(res, { comments: store.changeComment(owner, commentRoute[1]!, await jsonBody(req, 64 * 1024)) }); return; }
      const content = /^\/content\/([a-f0-9-]{36})\/([a-f0-9-]{36})\/(.+)$/.exec(p);
      const legacyViewer = /^\/artifact\/([^/]+)\/([a-f0-9-]{36})$/.exec(p);
      if (legacyViewer && method === 'GET') {
        if (!collaboration.publishedProjectMatches(decodeURIComponent(legacyViewer[1]!), legacyViewer[2]!)) throw new HttpError(404, '分享不存在');
        store.get(legacyViewer[2]!);
        res.writeHead(302, { Location: `/s/${legacyViewer[2]}`, 'Cache-Control': 'no-store' }); res.end(); return;
      }
      if (content && method === 'GET') {
        const file = decodeURIComponent(content[3]!); let bytes = await store.asset(content[1]!, content[2]!, file);
        res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-downloads; default-src 'none'; script-src 'self' 'unsafe-inline' blob: https:; style-src 'self' 'unsafe-inline' https:; img-src 'self' data: blob: https:; font-src 'self' data: https:; media-src 'self' data: blob: https:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'");
        res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
        res.setHeader('Cache-Control', 'no-store');
        if (/\.html?$/i.test(file)) bytes = Buffer.concat([bytes, Buffer.from(bridge)]);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream' }); res.end(bytes); return;
      }
      if (method === 'GET' && (p === '/' || /^\/s\/[a-f0-9-]{36}$/.test(p) || ['/app.js', '/style.css', '/icon.svg'].includes(p))) {
        const file = p === '/' || p.startsWith('/s/') ? 'index.html' : p.slice(1);
        res.writeHead(200, { 'Content-Type': mime[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(await readFile(path.join(options.publicDir, file))); return;
      }
      throw new HttpError(404, '页面不存在');
    } catch (error) { if (!res.headersSent) json(res, { error: error instanceof HttpError ? error.message : '服务暂时不可用，请稍后重试' }, error instanceof HttpError ? error.status : 503); else res.end(); }
  });
  server.requestTimeout = 120_000; server.headersTimeout = 15_000;
  return { server, store, collaboration, close: () => { identity.close(); store.close(); collaboration.close(); server.close(); } };
}
