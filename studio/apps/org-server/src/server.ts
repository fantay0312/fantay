// SPDX-License-Identifier: AGPL-3.0-only
// HTTP surface of the Fantay organization server.
//   /v1/…        the management API: a bearer token on every route, the service decides what it may do
//   /v1/sso/…    single sign-on (the only routes a browser reaches without a token, besides the console's files)
//   /scim/v2/…   provisioning from the identity provider, with its own token
//   /            the admin console (static files)
// TLS is the reverse proxy's job: the server listens on loopback by default.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import path from 'node:path';
import { ScimApi, scimError } from './scim.js';
import { OrgService, type Actor } from './service.js';
import { OidcClient } from './sso.js';
import { OrgError } from './store.js';

export interface OrgServerOptions {
  dataDir: string;
  now?: () => number;
  /** The address members reach the server at, e.g. https://org.example.com. SSO and SCIM need it. */
  publicUrl?: string;
  /** Directory of the built console (index.html, app.js, style.css…). Without it only the API is served. */
  consoleDir?: string;
  /** Replaces `fetch` for the calls to the identity provider (tests). */
  fetch?: typeof fetch;
}
interface Call { actor: Actor; ids: string[]; body: unknown; query: URLSearchParams; bearer: string }
type Binary = { bytes: Uint8Array; mime: string };
type Route = [method: string, pattern: RegExp, run: (service: OrgService, call: Call) => unknown, bodyBytes?: number];

const ID = '([a-zA-Z0-9][a-zA-Z0-9_-]{0,63})';
const route = (template: string) => new RegExp(`^${template.replaceAll(':id', ID)}$`);
const JSON_BODY = 256 * 1024;
const DOCUMENT_BODY = 3 * 1024 * 1024;
const ASSET_BODY = 12 * 1024 * 1024;
const number = (value: string | null): number | undefined => {
  if (value === null) return undefined;
  if (!/^\d{1,15}$/.test(value)) throw new OrgError(400, 'ORG_INVALID_REQUEST', '分页参数无效');
  return Number(value);
};

