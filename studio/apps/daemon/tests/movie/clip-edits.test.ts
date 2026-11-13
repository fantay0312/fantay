import { copyFile, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import { editMovie, stepMovieHistory } from "../../src/movie/edits.js";
import { readMovie, saveMovie } from "../../src/movie/store.js";

let sharedDir: string;
let sharedClip: string;
let dir: string;
beforeAll(async () => {
  sharedDir = await mkdtemp(path.join(os.tmpdir(), "movie-cuts-shared-"));
  sharedClip = path.join(sharedDir, "clip.mp4");
  execFileSync(ffmpeg.path, ["-y", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=30", "-t", "8", "-pix_fmt", "yuv420p", sharedClip], { stdio: "ignore" });
});
afterAll(async () => { if (sharedDir) await rm(sharedDir, { recursive: true, force: true }); });
beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "movie-cuts-"));
  await copyFile(sharedClip, path.join(dir, "clip.mp4"));
  const d = createMovieDocument("Timeline", "blank");
  d.style.assets = [{ id: "source", path: "clip.mp4", label: "Footage" }];
  d.shots = [{ id: "clip", title: "Footage", body: "", layout: "split", duration: 3,
    clip: { assetId: "source", in: 1, rate: 2, volume: 0.4, fit: "contain" },
    captions: [{ id: "cue", start: 0.5, end: 2.5, text: "Spanning the cut" }] }];
  await saveMovie(dir, { document: d, expectedRevision: 0 });
});
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it("splits source time at playback rate, divides subtitles and undoes the whole cut", async () => {
  const before = (await readMovie(dir))!;
  const result = await editMovie(dir, { expectedRevision: before.revision,
    operations: [{ op: "split-clip", shotId: "clip", at: 1, newShotId: "right" }] });
  expect(result.document.shots.map((s) => [s.id, s.duration, s.clip!.in])).toEqual([["clip", 1, 1], ["right", 2, 3]]);
  expect(result.document.shots[0]!.captions![0]).toMatchObject({ start: 0.5, end: 1 });
  expect(result.document.shots[1]!.captions![0]).toMatchObject({ start: 0, end: 1.5 });
  expect(result.document.shots[1]!.clip).toMatchObject({ rate: 2, volume: 0.4 });
  expect(result.document.editHistory!.undoCount).toBe(1);
  const restored = await stepMovieHistory(dir, { expectedRevision: result.document.revision }, "undo");
  expect(restored.document.shots).toEqual(before.shots);
  const redone = await stepMovieHistory(dir, { expectedRevision: restored.document.revision }, "redo");
  expect(redone.document.shots).toEqual(result.document.shots);
});

it("trims within a clip and preserves fractional-second cuts", async () => {
  const before = (await readMovie(dir))!;
  const result = await editMovie(dir, { expectedRevision: before.revision,
    operations: [{ op: "trim-clip", shotId: "clip", start: 0.25, end: 0.75 }] });
  expect(result.document.shots[0]).toMatchObject({ duration: 0.5, clip: { in: 1.5 }, captions: [{ start: 0.25, end: 0.5 }] });
});

it("inserts, reorders and removes in one transaction while retaining the source", async () => {
  const before = (await readMovie(dir))!;
  const result = await editMovie(dir, { expectedRevision: before.revision, operations: [
    { op: "insert-clip", assetId: "source", index: 1, newShotId: "extra", in: 3, duration: 2 },
    { op: "move-shot", shotId: "extra", index: 0 },
    { op: "remove-shot", shotId: "clip" },
  ] });
  expect(result.document.shots.map((s) => s.id)).toEqual(["extra"]);
  expect(result.document.style.assets).toEqual(before.style.assets);
  expect(result.document.editHistory!.undoCount).toBe(1);
});

it("rolls back all edits when a cut, new ID, index, source range or revision is invalid", async () => {
  const before = (await readMovie(dir))!;
  for (const op of [
    { op: "split-clip", shotId: "clip", at: 0 },
    { op: "split-clip", shotId: "clip", at: 1, newShotId: "clip" },
    { op: "trim-clip", shotId: "clip", start: 2, end: 4 },
    { op: "move-shot", shotId: "clip", index: 4 },
    { op: "insert-clip", assetId: "source", index: 1, in: 7, duration: 3 },
    { op: "insert-clip", assetId: "unknown", index: 1 },
  ]) {
    await expect(editMovie(dir, { expectedRevision: before.revision, operations: [
      { op: "update-shot", shotId: "clip", changes: { title: "Must not persist" } }, op,
    ] })).rejects.toThrow();
    expect(await readMovie(dir)).toEqual(before);
  }
  await expect(editMovie(dir, { expectedRevision: 0, operations: [{ op: "remove-shot", shotId: "clip" }] })).rejects.toThrow();
});

it("places overlapping clips without moving neighbours and undoes the whole batch", async () => {
  const before=(await readMovie(dir))!;
  const result=await editMovie(dir,{expectedRevision:before.revision,operations:[
    {op:'duplicate-clip',shotId:'clip',newShotId:'overlay',at:0.5,track:1},
    {op:'update-clip',shotId:'overlay',changes:{x:55,y:5,width:40,opacity:0.8,muted:true}},
  ]});
  expect(result.document.shots[0]!.placement).toEqual({start:0,track:0});
  expect(result.document.shots[1]).toMatchObject({id:'overlay',placement:{start:0.5,track:1},clip:{x:55,width:40,muted:true}});
  expect(result.document.editHistory!.undoCount).toBe(1);
  const undo=await stepMovieHistory(dir,{expectedRevision:result.document.revision},'undo');
  expect(undo.document.shots).toEqual(before.shots);
});
