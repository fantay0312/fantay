import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { afterEach, it, expect } from "vitest";
import { createMovieDocument, buildMovieHtml } from "@open-design/contracts";
import { stageMovieAssets } from "../../src/movie/assets.js";
import {
  movieVideoSources,
  probeMovieVideo,
} from "../../src/movie/video-sources.js";
import { parseMovieShots } from "../../src/movie/store.js";
import { movieSrt } from "../../src/movie/captions.js";
let root = "";
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});
it("trims real source time, normalizes speed and audio, and preserves caption timing in delivery", async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "movie-video-"));
  execFileSync(
    ffmpeg.path,
    [
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=160x90:rate=24:duration=6",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=6",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-shortest",
      path.join(root, "source.mp4"),
    ],
    { stdio: "ignore" },
  );
  const doc = createMovieDocument("Footage", "blank");
  doc.style.assets = [{ id: "source", path: "source.mp4", label: "Source" }];
  doc.shots = parseMovieShots([
    {
      id: "cut",
      title: "",
      body: "",
      layout: "title",
      duration: 1.5,
      clip: { assetId: "source", in: 2, rate: 2, volume: 0.5, fit: "cover" },
      captions: [{ start: 0.1, end: 1.4, text: "A <real> caption" }],
    },
  ]);
  const info = await movieVideoSources(root, doc);
  expect(info[0]!.duration).toBeCloseTo(6, 0);
  expect(info[0]!.hasAudio).toBe(true);
  expect(info[0]!.frames).toHaveLength(6);
  expect(info[0]!.frames.map((f) => path.basename(f.path))).toEqual([0, 1, 2, 3, 4, 5].map((i) => `frame-6-${i}.jpg`));
  expect(info[0]!.audioPeaks).toHaveLength(600);
  expect(Math.max(...info[0]!.audioPeaks!)).toBe(1);
  const staged = await stageMovieAssets(root, "render", doc);
  const shot = staged.document.shots[0]!;
  expect(shot.clip).toMatchObject({ in: 0, rate: 1, volume: 0.5 });
  const rendered = await probeMovieVideo(
    path.join(root, "render", shot.media!),
  );
  expect(rendered.duration).toBeCloseTo(1.5, 0);
  expect(rendered.hasAudio).toBe(true);
  const html = buildMovieHtml(staged.document);
  expect(html).toContain("footage");
  expect(html).toContain("<audio");
  expect(html).toContain('name="od-motion-audio" content="required"');
  expect(html).toContain('data-fade-out="0"');
  expect(html).toContain("A &lt;real&gt; caption");
  expect(html).not.toContain('data-media-start="2"');
  expect(movieSrt(doc)).toContain("00:00:00,100 --> 00:00:01,400");
  doc.shots[0]!.clip!.in = 5;
  await expect(stageMovieAssets(root, "invalid", doc)).rejects.toThrow(
    "beyond",
  );
});
it("rejects invalid caption timing and keeps video offsets in live preview", () => {
  const doc = createMovieDocument("Preview", "blank");
  doc.style.assets = [{ id: "v", path: "video.mp4" }];
  doc.shots = parseMovieShots([
    {
      id: "s",
      title: "",
      body: "",
      duration: 2,
      layout: "title",
      clip: { assetId: "v", in: 3, rate: 0.5, volume: 0, fit: "contain" },
    },
  ]);
  expect(buildMovieHtml(doc)).toContain('data-media-start="3"');
  expect(buildMovieHtml(doc)).toContain('data-playback-rate="0.5"');
  expect(() =>
    parseMovieShots([
      { ...doc.shots[0], captions: [{ start: 0, end: 3, text: "Outside" }] },
    ]),
  ).toThrow();
});