/** Method, path, call. The permission for each lives in the service method, next to the rule it protects. */
const ROUTES: Route[] = [
  ['GET', route('/v1/me'), (s, c) => s.session(c.actor)],
  ['POST', route('/v1/logout'), (s, c) => s.logout(c.bearer)],
  ['GET', route('/v1/org'), (s, c) => s.info(c.actor)],
  ['PATCH', route('/v1/org'), (s, c) => s.patchOrg(c.actor, c.body)],
  ['POST', route('/v1/org/plan'), (s, c) => s.changePlan(c.actor, c.body)],
  ['POST', route('/v1/org/transfer'), (s, c) => s.transfer(c.actor, c.body)],

  ['GET', route('/v1/members'), (s, c) => s.members(c.actor)],
  ['POST', route('/v1/members'), (s, c) => s.addMember(c.actor, c.body)],
  ['PATCH', route('/v1/members/:id'), (s, c) => s.patchMember(c.actor, c.ids[0]!, c.body)],
  ['DELETE', route('/v1/members/:id'), (s, c) => s.removeMember(c.actor, c.ids[0]!)],
  ['POST', route('/v1/members/:id/role'), (s, c) => s.setRole(c.actor, c.ids[0]!, c.body)],
  ['POST', route('/v1/members/:id/token'), (s, c) => s.rotateToken(c.actor, c.ids[0]!, c.body)],
  ['DELETE', route('/v1/members/:id/token'), (s, c) => s.revokeToken(c.actor, c.ids[0]!)],

  ['GET', route('/v1/groups'), (s, c) => s.groups(c.actor)],
  ['POST', route('/v1/groups'), (s, c) => s.createGroup(c.actor, c.body)],
  ['PATCH', route('/v1/groups/:id'), (s, c) => s.patchGroup(c.actor, c.ids[0]!, c.body)],
  ['DELETE', route('/v1/groups/:id'), (s, c) => s.deleteGroup(c.actor, c.ids[0]!)],

  ['GET', route('/v1/roles'), (s, c) => s.roles(c.actor)],
  ['POST', route('/v1/roles'), (s, c) => s.createRole(c.actor, c.body)],
  ['PATCH', route('/v1/roles/:id'), (s, c) => s.patchRole(c.actor, c.ids[0]!, c.body)],
  ['DELETE', route('/v1/roles/:id'), (s, c) => s.deleteRole(c.actor, c.ids[0]!)],

  ['GET', route('/v1/library'), (s, c) => s.library(c.actor)],
  ['POST', route('/v1/library'), (s, c) => s.createLibraryItem(c.actor, c.body), DOCUMENT_BODY],
  ['GET', route('/v1/library/:id'), (s, c) => s.libraryItem(c.actor, c.ids[0]!)],
  ['PATCH', route('/v1/library/:id'), (s, c) => s.patchLibraryItem(c.actor, c.ids[0]!, c.body), DOCUMENT_BODY],
  ['DELETE', route('/v1/library/:id'), (s, c) => s.deleteLibraryItem(c.actor, c.ids[0]!)],
  ['POST', route('/v1/library/:id/publish'), (s, c) => s.setLibraryStatus(c.actor, c.ids[0]!, 'published', c.body)],
  ['POST', route('/v1/library/:id/retire'), (s, c) => s.setLibraryStatus(c.actor, c.ids[0]!, 'retired', c.body)],
  ['POST', route('/v1/library/:id/assets'), (s, c) => s.putAsset(c.actor, c.ids[0]!, c.body), ASSET_BODY],
  ['GET', route('/v1/library/:id/assets/:id'), (s, c): Binary => s.asset(c.actor, c.ids[0]!, c.ids[1]!)],

  ['GET', route('/v1/audit'), (s, c) => s.audit(c.actor, number(c.query.get('before')), number(c.query.get('limit')))],
  ['GET', route('/v1/audit/verify'), (s, c) => s.verifyAudit(c.actor)],

  ['GET', route('/v1/service-tokens'), (s, c) => s.serviceTokens(c.actor)],
  ['POST', route('/v1/service-tokens'), (s, c) => s.createServiceToken(c.actor, c.body)],
  ['DELETE', route('/v1/service-tokens/:id'), (s, c) => s.deleteServiceToken(c.actor, c.ids[0]!)],

  ['GET', route('/v1/sso'), (s, c) => s.sso(c.actor)],
  ['PUT', route('/v1/sso'), (s, c) => s.saveSso(c.actor, c.body)],
  ['GET', route('/v1/scim'), (s, c) => s.scimStatus(c.actor)],
  ['POST', route('/v1/scim/token'), (s, c) => s.createScimToken(c.actor)],
  ['DELETE', route('/v1/scim/token'), (s, c) => s.deleteScimToken(c.actor)],

  ['GET', route('/v1/sync/directory'), (s, c) => s.syncDirectory(c.actor)],
  ['GET', route('/v1/sync/library'), (s, c) => s.syncLibrary(c.actor, number(c.query.get('since')))],
];

const CONSOLE_FILE = /^[a-z0-9][a-z0-9.-]*\.(?:html|js|css|svg|woff2)$/;
const CONSOLE_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
};
/** The console loads only its own files and talks only to this server. */
const CONSOLE_HEADERS = {
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
};

/** The caller's address: the forwarded one only when the connection itself comes from the local reverse proxy. */
export function clientAddress(req: Pick<IncomingMessage, 'socket' | 'headers'>): string {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote) && forwarded && isIP(forwarded) ? forwarded : remote;
}
async function readJson(req: IncomingMessage, max: number, scim = false): Promise<unknown> {
  const type = String(req.headers['content-type'] ?? '');
  if (!(type.startsWith('application/json') || scim && type.startsWith('application/scim+json')) || req.headers['content-encoding'])
    throw new OrgError(415, 'ORG_INVALID_REQUEST', '需要 JSON 请求');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += Buffer.byteLength(chunk as Buffer);
    if (bytes > max) throw new OrgError(413, 'ORG_TOO_LARGE', '请求过大');
    chunks.push(Buffer.from(chunk as Buffer));
  }
  try {
    const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('not an object');
    return body;
  } catch {
    throw new OrgError(400, 'ORG_INVALID_REQUEST', '请求内容无效');
  }
}

