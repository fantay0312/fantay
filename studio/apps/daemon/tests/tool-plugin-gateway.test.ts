import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { TOOL_PLUGIN_GATEWAY_HEADER, TOOL_PLUGIN_GATEWAY_PATH } from '@open-design/contracts';
import { parseToolPluginGateway, registerToolPluginGatewayRoutes } from '../src/routes/tool-plugin-gateway.js';

const TOKEN = 'a-gateway-token-of-enough-length';
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk as Buffer));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** A stand-in for the desktop shell's plugin server: it echoes what the gateway sent. */
async function startPluginServer() {
  const origin = await listen(createServer(async (req, res) => {
    const body = await readBody(req);
    res.writeHead(req.headers[TOOL_PLUGIN_GATEWAY_HEADER] === TOKEN ? 200 : 403, { 'content-type': 'application/json', 'x-plugin': 'yes' });
    res.end(JSON.stringify({ method: req.method, url: req.url, body, type: req.headers['content-type'] ?? null }));
  }));
  return Number(new URL(origin).port);
}

async function startDaemon() {
  const app = express();
  app.use(express.json());
  registerToolPluginGatewayRoutes(app);
  // The daemon's own plugin route, which a plugin prefix has to win over.
  app.get('/api/plugins/:id', (req, res) => { res.json({ own: req.params.id }); });
  return listen(createServer(app));
}

function register(daemon: string, body: unknown) {
  return fetch(daemon + TOOL_PLUGIN_GATEWAY_PATH, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

describe('tool plugin gateway', () => {
  it('accepts only plugin prefixes on a loopback port', () => {
    const valid = { port: 4100, token: TOKEN, prefixes: ['/api/plugins/dsh-funny', '/api/plugins/@scope/notes'] };
    expect(parseToolPluginGateway(valid)).toEqual(valid);
    expect(parseToolPluginGateway({ ...valid, prefixes: ['/api/projects'] })).toBeNull();
    expect(parseToolPluginGateway({ ...valid, prefixes: ['/api/plugins/install'] })).toBeNull();
    expect(parseToolPluginGateway({ ...valid, prefixes: ['/api/plugins/a/b/c'] })).toBeNull();
    expect(parseToolPluginGateway({ ...valid, port: 0 })).toBeNull();
    expect(parseToolPluginGateway({ ...valid, token: 'short' })).toBeNull();
    expect(parseToolPluginGateway(null)).toBeNull();
  });

  it('forwards requests under a registered prefix and leaves the rest to the daemon', async () => {
    const port = await startPluginServer();
    const daemon = await startDaemon();

    expect(await (await fetch(`${daemon}/api/plugins/dsh-funny`)).json()).toEqual({ own: 'dsh-funny' });
    expect((await register(daemon, { port, token: TOKEN, prefixes: ['/api/projects'] })).status).toBe(400);
    const registered = await register(daemon, { port, token: TOKEN, prefixes: ['/api/plugins/dsh-funny'] });
    expect(await registered.json()).toEqual({ prefixes: ['/api/plugins/dsh-funny'] });

    const get = await fetch(`${daemon}/api/plugins/dsh-funny/feed?page=2`);
    expect(get.headers.get('x-plugin')).toBe('yes');
    expect(await get.json()).toMatchObject({ method: 'GET', url: '/api/plugins/dsh-funny/feed?page=2', body: '' });

    const json = await fetch(`${daemon}/api/plugins/dsh-funny/danmaku`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '你好' }),
    });
    expect(await json.json()).toMatchObject({ method: 'POST', body: '{"text":"你好"}', type: 'application/json' });

    const text = await fetch(`${daemon}/api/plugins/dsh-funny/raw`, {
      method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'plain body',
    });
    expect(await text.json()).toMatchObject({ method: 'POST', body: 'plain body' });

    expect(await (await fetch(`${daemon}/api/plugins/dsh-funny-other`)).json()).toEqual({ own: 'dsh-funny-other' });
  });

  it('answers 502 when the plugin server is gone', async () => {
    const daemon = await startDaemon();
    const gone = createServer();
    const origin = await listen(gone);
    await new Promise(resolve => gone.close(resolve));
    servers.splice(servers.indexOf(gone), 1);
    await register(daemon, { port: Number(new URL(origin).port), token: TOKEN, prefixes: ['/api/plugins/dsh-funny'] });
    expect((await fetch(`${daemon}/api/plugins/dsh-funny/feed`)).status).toBe(502);
  });
});
