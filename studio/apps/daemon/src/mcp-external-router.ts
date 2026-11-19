import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { CallToolRequestSchema, ListToolsRequestSchema, ToolListChangedNotificationSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { catalogPage, shortDescription } from './capability-discovery.js';
import { readMcpConfig, routedMcpEntries, routedTokenMatchesServer, sanitizeMcpConfig, type McpServerConfig } from './mcp-config.js';
import { isTokenExpired, readAllTokens } from './mcp-tokens.js';
import { isAbsolute } from 'node:path';
import { receiveRouterEntries } from './mcp-router-handoff.js';
import { describeTool, findTools, lookupTool, objectInput, resultPageTool, RoutedResults, routeOffset, routeQuery, routerTools, targetArguments } from './mcp-discovery.js';

const hubTools = [
  resultPageTool,
  { name: 'find_servers', description: 'Find enabled MCP servers by name, or browse. Does not connect to them.',
    inputSchema: objectInput({ query: { type: 'string' }, offset: { type: 'integer', minimum: 0 } }),
    annotations: { readOnlyHint: true } },
  ...routerTools.map(tool => ({ ...tool, inputSchema: objectInput({
    ...tool.inputSchema.properties, server: { type: 'string', description: 'ID from find_servers.' },
  }, [...tool.inputSchema.required, 'server']) })),
];

function transportFor(entry: McpServerConfig) {
  if (entry.transport === 'stdio') return new StdioClientTransport({
    command: entry.command!, args: entry.args ?? [], ...(entry.env ? { env: entry.env } : {}), stderr: 'ignore',
  });
  const url = new URL(entry.url!);
  const options = { requestInit: { headers: entry.headers ?? {}, redirect: 'error' as const } };
  return entry.transport === 'sse' ? new SSEClientTransport(url, options) : new StreamableHTTPClientTransport(url, options);
}

async function toolCatalog(client: Client) {
  const tools: Tool[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : {}, { timeout: 15_000 });
    tools.push(...page.tools.filter(t => {
      const ui = t._meta?.ui as { visibility?: string[] } | undefined;
      return !Array.isArray(ui?.visibility) || ui.visibility.includes('model');
    }));
    cursor = page.nextCursor;
    if (cursor && (cursors.has(cursor) || cursors.size >= 256)) throw new Error('Invalid upstream catalog pagination');
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return tools;
}

type ServerEntries = McpServerConfig[] | (() => Promise<McpServerConfig[]>);

export function createExternalMcpRouter(entries: ServerEntries) {
  const pages = new RoutedResults();
  const connections = new Map<string, { client: Client; config: string; catalog: () => Promise<Tool[]> }>();
  function connect(entry: McpServerConfig) {
    const existing = connections.get(entry.id);
    if (existing) return existing;
    const client = new Client({ name: 'fantay-tool-router', version: '1' }, { capabilities: {} });
    const transport = transportFor(entry);
    const forget = () => {
      if (connections.get(entry.id)?.client === client) connections.delete(entry.id);
    };
    client.onclose = forget;
    // The SDK's HTTP transport implements Transport but exposes sessionId as
    // string | undefined, while its interface declares that field optional.
    let timer: ReturnType<typeof setTimeout>;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('MCP connection timed out')), 15_000);
      timer.unref();
    });
    // Legacy SSE can wait for its initial endpoint event before the SDK
    // starts timing the initialize request.
    const ready = Promise.race([client.connect(transport as Transport, { timeout: 15_000 }), deadline]).catch(async error => {
      forget();
      await transport.close().catch(() => {});
      throw error;
    }).finally(() => clearTimeout(timer));
    let cached: { until: number; value: Promise<Tool[]> } | undefined;
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => { cached = undefined; });
    const state = { client, config: JSON.stringify(entry), async catalog() {
      await ready;
      if (cached && cached.until > Date.now()) return cached.value;
      const value = toolCatalog(client).catch(error => {
        if (cached?.value === value) cached = undefined;
        throw error;
      });
      cached = { until: Date.now() + 30_000, value };
      return value;
    } };
    connections.set(entry.id, state);
    return state;
  }
  const server = new Server({ name: 'fantay-tool-router', version: '1' }, {
    capabilities: { tools: {} },
    instructions: 'Use find_servers, find_tools on one server, describe_tool for one schema, then call_tool with the same server and name.',
  });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: hubTools }));
  const result = (value: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(value) }] });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args = {} } = req.params;
    const error = (text: string) => ({ isError: true, content: [{ type: 'text' as const, text }] });
    try {
      if (name === resultPageTool.name) return result(pages.read(args));
      const enabled = (typeof entries === 'function' ? await entries() : entries)
        .filter(entry => entry.enabled && entry.onDemand);
      if (typeof entries === 'function') {
        // A standalone host can outlive a settings edit, OAuth rotation or removal.
        for (const [id, state] of connections) {
          if (JSON.stringify(enabled.find(s => s.id === id)) !== state.config) {
            connections.delete(id);
            await state.client.close();
          }
        }
      }
      if (name === 'find_servers') {
        const page = catalogPage(enabled, routeQuery(args), routeOffset(args), s => ({ id: s.id, terms: [s.label ?? '', s.templateId ?? ''] }));
        return result({ ...page, items: page.items.map(s => ({ id: s.id, label: shortDescription(s.label ?? s.id) })) });
      }
      if (!routerTools.some(tool => tool.name === name)) return error('Unknown routing tool.');
      const entry = enabled.find(s => s.id === args.server);
      if (!entry) return error('Unknown server. Use find_servers to select an enabled server.');
      const state = connect(entry);
      let tools: Tool[];
      try {
        tools = await state.catalog();
      } catch {
        return error(`Cannot read the tool catalog for ${entry.id}. Check its connection and authentication in Fantay.`);
      }
      if (name === 'find_tools') return result(findTools(tools, args));
      if (name === 'describe_tool') return result(describeTool(tools, args));
      const tool = lookupTool(tools, args);
      const input = targetArguments(args);
      try {
        const reply = await state.client.callTool({ name: tool.name, arguments: input }, undefined, { signal: extra.signal });
        return pages.bound(reply);
      } catch {
        // Never retry a tool call here. A disconnected upstream may have committed a write.
        return error(`Call to ${entry.id}/${tool.name} did not return a result. Check its state before retrying.`);
      }
    } catch (cause) { return error(cause instanceof Error ? cause.message : 'Invalid routing arguments'); }
  });
  return { server, async close() {
    await Promise.allSettled(Array.from(connections.values(), state => state.client.close()));
    await server.close();
  } };
}

