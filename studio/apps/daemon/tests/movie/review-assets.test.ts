import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { describe, it, expect } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import { movieReviewAssets } from "../../src/movie/review-assets.js";
const exec = promisify(execFile);
describe("Real review media", () => {
  it.each([false, true])(
    "extracts thumbnails and truthful audio state (audio=%s)",
    async (audio) => {
      const root = await mkdtemp(path.join(os.tmpdir(), "review-media-"));
      try {
        await exec(
          process.env.HYPERFRAMES_FFMPEG_PATH || ffmpeg.path,
          [
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=blue:s=320x180:r=24:d=2",
            ...(audio
              ? [
                  "-f",
                  "lavfi",
                  "-i",
                  "sine=frequency=440:sample_rate=8000:duration=2",
                ]
              : []),
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            ...(audio ? ["-c:a", "aac", "-shortest"] : []),
            path.join(root, "test.mp4"),
          ],
          { timeout: 15000 },
        );
        const d = createMovieDocument();
        d.shots = [
          { id: "a", title: "A", body: "", duration: 2, layout: "title" },
        ];
        d.renders = [
          {
            id: "r",
            status: "done",
            file: "test.mp4",
            sourcePath: "motion-source/r/index.html",
            contentRevision: d.contentRevision,
            duration: 2,
            createdAt: new Date().toISOString(),
          },
        ];
        const result = await movieReviewAssets(root, d, "r");
        expect(result.thumbnailCount).toBe(8);
        expect(result.fps).toBe(24);
        expect(result.audio).toBe(audio ? "present" : "none");
        expect(result.peaks.length).toBe(audio ? 400 : 0);
        if (audio) expect(Math.max(...result.peaks)).toBe(1);
        expect(await movieReviewAssets(root, d, "r")).toEqual(result);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    30000,
  );
});
