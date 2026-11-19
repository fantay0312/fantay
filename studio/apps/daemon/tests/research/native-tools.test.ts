import { afterEach, expect, it, vi } from "vitest";
import { handleMcpToolCall, TOOL_DEFS } from "../../src/mcp.js";
import { FANTAY_PI_EXTENSION_SOURCE } from "../../src/runtimes/bundled-pi.js";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

it("exposes the same search tools to MCP and the built-in agent", () => {
  for (const name of [
    "web_search",
    "web_fetch",
    "smart_search",
    "smart_search_catalog",
  ]) {
    expect(TOOL_DEFS.some((tool) => tool.name === name)).toBe(true);
    expect(FANTAY_PI_EXTENSION_SOURCE).toContain(`name: '${name}'`);
  }
});

it("forwards native MCP search into the shared daemon API", async () => {
  const fetchMock = vi.fn(async (_url: unknown) =>
    Response.json({
      query: "question",
      summary: "answer",
      sources: [{ url: "https://example.org" }],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  const result = await handleMcpToolCall(
    "http://127.0.0.1:7456",
    "web_search",
    { query: "question" },
  );
  expect(fetchMock.mock.calls[0]?.[0]).toBe(
    "http://127.0.0.1:7456/api/search/search",
  );
  expect(result.content[0]).toMatchObject({
    type: "text",
    text: expect.stringContaining("https://example.org"),
  });
});

it('loads the built-in extension and executes its native search tool', async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const extension = new Function(FANTAY_PI_EXTENSION_SOURCE.replace('export default', 'return'))() as (pi: { registerTool: (tool: typeof tools[number]) => void }) => void;
  extension({ registerTool: tool => tools.push(tool) });
  vi.stubEnv('OD_DAEMON_URL', 'http://127.0.0.1:7456');
  vi.stubEnv('OD_TOOL_TOKEN', 'private-run-token');
  const fetchMock = vi.fn(async (_url: unknown, _init?: RequestInit) => Response.json({ summary: 'native result', sources: [] }));
  vi.stubGlobal('fetch', fetchMock);
  const result = await tools.find(tool => tool.name === 'web_search')!.execute('call-1', { query: 'question' }, new AbortController().signal);
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('http://127.0.0.1:7456/api/search/search');
  expect(fetchMock.mock.calls[0]?.[1]?.headers).toMatchObject({ authorization: 'Bearer private-run-token' });
  expect(result.content[0]?.text).toContain('native result');
});
