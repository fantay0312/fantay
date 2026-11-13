import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildMovieHtml, createMovieDocument, MOVIE_SAMPLES } from "@open-design/contracts";
import {
  applyMovieAction,
  mutateMovie,
  parseMovieInput,
  readMovie,
  safeMovieAsset,
  saveMovie,
} from "../../src/movie/store.js";

const dirs: string[] = [];
async function temp() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "fantay-movie-"));
  dirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
describe("Movie workflow persistence", () => {
  it("saves and reuses complete scene animation independently of later edits", async () => {
    const dir = await temp();
    let doc = await saveMovie(dir, {expectedRevision:0,document:createMovieDocument("Garden","library",MOVIE_SAMPLES[1]!)});
    doc = await applyMovieAction(dir, doc.revision, {action:"save-style"});
    const saved = doc.savedStyles[0]!;
    const reused = createMovieDocument("Reuse", "personal", saved);
    expect(reused.shots).toEqual(doc.shots);
    reused.shots[0]!.title = "Changed later";
    expect(saved.demoShots![0]!.title).not.toBe("Changed later");
    expect(reused.shots[2]!.visual!.camera).toEqual(doc.shots[2]!.visual!.camera);
  });
  it("preserves a durable document and rejects competing edits", async () => {
    const dir = await temp();
    const first = await saveMovie(dir, {
      expectedRevision: 0,
      document: createMovieDocument(),
    });
    const results = await Promise.allSettled([
      saveMovie(dir, {
        expectedRevision: first.revision,
        document: { ...first, title: "First edit" },
      }),
      saveMovie(dir, {
        expectedRevision: first.revision,
        document: { ...first, title: "Competing edit" },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect((await readMovie(dir))?.title).toBe("First edit");
  });
  it("invalidates approvals and delivery only when rendered content changes", async () => {
    const dir = await temp();
    let doc = await saveMovie(dir, {
      expectedRevision: 0,
      document: createMovieDocument(),
    });
    await expect(
      applyMovieAction(dir, doc.revision, { action: "approve-samples" }),
    ).rejects.toThrow("storyboard");
    doc = await applyMovieAction(dir, doc.revision, {
      action: "approve-storyboard",
    });
    doc = await applyMovieAction(dir, doc.revision, {
      action: "approve-samples",
    });
    const edit = doc.contentRevision;
    doc = await saveMovie(dir, {
      expectedRevision: doc.revision,
      document: { ...doc, brief: "New guidance only" },
    });
    expect(doc.samplesApproved).toBe(edit);
    doc = await saveMovie(dir, {
      expectedRevision: doc.revision,
      document: {
        ...doc,
        shots: doc.shots.map((s, i) =>
          i ? s : { ...s, title: "Changed frame" },
        ),
      },
    });
    expect(doc.contentRevision).toBe(edit + 1);
    expect(doc.samplesApproved).toBeNull();
    expect(doc.storyboardApproved).toBeNull();
  });
  it("keeps saved style snapshots independent of later edits", async () => {
    const dir = await temp();
    let doc = await saveMovie(dir, {
      expectedRevision: 0,
      document: createMovieDocument(),
    });
    doc = await applyMovieAction(dir, doc.revision, { action: "save-style" });
    doc = await applyMovieAction(dir, doc.revision, { action: "save-style" });
    expect(doc.savedStyles).toHaveLength(1);
    doc = await saveMovie(dir, {
      expectedRevision: doc.revision,
      document: { ...doc, style: { ...doc.style, accent: "#ff0000" } },
    });
    expect(doc.savedStyles[0]?.accent).toBe("#87ea5c");
  });
  it("requires a current completed render and resolved notes for review approval", async () => {
    const dir = await temp();
    let doc = await saveMovie(dir, {
      expectedRevision: 0,
      document: createMovieDocument(),
    });
    await expect(
      applyMovieAction(dir, doc.revision, { action: "approve-review" }),
    ).rejects.toThrow("Render");
    doc = await mutateMovie(dir, doc.revision, (d) => ({
      ...d!,
      renders: [
        {
          id: "r1",
          contentRevision: d!.contentRevision,
          status: "done",
          file: "film.mp4",
          sourcePath: "source.html",
          createdAt: new Date().toISOString(),
          duration: 6,
        },
      ],
    }));
    await expect(applyMovieAction(dir, doc.revision, {action:'add-note',renderId:'r1',time:7,text:'Outside this render'})).rejects.toThrow();
    doc = await applyMovieAction(dir, doc.revision, {
      action: "add-note",
      renderId: "r1",
      time: 2.5,
      text: "Hold this frame longer",
    });
    await expect(
      applyMovieAction(dir, doc.revision, { action: "approve-review" }),
    ).rejects.toThrow("notes");
    doc = await applyMovieAction(dir, doc.revision, {
      action: "resolve-note",
      noteId: doc.notes[0]!.id,
    });
    doc = await applyMovieAction(dir, doc.revision, {
      action: "approve-review",
    });
    expect(doc.approvedRenderId).toBe("r1");
    expect(
      JSON.parse(await readFile(path.join(dir, "movie-studio.json"), "utf8"))
        .notes[0].time,
    ).toBe(2.5);
  });
  it("rejects unsafe styles, duplicate shots, escaped assets and symbolic links", async () => {
    const doc = createMovieDocument();
    expect(() =>
      parseMovieInput({
        ...doc,
        style: { ...doc.style, accent: "red;}</style>" },
      }),
    ).toThrow("hex");
    expect(() =>
      parseMovieInput({ ...doc, shots: [doc.shots[0], doc.shots[0]] }),
    ).toThrow("unique");
    expect(() =>
      parseMovieInput({
        ...doc,
        shots: [{ ...doc.shots[0], media: "../secret.png" }],
      }),
    ).toThrow("relative");
    const dir = await temp();
    await writeFile(path.join(dir, "source.png"), "image");
    await symlink(path.join(dir, "source.png"), path.join(dir, "link.png"));
    await expect(safeMovieAsset(dir, "link.png")).rejects.toThrow("Symbolic");
  });
  it("escapes content in both markup and timeline scripts", () => {
    const doc = createMovieDocument("</title><script>bad()</script>");
    doc.shots[0]!.title = "</script><script>alert(1)</script>";
    const html = buildMovieHtml(doc);
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("window.__timelines.main");
    expect(html).toContain('data-duration="12"');
  });
});
