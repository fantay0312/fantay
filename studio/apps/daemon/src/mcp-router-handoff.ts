import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import type { McpServerConfig } from './mcp-config.js';

// Some hosts persist their launch configuration inside the user's project.
// Hand the router an expiring run capability. Upstream credentials stay in
// daemon memory until the intended child requests them over loopback.
export async function openRouterHandoff(entries: McpServerConfig[]) {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((req, res) => {
    if (req.method !== 'GET' || req.url !== '/' || req.headers.origin
      || req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(entries));
  });
  const ready = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await ready;
  server.unref();
  const port = (server.address() as AddressInfo).port;
  return {
    env: { FANTAY_MCP_ROUTE_PORT: String(port), FANTAY_MCP_ROUTE_TOKEN: token },
    close() {
      server.close();
      server.closeAllConnections();
    },
  };
}

export async function receiveRouterEntries(env: Record<string, string | undefined>) {
  const { FANTAY_MCP_ROUTE_PORT: port, FANTAY_MCP_ROUTE_TOKEN: token } = env;
  if (!port || !/^\d{1,5}$/.test(port) || Number(port) > 65535 || !token) {
    throw new Error('Start this run-scoped router through Fantay MCP settings.');
  }
  const response = await fetch(`http://127.0.0.1:${port}/`, {
    headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error('The MCP routing session is no longer available.');
  return await response.json() as unknown;
}
