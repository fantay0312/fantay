// SPDX-License-Identifier: Apache-2.0
// Amendment C6: style samples and one-pass production use the desktop frame renderer when the
// daemon has one (HYPERFRAMES_BROWSER_PATH keeps priority, as in renderHyperFrames), and the web
// learns availability from `GET /api/movie/integration?include=capabilities`.
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMovieDocument, type MovieDocument } from "@open-design/contracts";
import type {
  DesktopRenderFramesInput,
  DesktopRenderFramesResult,
} from "@open-design/sidecar-proto";
import {
  injectPreviewSampleTimes,
  moviePreviewAvailability,
  moviePreviewFrameName,
  resolveMoviePreviewRenderer,
  silencePreviewAudio,
} from "../../src/movie/preview-renderer.js";
import {
  moviePreviewTimes,
  previewMovieStyle,
} from "../../src/movie/style-preview.js";
import { readMovie, saveMovie } from "../../src/movie/store.js";
import { registerMovieRoutes } from "../../src/routes/movie.js";

vi.mock("../../src/media/hyperframes-scaffold.js", () => ({
  scaffoldHyperFramesComposition: vi.fn(
    async ({ projectDir, compositionDir }: { projectDir: string; compositionDir: string }) => {
      const dir = path.join(projectDir, compositionDir);
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "gsap.min.js"), "/* gsap */");
    },
  ),
}));
// Call-through spy: the renderer tests run the real function, the route tests stub one call.
vi.mock("../../src/movie/style-preview.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/movie/style-preview.js")>();
  return { ...actual, previewMovieStyle: vi.fn(actual.previewMovieStyle) };
});

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");

