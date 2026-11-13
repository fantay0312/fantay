// HTTP routes for tool plugins, with the same route contract as the DeepSeek Harness `webServer`
// service: `register({ kind: 'exact' | 'prefix', path, handler(req, res) })`, exact routes first, then
// the longest prefix.
//
// The server listens on loopback and answers only requests that carry its token. The workspace never
// calls it directly: the daemon forwards same-origin requests under each registered
// `/api/plugins/<name>` prefix and adds the token, so a plugin's workspace half keeps using relative
// URLs exactly as it does inside the Harness.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import type { AddressInfo } from 'node:net';
import { isToolPluginGatewayPrefix, TOOL_PLUGIN_GATEWAY_HEADER } from '@open-design/contracts';

export type ToolPluginRouteHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
export type ToolPluginRouteResource = (request: Request) => Promise<Response>;

export interface ToolPluginWebRoute {
  kind: 'exact' | 'prefix';
  path: string;
  handler?: ToolPluginRouteHandler;
  /** Fetch-style route: answers GET and HEAD only. */
  resource?: ToolPluginRouteResource;
}

export class ToolPluginWebServer {
  readonly token = randomBytes(24).toString('base64url');
  private readonly routes: ToolPluginWebRoute[] = [];
  private server: Server | null = null;
  private listening: Promise<void> | null = null;

  /** Starts the loopback listener once; later calls share the same start. */
  ensureListening(): Promise<void> {
    this.listening ??= new Promise<void>((resolve, reject) => {
      const server = createServer((req, res) => { void this.handle(req, res); });
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        this.server = server;
        resolve();
      });
    }).catch((error: unknown) => {
      this.listening = null;
      throw error;
    });
    return this.listening;
  }

  get port(): number | undefined {
    const address = this.server?.address() as AddressInfo | null | undefined;
    return address?.port;
  }

  /** Adds a route and returns its remover. A second route with the same kind and path is an error. */
  register(route: ToolPluginWebRoute): () => void {
    if (route.kind !== 'exact' && route.kind !== 'prefix') throw new TypeError('webServer route kind must be "exact" or "prefix"');
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) throw new TypeError('webServer route path must start with "/"');
    if (typeof route.handler !== 'function' && typeof route.resource !== 'function') {
      throw new TypeError('webServer route needs a handler or a resource');
    }
    if (this.routes.some(item => item.kind === route.kind && item.path === route.path)) {
      throw new Error(`webServer route already registered: ${route.kind} ${route.path}`);
    }
    const entry = { ...route };
    this.routes.push(entry);
    return () => {
      const index = this.routes.indexOf(entry);
      if (index >= 0) this.routes.splice(index, 1);
    };
  }

  /** Route paths the daemon gateway forwards; routes outside `/api/plugins/<name>` stay unreachable. */
  gatewayPrefixes(): string[] {
    return [...new Set(this.routes.map(route => route.path).filter(isToolPluginGatewayPrefix))];
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.listening = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }

  private match(pathname: string): ToolPluginWebRoute | undefined {
    const exact = this.routes.find(route => route.kind === 'exact' && route.path === pathname);
    if (exact) return exact;
    let best: ToolPluginWebRoute | undefined;
    for (const route of this.routes) {
      if (route.kind !== 'prefix') continue;
      if (pathname !== route.path && !pathname.startsWith(route.path + '/')) continue;
      if (!best || route.path.length > best.path.length) best = route;
    }
    return best;
  }

  private authorized(req: IncomingMessage): boolean {
    const given = req.headers[TOOL_PLUGIN_GATEWAY_HEADER];
    if (typeof given !== 'string') return false;
    const actual = Buffer.from(given);
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) {
      res.writeHead(403).end();
      return;
    }
    delete req.headers[TOOL_PLUGIN_GATEWAY_HEADER];
    let pathname: string;
    try {
      pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname;
    } catch {
      res.writeHead(400).end();
      return;
    }
    const route = this.match(pathname);
    if (!route) {
      res.writeHead(404).end();
      return;
    }
    try {
      if (route.handler) await route.handler(req, res);
      else await this.serveResource(route.resource!, req, res);
    } catch (error) {
      console.warn('[fantay tool plugins] Route handler failed', pathname, error);
      if (res.headersSent) res.destroy();
      else res.writeHead(400).end();
    }
  }

  private async serveResource(resource: ToolPluginRouteResource, req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end();
      return;
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item);
      else if (typeof value === 'string') headers.set(name, value);
    }
    const response = await resource(new Request(`http://127.0.0.1:${this.port ?? 0}${req.url ?? '/'}`, { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (req.method === 'HEAD' || !response.body) {
      res.end();
      return;
    }
    Readable.fromWeb(response.body as import('node:stream/web').ReadableStream).pipe(res);
  }
}