export async function runExternalMcpRouter(mode: 'run' | 'standalone') {
  let entries: ServerEntries;
  if (mode === 'run') {
    const config = await receiveRouterEntries(process.env);
    delete process.env.FANTAY_MCP_ROUTE_TOKEN;
    delete process.env.FANTAY_MCP_ROUTE_PORT;
    entries = sanitizeMcpConfig({ servers: config }).servers;
  } else {
    if (process.env.OD_STOCK_RUN_ID) throw new Error('Use the MCP connections supplied to this Fantay run.');
    const dir = process.env.OD_DATA_DIR;
    if (!dir || !isAbsolute(dir)) throw new Error('Use the OD_DATA_DIR supplied by the Fantay MCP install configuration.');
    entries = async () => {
      const { servers } = await readMcpConfig(dir);
      const stored = await readAllTokens(dir);
      const tokens = Object.fromEntries(servers.flatMap(server => {
        const token = stored[server.id];
        return server.enabled && server.onDemand && token && !isTokenExpired(token) && routedTokenMatchesServer(server, token.serverOrigin ?? token.resourceUrl)
          ? [[server.id, token.accessToken]] : [];
      }));
      return routedMcpEntries(servers, tokens);
    };
  }
  const router = createExternalMcpRouter(entries);
  const transport = new StdioServerTransport();
  let stop!: () => void;
  const closed = new Promise<void>(resolve => { stop = resolve; });
  process.stdin.once('end', stop);
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  router.server.onclose = stop;
  try {
    await router.server.connect(transport);
    await closed;
  } finally {
    process.stdin.off('end', stop);
    process.off('SIGTERM', stop);
    process.off('SIGINT', stop);
    await router.close();
  }
}