const dirs: string[] = [];
async function temp(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

beforeEach(() => {
  vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "");
  vi.mocked(previewMovieStyle).mockClear();
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A desktop renderer double: writes `frameCount` PNG files the way frame-capture.ts names them. */
function fakeDesktop(frameCount: number, result: Partial<DesktopRenderFramesResult> = {}) {
  return vi.fn(async (input: DesktopRenderFramesInput): Promise<DesktopRenderFramesResult> => {
    await mkdir(input.outputDir, { recursive: true });
    for (let i = 0; i < frameCount; i += 1)
      await writeFile(path.join(input.outputDir, `frame-${String(i).padStart(8, "0")}.png`), `png-${i}`);
    return {
      ok: true,
      fps: 1,
      duration: frameCount,
      frameCount,
      framePattern: path.join(input.outputDir, "frame-%08d.png"),
      width: input.width,
      height: input.height,
      ...result,
    };
  });
}

describe("renderer rule", () => {
  it("keeps HYPERFRAMES_BROWSER_PATH first and requires live desktop readiness for availability", async () => {
    const desktop = vi.fn();
    expect(resolveMoviePreviewRenderer(desktop, { HYPERFRAMES_BROWSER_PATH: "/opt/chrome" })).toEqual({ kind: "browser" });
    expect(resolveMoviePreviewRenderer(desktop, {})).toEqual({ kind: "desktop", render: desktop });
    expect(resolveMoviePreviewRenderer(null, { HYPERFRAMES_BROWSER_PATH: "   " })).toBeNull();
    expect(resolveMoviePreviewRenderer(undefined, {})).toBeNull();
    expect(await moviePreviewAvailability(null, {})).toEqual({ available: false, renderer: null });
    expect(await moviePreviewAvailability(desktop, {})).toEqual({ available: false, renderer: null });
    expect(await moviePreviewAvailability(desktop, {}, async () => true)).toEqual({ available: true, renderer: "desktop" });
    expect(await moviePreviewAvailability(desktop, {}, async () => false)).toEqual({ available: false, renderer: null });
    const probe = vi.fn(async () => { throw new Error("offline"); });
    expect(await moviePreviewAvailability(desktop, {}, probe)).toEqual({ available: false, renderer: null });
    probe.mockClear();
    expect(await moviePreviewAvailability(null, { HYPERFRAMES_BROWSER_PATH: "/opt/chrome" }, probe)).toEqual({
      available: true,
      renderer: "browser",
    });
    expect(probe).not.toHaveBeenCalled();
  });

  it("names samples like the HyperFrames CLI snapshot", () => {
    expect(moviePreviewFrameName(0, 0.85)).toBe("frame-00-at-0.85s.png");
    expect(moviePreviewFrameName(11, 4.123456)).toBe("frame-11-at-4.123s.png");
  });

  it("remaps the frame bridge so a 1 fps capture visits each sample time", async () => {
    const html = injectPreviewSampleTimes(
      "<html><body><script>window.__seen=[];window.__odFrameRenderer={ready:async()=>({duration:12,fps:30}),seek:async(t)=>{window.__seen.push(t)}};</script></body></html>",
      [0.5, 1.25, 3],
    );
    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const bridge = dom.window.__odFrameRenderer;
    expect(await bridge.ready()).toEqual({ duration: 3, fps: 1 });
    await bridge.seek(1, 1);
    await bridge.seek(2);
    await bridge.seek(9, 9);
    expect(dom.window.__seen).toEqual([1.25, 3, 3]);
    dom.window.close();
  });

  it("silences audio for stills and leaves silent documents untouched", () => {
    const silent = "<html><body><p>x</p></body></html>";
    expect(silencePreviewAudio(silent)).toBe(silent);
    const out = silencePreviewAudio('<html><body><audio id="a1" src="a.mp3" data-start="0"></audio></body></html>');
    expect(out).not.toContain("<audio");
    expect(out).toContain('<span hidden="" id="a1"></span>');
  });
});

describe("previewMovieStyle with the desktop renderer", () => {
  it("renders the stills through the desktop app's Chromium and caches them", async () => {
    const dir = await temp("movie-preview-desktop-");
    const doc = createMovieDocument("Desktop samples");
    const options = { motion: true };
    const times = moviePreviewTimes(doc, options);
    const render = fakeDesktop(times.length);

    const frames = await previewMovieStyle(dir, doc, options, render);

    expect(render).toHaveBeenCalledTimes(1);
    const input = render.mock.calls[0]![0];
    expect(input).toMatchObject({ fps: 1, width: 1920, height: 1080 });
    expect(input.baseHref).toMatch(/^file:\/\/.*\/motion-source\/style-[0-9a-f]{16}\/$/);
    expect(input.html).toContain("data-fantay-preview-samples");
    expect(input.html).toContain(JSON.stringify(times));
    expect(input.html).toContain("__odFrameRenderer");
    expect(input.html).not.toMatch(/<audio\b/);
    expect(frames).toHaveLength(times.length);
    frames.forEach((frame, i) => {
      expect(frame).toMatch(/^motion-source\/style-[0-9a-f]{16}\/samples\//);
      expect(frame.endsWith(moviePreviewFrameName(i, times[i]!))).toBe(true);
    });
    expect(await readFile(path.join(dir, frames[1]!), "utf8")).toBe("png-1");

    expect(await previewMovieStyle(dir, doc, options, render)).toEqual(frames);
    expect(render).toHaveBeenCalledTimes(1);
  });

  it("reports a desktop that cannot render as unavailable and writes no samples", async () => {
    const dir = await temp("movie-preview-desktop-");
    const doc = createMovieDocument("Not running");
    const render = fakeDesktop(0, {
      ok: false,
      error: "Fantay desktop is not running.",
      errorCode: "FRAME_RENDERER_NOT_READY",
    });
    await expect(previewMovieStyle(dir, doc, {}, render)).rejects.toMatchObject({
      status: 503,
      message: "Fantay desktop is not running.",
    });
    const roots = await readdir(path.join(dir, "motion-source"));
    const samples = await readdir(path.join(dir, "motion-source", roots[0]!, "samples"));
    expect(samples.filter((name) => name.endsWith(".png"))).toEqual([]);
  });

  it("refuses with 503 when neither a renderer nor HYPERFRAMES_BROWSER_PATH exists", async () => {
    const dir = await temp("movie-preview-none-");
    await expect(previewMovieStyle(dir, createMovieDocument(), {})).rejects.toMatchObject({
      status: 503,
    });
  });
});

describe("movie routes (C6)", () => {
  let root: string;
  const handlers = new Map<string, (req: any, res: any) => Promise<void> | void>();
  let generateMedia: ReturnType<typeof vi.fn>;

  function register(media: Record<string, unknown>) {
    handlers.clear();
    const app = {
      get: (route: string, ...fn: any[]) => handlers.set("GET " + route, fn.at(-1)),
      post: (route: string, ...fn: any[]) => handlers.set("POST " + route, fn.at(-1)),
      put: () => {},
    };
    registerMovieRoutes(
      app as never,
      {
        db: {},
        http: {
          requireLocalDaemonRequest: () => {},
          resolvedPortRef: { current: 7456 },
          sendApiError: (res: any, status: number, _code: string, message: string) =>
            res.status(status).json({ error: message }),
        },
        paths: { PROJECTS_DIR: root, PROJECT_ROOT: root, OD_BIN: "/bin/od" },
        projectStore: { getProject: () => ({ id: "film", metadata: {} }) },
        projectFiles: { resolveProjectDir: () => root },
        media,
        authorizeProjectRequest: async () => true,
      } as never,
    );
  }

  function response() {
    return {
      statusCode: 200,
      body: null as any,
      headersSent: false,
      status(n: number) {
        this.statusCode = n;
        return this;
      },
      json(value: any) {
        this.body = value;
        this.headersSent = true;
        return this;
      },
    };
  }

  async function call(method: string, route: string, req: Record<string, unknown> = {}) {
    const res = response();
    await handlers.get(`${method} ${route}`)!(
      { params: { id: "film" }, body: {}, query: {}, get: () => undefined, ...req },
      res,
    );
    return res;
  }

  beforeEach(async () => {
    root = await temp("movie-routes-c6-");
    generateMedia = vi.fn(async () => ({ name: "film.mp4" }));
    await saveMovie(root, { expectedRevision: 0, document: createMovieDocument("Original") });
  });

  it("adds preview availability to the integration response only when asked", async () => {
    register({ generateMedia });
    const plain = await call("GET", "/api/movie/integration");
    expect(plain.body.mcpServers["fantay-movie"].args).toContain("mcp");
    expect(plain.body).not.toHaveProperty("capabilities");

    const none = await call("GET", "/api/movie/integration", { query: { include: "capabilities" } });
    expect(none.body.capabilities).toEqual({ preview: { available: false, renderer: null } });

    register({ generateMedia, desktopFrameRenderer: fakeDesktop(1), desktopFrameRendererReady: async () => true });
    const desktop = await call("GET", "/api/movie/integration", { query: { include: "capabilities" } });
    expect(desktop.body.capabilities).toEqual({ preview: { available: true, renderer: "desktop" } });
    expect(desktop.body.mcpServers).toEqual(plain.body.mcpServers);

    vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "/opt/chrome");
    const browser = await call("GET", "/api/movie/integration", { query: { include: "capabilities" } });
    expect(browser.body.capabilities.preview).toEqual({ available: true, renderer: "browser" });
  });

  it("passes the desktop renderer to manual style samples", async () => {
    const desktopFrameRenderer = fakeDesktop(1);
    register({ generateMedia, desktopFrameRenderer });
    const doc = (await readMovie(root)) as MovieDocument;
    const times = moviePreviewTimes(doc, { motion: true });
    vi.mocked(previewMovieStyle).mockResolvedValueOnce(times.map((_, i) => `motion-source/style-x/samples/${i}.png`));
    const res = await call("POST", "/api/projects/:id/movie/style-preview", { body: { motion: true } });
    expect(res.statusCode).toBe(200);
    expect(vi.mocked(previewMovieStyle).mock.calls[0]?.[3]).toBe(desktopFrameRenderer);
  });

  it("uses the desktop renderer for one-pass production", async () => {
    const desktopFrameRenderer = fakeDesktop(1);
    register({ generateMedia, desktopFrameRenderer });
    vi.mocked(previewMovieStyle).mockResolvedValueOnce(["sample.png"]);
    let d = (await readMovie(root))!;
    await call("POST", "/api/projects/:id/movie/production/authorize", {
      body: { enabled: true, expectedRevision: d.revision },
    });
    d = (await readMovie(root))!;
    const edited = await saveMovie(root, {
      expectedRevision: d.revision,
      document: { ...d, shots: d.shots.map((s, i) => (i ? s : { ...s, title: "A new story" })) },
    });
    const started = await call("POST", "/api/projects/:id/movie/production/start", {
      body: { expectedRevision: edited.revision },
    });
    expect(started.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await readMovie(root))?.production?.status).toBe("done"));
    const [, , options, renderer] = vi.mocked(previewMovieStyle).mock.calls[0]!;
    expect(options).toEqual({ storyboard: true });
    expect(renderer).toBe(desktopFrameRenderer);
    expect(generateMedia).toHaveBeenCalledTimes(1);
  });

  it("reports one-pass production failure without any renderer", async () => {
    register({ generateMedia });
    let d = (await readMovie(root))!;
    await call("POST", "/api/projects/:id/movie/production/authorize", {
      body: { enabled: true, expectedRevision: d.revision },
    });
    d = (await readMovie(root))!;
    const edited = await saveMovie(root, {
      expectedRevision: d.revision,
      document: { ...d, shots: d.shots.map((s, i) => (i ? s : { ...s, title: "Another story" })) },
    });
    await call("POST", "/api/projects/:id/movie/production/start", {
      body: { expectedRevision: edited.revision },
    });
    await vi.waitFor(async () => expect((await readMovie(root))?.production?.status).toBe("failed"));
    expect((await readMovie(root))?.production?.message).toContain("HYPERFRAMES_BROWSER_PATH");
    expect(generateMedia).not.toHaveBeenCalled();
  });
});
