import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createExternalMcpRouter } from '../src/mcp-external-router.js';
import { routeExternalMcpServers, routedTokenMatchesServer, type McpServerConfig } from '../src/mcp-config.js';
import { receiveRouterEntries } from '../src/mcp-router-handoff.js';
import { describeTool, findTools } from '../src/mcp-discovery.js';
import { compactMcpTools, TOOL_DEFS } from '../src/mcp.js';
import { findSkills, readSkillPage } from '../src/skills/discovery.js';
import { listSkills } from '../src/skills.js';

describe('capability routing', () => {
  it('keeps the first-party handshake and each discovery page bounded as the catalog grows', () => {
    expect(JSON.stringify(compactMcpTools).length).toBeLessThan(JSON.stringify(TOOL_DEFS).length / 3);
    const tools = Array.from({ length: 101 }, (_, i) => ({
      name: 'asset_' + i, description: 'd'.repeat(300), inputSchema: { type: 'object', description: 'schema-only'.repeat(1100) },
    }));
    const first = findTools(tools, {});
    expect(first.items).toHaveLength(6);
    expect(first.nextOffset).toBe(6);
    expect(JSON.stringify(first)).not.toContain('schema-only');
    expect(findTools(tools, { query: 'asset_51' }).items[0]?.name).toBe('asset_51');
    const page = describeTool(tools, { name: 'asset_51' });
    expect('schemaText' in page && page.schemaText.length).toBe(6000);
    expect(findTools(tools, { query: 'missing' }).items).toEqual([]);
    expect(() => findTools(tools, { offset: -1 })).toThrow(/offset/);
  });

  it('returns skill summaries, exact body pages and only in-skill reference text', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'fantay-skill-pages-'));
    try {
      const dir = path.join(root, 'motion');
      await mkdir(path.join(dir, 'references'), { recursive: true });
      await writeFile(path.join(dir, 'SKILL.md'), '---\nname: motion\ndescription: Animation\nzh_description: 动画技巧\n---\nBODY_MARKER');
      const ref = 'a'.repeat(3999) + '🎨' + 'end';
      await writeFile(path.join(dir, 'references', 'color.md'), ref);
      await symlink(path.join(dir, 'SKILL.md'), path.join(dir, 'references', 'linked.md'));
      const skills = await listSkills(root, { firstRootSource: 'built-in' });
      const found = findSkills(skills, '动画', 0);
      expect(found.items[0]?.id).toBe('motion');
      expect(JSON.stringify(found)).not.toContain('BODY_MARKER');
      const skill = skills[0]!;
      expect(await readSkillPage(skill, 'references', 0)).toMatchObject({ files: ['references/color.md'] });
      const p1 = await readSkillPage(skill, 'references/color.md', 0);
      const p2 = await readSkillPage(skill, 'references/color.md', p1.nextOffset!);
      expect(p1.text! + p2.text!).toEqual(ref);
      expect(p2.nextOffset).toBeNull();
      await expect(readSkillPage(skill, 'references/linked.md', 0)).rejects.toThrow();
      await expect(readSkillPage(skill, 'references/../SKILL.md', 0)).rejects.toThrow();
      await expect(readSkillPage(skill, 'SKILL.md', -1)).rejects.toThrow();
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('connects only the selected server, honors upstream pagination, and pages a result without replaying its call', async () => {
    const methods: string[] = [];
    const authHeaders: Array<string | undefined> = [];
    const upstream = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      if (!chunks.length) { res.writeHead(405).end(); return; }
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      methods.push(msg.method);
      authHeaders.push(req.headers.authorization);
      if (msg.id === undefined) { res.writeHead(202).end(); return; }
      let payload: unknown;
      if (msg.method === 'initialize') payload = { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } };
      if (msg.method === 'tools/list') payload = msg.params?.cursor === 'next'
        ? { tools: [{ name: 'paint', description: 'Paint a sample', inputSchema: { type: 'object' } }] }
        : { tools: [], nextCursor: 'next' };
      if (msg.method === 'tools/call') payload = { content: [{ type: 'text', text: String(msg.params.arguments.color).repeat(8000) }] };
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: payload }));
    });
    upstream.listen(0, '127.0.0.1');
    await once(upstream, 'listening');
    const port = (upstream.address() as { port: number }).port;
    const selected: McpServerConfig = { id: 'art', label: 'Design tools', enabled: true, onDemand: true, transport: 'http', url: `http://127.0.0.1:${port}`, authMode: 'oauth' };
    const direct = { ...selected, id: 'fantay-router', onDemand: false };
    expect(routedTokenMatchesServer(selected, selected.url)).toBe(true);
    expect(routedTokenMatchesServer(selected, 'https://other.example/')).toBe(false);
    const handoff = await routeExternalMcpServers([selected, direct, { ...selected, id: 'off', enabled: false }], { art: 'fixture-token' }, 'node', 'od');
    const [preserved, hub] = handoff.servers;
    expect(preserved).toEqual(direct);
    expect(hub?.id).not.toBe(direct.id);
    expect(JSON.stringify(hub)).not.toContain('fixture-token');
    await expect(receiveRouterEntries({ ...hub!.env, FANTAY_MCP_ROUTE_TOKEN: 'wrong' })).rejects.toThrow();
    const entries = await receiveRouterEntries(hub!.env!) as McpServerConfig[];
    let currentEntries = entries;
    const router = createExternalMcpRouter(async () => currentEntries);
    const client = new Client({ name: 'test', version: '1' });
    const [host, remote] = InMemoryTransport.createLinkedPair();
    try {
      await router.server.connect(remote);
      await client.connect(host);
      const call = async (name: string, args: Record<string, unknown>) => {
        const response = await client.callTool({ name, arguments: args });
        expect(response.isError).not.toBe(true);
        return JSON.parse((response.content as Array<{ text: string }>)[0]!.text);
      };
      expect((await client.listTools()).tools.map(t => t.name)).not.toContain('paint');
      const servers = await call('find_servers', {});
      expect(servers.items).toEqual([{ id: 'art', label: 'Design tools' }]);
      expect((await client.callTool({ name: 'find_tools', arguments: { server: 'off' } })).isError).toBe(true);
      expect(methods).toEqual([]);
      const matches = await call('find_tools', { server: 'art', query: 'paint' });
      expect(matches.items).toEqual([{ name: 'paint', description: 'Paint a sample' }]);
      expect((await call('describe_tool', { server: 'art', name: 'paint' })).inputSchema.type).toBe('object');
      const page = await call('call_tool', { server: 'art', name: 'paint', arguments: { color: 'x' } });
      expect(page.text).toHaveLength(6000);
      const tail = await call('read_result_page', { id: page.id, offset: page.nextOffset });
      expect(tail.text).toHaveLength(2000);
      expect(tail.nextOffset).toBeNull();
      expect(methods.filter(m => m === 'tools/call')).toHaveLength(1);
      expect(methods.filter(m => m === 'initialize')).toHaveLength(1);
      expect(methods.filter(m => m === 'tools/list')).toHaveLength(2);
      expect(authHeaders.every(h => h === 'Bearer fixture-token')).toBe(true);
      currentEntries = [];
      expect((await client.callTool({ name: 'call_tool', arguments: { server: 'art', name: 'paint', arguments: {} } })).isError).toBe(true);
      expect(methods.filter(m => m === 'tools/call')).toHaveLength(1);
    } finally {
      handoff.close?.();
      await client.close();
      await router.close();
      upstream.closeAllConnections();
      await new Promise<void>(resolve => upstream.close(() => resolve()));
    }
  });
});
