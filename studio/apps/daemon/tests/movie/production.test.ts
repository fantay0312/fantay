import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import { saveMovie, readMovie, mutateMovie, applyMovieAction } from "../../src/movie/store.js";
import { registerMovieRoutes } from "../../src/routes/movie.js";
import { previewMovieStyle } from "../../src/movie/style-preview.js";
vi.mock("../../src/movie/style-preview.js", () => ({
  previewMovieStyle: vi.fn(async () => ["sample.png"]),
}));
vi.mock("../../src/media/hyperframes-scaffold.js", () => ({
  scaffoldHyperFramesComposition: vi.fn(
    async ({ projectDir, compositionDir }) => {
      await mkdir(path.join(projectDir, compositionDir), { recursive: true });
    },
  ),
}));
let root: string;
const handlers = new Map<string, (req: any, res: any) => Promise<void>>();
let render: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "movie-production-"));
  handlers.clear();
  render = vi.fn(async () => ({ name: "film.mp4" }));
  vi.mocked(previewMovieStyle).mockReset().mockResolvedValue(["sample.png"]);
  const app = {
    get: (route: string, ...fn: any[]) =>
      handlers.set("GET " + route, fn.at(-1)),
    post: (route: string, ...fn: any[]) =>
      handlers.set("POST " + route, fn.at(-1)),
    put: () => {},
  };
  registerMovieRoutes(
    app as never,
    {
      db: {},
      http: {
        requireLocalDaemonRequest: () => {},
        sendApiError: (
          res: any,
          status: number,
          _code: string,
          message: string,
        ) => res.status(status).json({ error: message }),
      },
      paths: { PROJECTS_DIR: root, PROJECT_ROOT: root },
      projectStore: { getProject: () => ({ id: "film", metadata: {} }) },
      projectFiles: { resolveProjectDir: () => root },
      media: { generateMedia: render },
      authorizeProjectRequest: async () => true,
    } as never,
  );
  await saveMovie(root, {
    expectedRevision: 0,
    document: createMovieDocument("Original"),
  });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