export function createOrgServer(options: OrgServerOptions) {
  const now = options.now ?? Date.now;
  const service = new OrgService(options.dataDir, now, options.publicUrl ? { publicUrl: options.publicUrl } : {});
  const oidc = new OidcClient(options.fetch ?? fetch, now);
  const scim = new ScimApi(service, `${options.publicUrl ? new URL(options.publicUrl).origin : ''}/scim/v2`);
  // Windows of one minute: failed sign-ins by address (guessing), calls by token (a runaway client), SSO attempts.
  const windows = new Map<string, { count: number; until: number }>();
  const hit = (key: string, maximum: number): boolean => {
    const at = now();
    if (windows.size > 20000) for (const [name, entry] of windows) if (entry.until < at) windows.delete(name);
    let entry = windows.get(key);
    if (!entry || entry.until < at) { entry = { count: 0, until: at + 60_000 }; windows.set(key, entry); }
    entry.count += 1;
    return entry.count > maximum;
  };
  const send = (res: ServerResponse, status: number, value: unknown, type = 'application/json; charset=utf-8', extra: Record<string, string> = {}) => {
    res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra });
    res.end(value === undefined ? undefined : JSON.stringify(value));
  };
  const fail = (res: ServerResponse, error: unknown) => {
    if (res.headersSent) { res.end(); return; }
    const zod = error instanceof Error && error.name === 'ZodError';
    if (error instanceof OrgError) send(res, error.status, { error: { code: error.code, message: error.message } });
    else if (zod) send(res, 400, { error: { code: 'ORG_INVALID_REQUEST', message: '输入格式不正确，请检查必填项' } });
    else send(res, 500, { error: { code: 'ORG_INTERNAL', message: '服务器内部错误' } });
  };
  const redirect = (res: ServerResponse, location: string) => {
    res.writeHead(302, { Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    res.end();
  };
  const consoleFile = async (res: ServerResponse, name: string): Promise<boolean> => {
    if (!options.consoleDir || !CONSOLE_FILE.test(name)) return false;
    const bytes = await readFile(path.join(options.consoleDir, name)).catch(() => null);
    if (!bytes) return false;
    res.writeHead(200, {
      'Content-Type': CONSOLE_MIME[path.extname(name)] ?? 'application/octet-stream',
      'Cache-Control': name.endsWith('.html') ? 'no-store' : 'no-cache', ...CONSOLE_HEADERS,
    });
    res.end(bytes);
    return true;
  };
  /** The two browser redirects of a sign-in. The session returns in the URL fragment: it is never sent to a server
   *  or written to a log, and the console moves it out of the address bar at once. */
  const sso = async (res: ServerResponse, step: string, query: URLSearchParams): Promise<void> => {
    try {
      const settings = service.ssoSettings();
      const redirectUri = service.redirectUri();
      if (!settings?.enabled || !redirectUri) throw new OrgError(403, 'ORG_SSO_DISABLED', '组织没有启用单点登录');
      if (step === 'start') return redirect(res, await oidc.begin(settings, redirectUri));
      if (query.get('error')) throw new OrgError(403, 'ORG_SSO_REJECTED', '身份提供方拒绝了这次登录');
      const state = query.get('state'), code = query.get('code');
      if (!state || !code || state.length > 200 || code.length > 4000) throw new OrgError(400, 'ORG_SSO_REJECTED', '登录回调参数无效');
      const session = service.ssoSignIn(await oidc.complete(settings, redirectUri, state, code));
      redirect(res, `/#session=${session.token}`);
    } catch (error) {
      redirect(res, `/#sso_error=${error instanceof OrgError ? error.code : 'ORG_INTERNAL'}`);
    }
  };

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://org.invalid');
      const method = req.method ?? 'GET';
      const address = clientAddress(req);
      const bearer = /^Bearer (\S+)$/.exec(String(req.headers.authorization ?? ''))?.[1];
      if (method === 'GET') {
        if (url.pathname === '/healthz') return send(res, 200, { ok: true, initialized: service.initialized() });
        if (url.pathname === '/v1/public') return send(res, 200, service.publicInfo());
        if (url.pathname === '/' && await consoleFile(res, 'index.html')) return;
        if (url.pathname.startsWith('/console/') && await consoleFile(res, url.pathname.slice('/console/'.length))) return;
        const step = /^\/v1\/sso\/(start|callback)$/.exec(url.pathname)?.[1];
        if (step) {
          if (hit(`sso:${address}`, 30)) return redirect(res, '/#sso_error=ORG_RATE_LIMITED');
          return await sso(res, step, url.searchParams);
        }
      }
      if (url.pathname === '/scim/v2' || url.pathname.startsWith('/scim/v2/')) {
        const scimType = 'application/scim+json; charset=utf-8';
        try {
          if (!service.authenticateScim(bearer)) {
            if (hit(`fail:${address}`, 30)) throw new OrgError(429, 'ORG_RATE_LIMITED', '尝试次数过多，请稍后再试');
            throw new OrgError(401, 'ORG_UNAUTHORIZED', '需要有效的 SCIM 令牌');
          }
          if (hit('call:scim', 1200)) throw new OrgError(429, 'ORG_RATE_LIMITED', '访问过于频繁，请稍后重试');
          const body = method === 'GET' || method === 'DELETE' ? undefined : await readJson(req, JSON_BODY, true);
          const result = scim.handle(method, url.pathname.slice('/scim/v2'.length), url.searchParams, body);
          return send(res, result.status, result.body, scimType, result.location ? { Location: result.location } : {});
        } catch (error) {
          const result = scimError(error);
          return send(res, result.status, result.body, scimType);
        }
      }
      const actor = service.authenticate(bearer);
      if (!actor || !bearer) {
        if (hit(`fail:${address}`, 30)) throw new OrgError(429, 'ORG_RATE_LIMITED', '尝试次数过多，请稍后再试');
        throw new OrgError(401, 'ORG_UNAUTHORIZED', '需要有效的访问令牌');
      }
      if (hit(`call:${actor.kind === 'member' ? actor.member.id : actor.token.id}`, 600))
        throw new OrgError(429, 'ORG_RATE_LIMITED', '访问过于频繁，请稍后重试');
      let known = false;
      for (const [verb, pattern, run, bodyBytes] of ROUTES) {
        const match = pattern.exec(url.pathname);
        if (!match) continue;
        known = true;
        if (verb !== method) continue;
        // A call without a body (issue a token, sign out) carries no JSON; one with a body must be JSON.
        const hasBody = method !== 'GET' && method !== 'DELETE'
          && (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined);
        const body = hasBody ? await readJson(req, bodyBytes ?? JSON_BODY) : undefined;
        const result = run(service, { actor, ids: match.slice(1), body, query: url.searchParams, bearer });
        if (result && typeof result === 'object' && (result as Binary).bytes instanceof Uint8Array) {
          const file = result as Binary;
          res.writeHead(200, { 'Content-Type': file.mime, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': file.bytes.length });
          res.end(file.bytes);
          return;
        }
        return send(res, 200, result);
      }
      throw known ? new OrgError(405, 'ORG_METHOD_NOT_ALLOWED', '不支持这个请求方法') : new OrgError(404, 'ORG_NOT_FOUND', '没有这个接口');
    } catch (error) {
      fail(res, error);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return { server, service, close: () => { server.close(); service.close(); } };
}
