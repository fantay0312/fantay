import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createMovieDocument, type MovieShot } from "@open-design/contracts";
import { authorMovie } from "../../src/movie/author.js";
import {
  applyMovieAction,
  mutateMovie,
  readMovie,
  saveMovie,
} from "../../src/movie/store.js";
import { movieAssetDigest } from "../../src/movie/assets.js";
import { moviePreviewTimes } from "../../src/movie/style-preview.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "movie-author-"));
  await saveMovie(dir, {
    expectedRevision: 0,
    document: createMovieDocument("Original", "blank"),
  });
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});
const shot = (id: string): MovieShot => ({
  id,
  title: "Original " + id,
  body: "",
  direction: "An object crosses the scene",
  duration: 4,
  layout: "title",
  visual: {
    composition: "custom",
    copyMode: "caption",
    copy: {
      x: 8,
      y: 84,
      width: 84,
      align: "left",
      titleSize: 3,
      bodySize: 1.2,
    },
    transition: "fade",
    layers: [
      {
        id: "traveller",
        type: "path",
        x: 5,
        y: 30,
        width: 20,
        height: 20,
        color: "accent",
        path: "M0 0L1000 500L0 1000Z",
        keyframes: [
          { at: 0, x: 5 },
          { at: 1, x: 70, ease: "smooth" },
        ],
      },
    ],
  },
});

describe("Original scene authoring", () => {
  it("starts neutral and creates independent scenes, previews and a reusable style", async () => {
    let d = (await readMovie(dir))!;
    expect(d.style.id).toBe("blank");
    expect(d.style.demoShots).toBeUndefined();
    expect(d.style.visual?.layers).toEqual([]);
    d = await authorMovie(dir, {
      expectedRevision: d.revision,
      style: { name: "Original motion" },
      shots: { mode: "replace", items: [shot("a"), shot("b"), shot("c")] },
    });
    expect(d.style.id).toMatch(/^ai-/);
    expect(d.shots).toHaveLength(3);
    const before = d.shots[1];
    d = await authorMovie(dir, {
      expectedRevision: d.revision,
      shots: {
        mode: "upsert",
        items: [{ ...shot("a"), title: "Revised scene" }],
      },
    });
    expect(d.shots[1]).toEqual(before);
    await expect(
      applyMovieAction(dir, d.revision, { action: "save-style" }),
    ).rejects.toThrow("Preview");
    const digest = await movieAssetDigest(dir, d);
    d = await mutateMovie(dir, d.revision, (current) => ({
      ...current!,
      stylePreview: {
        contentRevision: current!.contentRevision,
        assetDigest: digest,
        frames: ["checked.png"],
        times: [2],
        shotIds: current!.shots.map((s) => s.id),
      },
    }));
    d = await applyMovieAction(dir, d.revision, { action: "save-style" });
    const reused = createMovieDocument("Reuse", "personal", d.savedStyles[0]!);
    expect(reused.shots).toEqual(d.shots);
    expect(reused.shots[0]?.direction).toBeTruthy();
    expect(moviePreviewTimes(d, { motion: true })).toEqual([
      0.6, 2, 3.4, 4.6, 6, 7.4, 8.6, 10, 11.4,
    ]);
  });
  it("serializes competing edits and rejects an invalid whole change atomically", async () => {
    const d = (await readMovie(dir))!;
    const results = await Promise.allSettled([
      authorMovie(dir, {
        expectedRevision: d.revision,
        shots: { mode: "replace", items: [shot("a")] },
      }),
      authorMovie(dir, {
        expectedRevision: d.revision,
        shots: { mode: "replace", items: [shot("b")] },
      }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const current = (await readMovie(dir))!;
    await expect(
      authorMovie(dir, {
        expectedRevision: current.revision,
        shots: {
          mode: "replace",
          items: [shot("valid"), { ...shot("invalid"), duration: Infinity }],
        },
      }),
    ).rejects.toThrow();
    expect(await readMovie(dir)).toEqual(current);
  });
  it("preserves a production grant but never accepts approval injection or invented assets", async () => {
    let d = await mutateMovie(dir, undefined, (current) => ({
      ...current!,
      production: {
        id: "grant",
        status: "armed",
        createdAt: new Date().toISOString(),
        baselineContentRevision: 1,
      },
      storyboardApproved: 1,
      samplesApproved: 1,
    }));
    await expect(
      authorMovie(dir, {
        expectedRevision: d.revision,
        production: { status: "done" },
      }),
    ).rejects.toThrow("Unknown authoring");
    d = await authorMovie(dir, {
      expectedRevision: d.revision,
      shots: { mode: "replace", items: [shot("a")] },
    });
    expect(d.production?.status).toBe("armed");
    expect(d.samplesApproved).toBeNull();
    const invalid = shot("asset");
    invalid.visual!.layers[0]!.assetId = "invented";
    await expect(
      authorMovie(dir, {
        expectedRevision: d.revision,
        shots: { mode: "upsert", items: [invalid] },
      }),
    ).rejects.toThrow("Import the material");
  });
  it("does not bypass preview requirements by renaming the style or changing start mode", async () => {
    let d = (await readMovie(dir))!;
    d = await authorMovie(dir, {
      expectedRevision: d.revision,
      shots: { mode: "replace", items: [shot("a"), shot("b")] },
    });
    d = await saveMovie(dir, {
      expectedRevision: d.revision,
      document: {
        ...d,
        startMode: "library",
        style: { ...d.style, id: "ordinary" },
      },
    });
    expect(d.authored).toBe(true);
    await expect(
      applyMovieAction(dir, d.revision, { action: "save-style" }),
    ).rejects.toThrow("Preview");
    const digest = await movieAssetDigest(dir, d);
    d = await mutateMovie(dir, d.revision, (c) => ({
      ...c!,
      stylePreview: {
        contentRevision: c!.contentRevision,
        assetDigest: digest,
        frames: ["one.png"],
        times: [2],
        shotIds: ["a"],
      },
    }));
    await expect(
      applyMovieAction(dir, d.revision, { action: "save-style" }),
    ).rejects.toThrow("Preview");
  });
  it("supports previewing later scenes without losing their positions in the full timeline", () => {
    const doc = createMovieDocument();
    doc.shots = Array.from({ length: 8 }, (_, i) => shot("scene-" + i));
    expect(
      moviePreviewTimes(doc, { motion: true, shotIds: ["scene-6", "scene-7"] }),
    ).toEqual([24.6, 26, 27.4, 28.6, 30, 31.4]);
  });
});