async function call(
  route: string,
  body: Record<string, unknown> = {},
  method = "POST",
) {
  const res = {
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
  await handlers.get(method + " /api/projects/:id/movie/production/" + route)!(
    { params: { id: "film" }, body },
    res,
  );
  return res;
}
async function armAndEdit() {
  let d = (await readMovie(root))!;
  await call("authorize", { enabled: true, expectedRevision: d.revision });
  d = (await readMovie(root))!;
  return saveMovie(root, {
    expectedRevision: d.revision,
    document: {
      ...d,
      shots: d.shots.map((s, i) =>
        i ? s : { ...s, title: "User requested story" },
      ),
    },
  });
}
describe("Authorized one-pass production", () => {
  it('prepares selected live feedback without mutating, rendering, or bypassing revision checks', async () => {
    const before = (await readMovie(root))!;
    const doc = await applyMovieAction(root, before.revision, { action: 'add-note', scope: 'time', time: 1, text: 'Move the heading', contentRevision: before.contentRevision });
    const handler = handlers.get('POST /api/projects/:id/movie/feedback-prompt')!;
    const response = () => ({ statusCode: 200, body: null as any, headersSent: false, status(code: number) { this.statusCode = code; return this; }, json(body: unknown) { this.body = body; return this; } });
    const res = response();
    await handler({ params: { id: 'film' }, body: { expectedRevision: doc.revision, noteIds: [doc.notes[0]!.id] } }, res);
    expect(res.statusCode).toBe(200);
    expect(res.body.prompt).toContain('Move the heading');
    expect(res.body.prompt).toContain('do not start production');
    expect((await readMovie(root))!.revision).toBe(doc.revision);
    expect((await readMovie(root))!.production).toBeUndefined();
    expect(render).not.toHaveBeenCalled();
    const stale = response();
    await handler({ params: { id: 'film' }, body: { expectedRevision: doc.revision - 1, noteIds: [doc.notes[0]!.id] } }, stale);
    expect(stale.statusCode).toBe(409);
    const invalid = response();
    await handler({ params: { id: 'film' }, body: { expectedRevision: doc.revision, noteIds: ['missing'] } }, invalid);
    expect(invalid.statusCode).toBe(400);
  });
  it('renders the selected dimensions and exact frame rate without changing the editable project settings', async () => {
    const before = (await readMovie(root))!;
    const profile = { format: 'mp4', width: 1280, height: 720, frameRate: { numerator: 24000, denominator: 1001 } };
    const res = { statusCode: 200, body: null as any, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
    await handlers.get('POST /api/projects/:id/movie/actions')!({ params: { id: 'film' }, body: { action: 'render-preview', expectedRevision: before.revision, exportOptions: profile } }, res);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await readMovie(root))?.renders.at(-1)?.status).toBe('done'));
    const after = (await readMovie(root))!;
    expect(after.settings).toEqual(before.settings); expect(after.contentRevision).toBe(before.contentRevision);
    expect(after.renders.at(-1)?.exportOptions).toEqual(profile);
    const sourcePath = after.renders.at(-1)!.sourcePath;
    const snapshot = JSON.parse(await readFile(path.join(root, path.dirname(sourcePath), 'movie-snapshot.json'), 'utf8'));
    expect(snapshot.settings).toEqual({ width: 1280, height: 720, frameRate: profile.frameRate });
    const html = await readFile(path.join(root, sourcePath), 'utf8');
    expect(html).toContain('data-width="1280"'); expect(html).toContain('data-height="720"'); expect(html).toContain(`data-fps="${24000 / 1001}"`);
  });
  it("renders a draft preview without recording storyboard, sample or final approval", async () => {
    const before = (await readMovie(root))!;
    const res = { statusCode: 200, body: null as any, headersSent: false,
      status(code: number) { this.statusCode = code; return this; },
      json(body: unknown) { this.body = body; this.headersSent = true; return this; } };
    await handlers.get("POST /api/projects/:id/movie/actions")!({ params: { id: "film" }, body: { action: "render-preview", expectedRevision: before.revision } }, res);
    expect(res.statusCode).toBe(202);
    await vi.waitFor(async () => expect((await readMovie(root))?.renders.at(-1)?.status).toBe("done"));
    const after = (await readMovie(root))!;
    expect(after.storyboardApproved).toBeNull();
    expect(after.samplesApproved).toBeNull();
    expect(after.approvedRenderId).toBeNull();
    expect(after.delivery).toBeNull();
  });
  it("refuses an unapproved start before preview or rendering", async () => {
    const d = (await readMovie(root))!;
    expect(
      (await call("start", { expectedRevision: d.revision })).statusCode,
    ).toBe(403);
    expect(render).not.toHaveBeenCalled();
    expect(previewMovieStyle).not.toHaveBeenCalled();
  });
  it("renders once and leaves final review unapproved", async () => {
    const d = await armAndEdit();
    expect(
      (await call("start", { expectedRevision: d.revision })).statusCode,
    ).toBe(202);
    await call("start", { expectedRevision: d.revision });
    await vi.waitFor(async () =>
      expect((await readMovie(root))?.production?.status).toBe("done"),
    );
    expect(render).toHaveBeenCalledTimes(1);
    expect((await readMovie(root))?.approvedRenderId).toBeNull();
  });
  it("stops when the storyboard changes during preview", async () => {
    let finish!: (value: string[]) => void;
    vi.mocked(previewMovieStyle).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const d = await armAndEdit();
    await call("start", { expectedRevision: d.revision });
    const changed = (await readMovie(root))!;
    await saveMovie(root, {
      expectedRevision: changed.revision,
      document: { ...changed, title: "A different edit" },
    });
    finish(["sample.png"]);
    await vi.waitFor(async () =>
      expect((await readMovie(root))?.production?.status).toBe("failed"),
    );
    expect(render).not.toHaveBeenCalled();
    expect((await readMovie(root))?.samplesApproved).toBeNull();
  });
  it("never reports the old film as success after another edit", async () => {
    const d = await armAndEdit();
    await call("start", { expectedRevision: d.revision });
    await vi.waitFor(async () =>
      expect((await readMovie(root))?.production?.status).toBe("done"),
    );
    const done = (await readMovie(root))!;
    const changed = await saveMovie(root, {
      expectedRevision: done.revision,
      document: { ...done, title: "Changed after export" },
    });
    expect(
      (await call("start", { expectedRevision: changed.revision })).statusCode,
    ).toBe(409);
    expect(render).toHaveBeenCalledTimes(1);
  });
  it("recovers an interrupted production from the wait tool itself", async () => {
    await mutateMovie(root, undefined, (d) => {
      d!.production = {
        id: "interrupted",
        status: "preparing",
        createdAt: new Date().toISOString(),
        baselineContentRevision: 1,
      };
      return d!;
    });
    const result = await call("wait", {}, "GET");
    expect(result.body.document.production.status).toBe("failed");
  });
});
