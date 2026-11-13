// Forwards tool plugin routes to the desktop shell.
//
// A tool plugin's host half runs in the desktop shell, where it may serve HTTP routes under
// `/api/plugins/<name>` (the DeepSeek Harness `webServer` contract). Its workspace half calls those
// with same-origin relative URLs, which land here. The workspace tells this module where the shell's
// loopback plugin server listens; every request under a registered prefix is then piped there with the
// server's token, and everything else continues to the daemon's own routes.
//
// The forwarding target lives in memory only: the workspace registers it again after a daemon restart.
import { request as httpRequest } from 'node:http';
import type { Express, NextFunction, Request, Response } from 'express';
import {
  isToolPluginGatewayPrefix,
  TOOL_PLUGIN_GATEWAY_HEADER,
  TOOL_PLUGIN_GATEWAY_PATH,
  type ToolPluginGatewayRequest,
  type ToolPluginGatewayResponse,
} from '@open-design/contracts';
import { sendApiError } from '../http/api-errors.js';
import { requireLocalDaemonRequest } from '../http/local-daemon-request.js';

const MAX_PREFIXES = 64;
/** Headers that describe one hop and must not travel to the next. */
const HOP_HEADERS = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'host']);

/** The gateway target in a request body, or null when the body is not one. */
export function parseToolPluginGateway(body: unknown): ToolPluginGatewayRequest | null {
  if (typeof body !== 'object' || body === null) return null;
  const { port, token, prefixes } = body as Record<string, unknown>;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || token.length < 16 || token.length > 256) return null;
  if (!Array.isArray(prefixes) || prefixes.length > MAX_PREFIXES) return null;
  if (!prefixes.every((prefix): prefix is string => typeof prefix === 'string' && isToolPluginGatewayPrefix(prefix))) return null;
  return { port, token, prefixes: [...new Set(prefixes)] };
}

function forward(req: Request, res: Response, gateway: ToolPluginGatewayRequest): void {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value !== undefined && !HOP_HEADERS.has(name)) headers[name] = value;
  }
  headers.host = `127.0.0.1:${gateway.port}`;
  headers[TOOL_PLUGIN_GATEWAY_HEADER] = gateway.token;
  // The JSON body parser ahead of this route has already read a JSON body; send that one on.
  const parsedBody = req.readableEnded && req.body !== undefined ? Buffer.from(JSON.stringify(req.body)) : null;
  if (parsedBody) headers['content-length'] = String(parsedBody.length);

  const upstream = httpRequest(
    { host: '127.0.0.1', port: gateway.port, method: req.method, path: req.originalUrl, headers },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(res);
    },
  );
  upstream.on('error', () => {
    if (res.headersSent) res.destroy();
    else sendApiError(res, 502, 'UPSTREAM_UNAVAILABLE', 'The tool plugin host is not reachable');
  });
  res.on('close', () => {
    if (!res.writableEnded) upstream.destroy();
  });
  if (parsedBody) upstream.end(parsedBody);
  else req.pipe(upstream);
}

/**
 * Registers the gateway. Call it after the `/api` origin guard, so forwarded requests are held to the
 * same origin rules as the daemon's own routes, and before the routes that own `/api/plugins/:id`.
 */
export function registerToolPluginGatewayRoutes(app: Express): void {
  let gateway: ToolPluginGatewayRequest | null = null;

  app.put(TOOL_PLUGIN_GATEWAY_PATH, requireLocalDaemonRequest, (req, res) => {
    const next = parseToolPluginGateway(req.body);
    if (!next) {
      sendApiError(res, 400, 'BAD_REQUEST', 'Invalid tool plugin gateway');
      return;
    }
    gateway = next;
    const payload: ToolPluginGatewayResponse = { prefixes: next.prefixes };
    res.json(payload);
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    const current = gateway;
    if (!current || !current.prefixes.some(prefix => req.path === prefix || req.path.startsWith(`${prefix}/`))) {
      next();
      return;
    }
    forward(req, res, current);
  });
}
