import { createRequire } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMovieDocument } from "@open-design/contracts";

const state = vi.hoisted(() => ({
  handlers: new Map<string, (input: any) => Promise<any>>(),
}));
vi.mock("@modelcontextprotocol/sdk/server/index.js", () => ({
  Server: class {
    setRequestHandler(schema: string, fn: (input: any) => Promise<any>) {
      state.handlers.set(schema, fn);
    }
    async connect() {
      throw new Error("test transport stop");
    }
  },
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: class {},
}));
vi.mock("@modelcontextprotocol/sdk/types.js", () => ({
  CallToolRequestSchema: "call",
  ListResourcesRequestSchema: "resources",
  ListToolsRequestSchema: "tools",
  ReadResourceRequestSchema: "read",
}));
vi.mock("../../src/movie/movie-cli.js", () => ({
  movieHttp: vi.fn(),
  waitForMovieRender: vi.fn(),
}));
import { movieHttp } from "../../src/movie/movie-cli.js";
import { startMovieMcp } from "../../src/movie/movie-mcp.js";
const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const call = (name: string, args: Record<string, unknown> = {}) =>
  state.handlers.get("call")!({ params: { name, arguments: args } });
beforeEach(async () => {
  state.handlers.clear();
  vi.mocked(movieHttp).mockReset();
  await expect(
    startMovieMcp("http://127.0.0.1:7456", "http://127.0.0.1:5173", {
      "x-workspace-id": "test",
    }),
  ).rejects.toThrow("test transport stop");
});
afterEach(() => vi.unstubAllGlobals());
describe("Movie MCP source payloads", () => {
  it("pools full-rate waveforms to 600 bins in both the text and the structured result", async () => {
    const peaks = Array.from({ length: 24000 }, (_, i) => (i === 12345 ? 1 : 0.25));
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ sources: [{ assetId: "a", frames: [], audioPeaks: peaks }, { assetId: "silent", frames: [] }] }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("get_movie_sources", { projectId: "film" });
    expect(fetchMock.mock.calls[0]![0]).toBe("http://127.0.0.1:7456/api/projects/film/movie/sources");
    const [source, silent] = result.structuredContent.sources;
    expect(source.audioPeaks).toHaveLength(600);
    expect(source.audioPeaks.indexOf(1)).toBe(308);
    expect(silent).toEqual({ assetId: "silent", frames: [] });
    expect(JSON.parse(result.content[0].text)).toEqual(result.structuredContent);
    fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ assetId: "a", frames: [], audioPeaks: peaks, transcript: [] }) });
    const transcribed = await call("transcribe_movie_source", { projectId: "film", assetId: "a" });
    expect(transcribed.structuredContent).toMatchObject({ assetId: "a", transcript: [] });
    expect(transcribed.structuredContent.audioPeaks).toHaveLength(600);
  });
});
describe("Movie MCP home and embedded surfaces", () => {
  it('exposes live feedback without render authorization through the same HTTP contract', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ prompt: 'Edit selected feedback', revision: 5, noteIds: ['n1'] }) });
    vi.stubGlobal('fetch', fetchMock);
    const tools = await state.handlers.get('tools')!({});
    expect(tools.tools.some((t: { name: string }) => t.name === 'movie_feedback_prompt')).toBe(true);
    const result = await call('movie_feedback_prompt', { projectId: 'film', expectedRevision: 5, noteIds: ['n1'] });
    expect(result.isError).not.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:7456/api/projects/film/movie/feedback-prompt', expect.objectContaining({ method: 'POST', body: JSON.stringify({ expectedRevision: 5, noteIds: ['n1'] }) }));
  });
  it("exposes localized edits and undo through the same revision-checked routes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          document: { ...createMovieDocument("Edited"), revision: 5 },
          receipt: { changes: [] },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const result = await call("edit_movie", {
      projectId: "film",
      expectedRevision: 4,
      label: "Caption",
      operations: [
        {
          op: "update-caption",
          shotId: "s",
          captionId: "c",
          changes: { text: "New" },
        },
      ],
    });
    expect(result.structuredContent.receipt).toEqual({ changes: [] });
    expect(fetchMock.mock.calls[0]![0]).toContain("/film/movie/edits");
    await call("undo_movie_edit", { projectId: "film", expectedRevision: 5 });
    expect(fetchMock.mock.calls[1]![0]).toContain("/film/movie/history/undo");
    expect(JSON.parse(fetchMock.mock.calls[1]![1].body)).toEqual({
      expectedRevision: 5,
    });
  });
  it("returns separate full-page and embedded destinations and prepares real editing context", async () => {
    const document = createMovieDocument("Story");
    vi.mocked(movieHttp).mockResolvedValue({ document });
    const opened = await call("open_movie_studio", { projectId: "film 1" });
    expect(opened.structuredContent).toMatchObject({
      url: "http://127.0.0.1:5173/projects/film%201/files/movie-studio.json",
      embedUrl: "http://127.0.0.1:5173/movie-app/film%201",
    });
    const home = await call("open_movie_studio", {});
    expect(home.structuredContent).toMatchObject({
      url: "http://127.0.0.1:5173/create/animation",
      embedUrl: "http://127.0.0.1:5173/movie-app",
      projectId: null,
    });
    const read = await call("get_movie", { projectId: "film 1" });
    expect(read.structuredContent.url).toBe(
      "http://127.0.0.1:5173/projects/film%201/files/movie-studio.json",
    );
    const task = await call("get_movie_task", {
      projectId: "film 1",
      task: "storyboard",
    });
    expect(task.structuredContent.prompt).toContain("Story");
    expect(task.structuredContent.prompt).toContain("不要自动确认");
    expect(movieHttp).toHaveBeenCalledWith(
      "http://127.0.0.1:7456",
      "film 1",
      "GET",
      undefined,
      { "x-workspace-id": "test" },
    );
  });
  it("reuses a saved personal style and rejects an invalid source before creating a project", async () => {
    const document = createMovieDocument("Source");
    document.savedStyles = [
      { ...document.style, id: "personal-1", name: "My style" },
    ];
    vi.mocked(movieHttp).mockResolvedValue({ document });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ project: { id: "new-film" } }),
      })
      .mockResolvedValue({
        ok: true,
        json: async () => ({
          document: { ...document, style: document.savedStyles[0] },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    const invalid = await call("create_movie", {
      name: "New",
      mode: "personal",
      styleId: "missing",
      sourceProjectId: "source",
    });
    expect(invalid.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    const result = await call("create_movie", {
      name: "New",
      mode: "personal",
      styleId: "personal-1",
      sourceProjectId: "source",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.document.style.name).toBe("My style");
    expect(result.structuredContent.embedUrl).toBe(
      "http://127.0.0.1:5173/movie-app/new-film",
    );
    expect(result.structuredContent.url).toBe(
      "http://127.0.0.1:5173/projects/new-film/files/movie-studio.json",
    );
    expect(
      vi.mocked(movieHttp).mock.calls.find((c) => c[2] === "PUT")?.[3],
    ).toMatchObject({
      document: {
        style: { id: "personal-1", name: "My style" },
        savedStyles: [],
      },
    });
  });
  it("uses a chrome-free iframe for both host payload forms and rejects other origins", async () => {
    const result = await state.handlers.get("read")!({
      params: { uri: "ui://fantay/movie-studio.html" },
    });
    const dom = new JSDOM(result.contents[0].text, {
      url: "https://host.example",
      runScripts: "dangerously",
    });
    const w = dom.window;
    const frame = w.document.querySelector("iframe");
    expect(frame.src).toBe("http://127.0.0.1:5173/movie-app");
    const send = (params: unknown) =>
      w.dispatchEvent(
        new w.MessageEvent("message", {
          source: w.parent,
          data: {
            jsonrpc: "2.0",
            method: "ui/notifications/tool-result",
            params,
          },
        }),
      );
    send({
      result: {
        structuredContent: {
          embedUrl: "http://127.0.0.1:5173/movie-app/one",
          url: "http://127.0.0.1:5173/create/animation/one",
        },
      },
    });
    expect(frame.src).toContain("/movie-app/one");
    expect(w.document.querySelector("a").href).toContain(
      "/create/animation/one",
    );
    send({
      structuredContent: { embedUrl: "http://127.0.0.1:5173/movie-app/two" },
    });
    expect(frame.src).toContain("/movie-app/two");
    expect(w.document.querySelector("a").href).toBe(
      "http://127.0.0.1:5173/projects/two/files/movie-studio.json",
    );
    send({
      structuredContent: {
        embedUrl: "https://untrusted.example/movie-app/other",
      },
    });
    expect(frame.src).toContain("/movie-app/two");
    send({
      structuredContent: {
        embedUrl: "http://127.0.0.1:5173/movies/whole-shell",
      },
    });
    expect(frame.src).toContain("/movie-app/two");
    w.close();
  });
});
