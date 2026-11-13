import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import {
  movieDuration,
  type MovieDocument,
  type MovieReviewAssets,
} from "@open-design/contracts";
import { MovieError, safeMovieAsset } from "./store.js";
import { renderSnapshot } from "./review.js";
const exec = promisify(execFile),
  pending = new Map<string, Promise<MovieReviewAssets>>();

export async function movieReviewAssets(
  dir: string,
  doc: MovieDocument,
  renderId: string,
): Promise<MovieReviewAssets> {
  const render = doc.renders.find(
    (r) => r.id === renderId && r.status === "done",
  );
  if (!render?.file || !/^[a-zA-Z0-9_-]{1,100}$/.test(renderId))
    throw new MovieError("Completed version not found", 404);
  const source = await safeMovieAsset(dir, render.file),
    before = await lstat(source);
  const snapshot = await renderSnapshot(dir, doc, render),
    duration = render.duration ?? movieDuration(snapshot);
  if (!Number.isFinite(duration) || duration <= 0 || duration > 300)
    throw new MovieError("Invalid video duration");
  const hash = createHash("sha256")
    .update(
      JSON.stringify(["review-v1", render.file, before.size, before.mtimeMs]),
    )
    .digest("hex")
    .slice(0, 12);
  const relative = `movie-review/${renderId}-${hash}`,
    root = path.join(dir, relative),
    manifest = path.join(root, "index.json");
  for (const part of ["movie-review", relative]) {
    const folder = path.join(dir, part);
    await mkdir(folder, { recursive: true });
    const s = await lstat(folder);
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new MovieError("Review cache must be a real directory");
  }
  try {
    await safeMovieAsset(dir, `${relative}/index.json`);
    const cached = JSON.parse(
      await readFile(manifest, "utf8"),
    ) as MovieReviewAssets;
    await safeMovieAsset(dir, cached.thumbnailFile);
    return cached;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (pending.has(root)) return pending.get(root)!;
  const job = (async () => {
    const binary =
      process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path;
    const probe = await exec(
      binary,
      ["-nostdin", "-hide_banner", "-i", source, "-t", "0", "-f", "null", "-"],
      { timeout: 15000, maxBuffer: 256 * 1024 },
    );
    const fps = Number(/(\d+(?:\.\d+)?) fps/.exec(probe.stderr)?.[1] ?? 30);
    const hasAudio = /Stream #[^\n]+Audio:/.test(probe.stderr);
    const count = Math.max(8, Math.min(24, Math.ceil(duration)));
    const token = randomUUID(),
      temp = path.join(root, `${token}.jpg`),
      output = path.join(root, "strip.jpg");
    try {
      await exec(
        binary,
        [
          "-nostdin",
          "-hide_banner",
          "-loglevel",
          "error",
          "-i",
          source,
          "-vf",
          `fps=${count / duration}:round=up,scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2,tile=${count}x1`,
          "-frames:v",
          "1",
          "-q:v",
          "4",
          temp,
        ],
        { timeout: 45000, maxBuffer: 256 * 1024 },
      );
      let peaks: number[] = [],
        audio: MovieReviewAssets["audio"] = "none";
      if (hasAudio) {
        const decoded = await exec(
          binary,
          [
            "-nostdin",
            "-hide_banner",
            "-loglevel",
            "error",
            "-i",
            source,
            "-map",
            "0:a:0",
            "-vn",
            "-ac",
            "1",
            "-ar",
            "4000",
            "-f",
            "s16le",
            "pipe:1",
          ],
          { encoding: "buffer", timeout: 30000, maxBuffer: 4 * 1024 * 1024 },
        );
        const bytes = decoded.stdout,
          bins = 400,
          step = Math.max(1, Math.ceil(bytes.length / 2 / bins));
        peaks = Array.from({ length: bins }, (_, i) => {
          let peak = 0;
          for (
            let n = i * step;
            n < Math.min((i + 1) * step, bytes.length / 2);
            n++
          )
            peak = Math.max(peak, Math.abs(bytes.readInt16LE(n * 2)) / 32768);
          return peak;
        });
        const max = Math.max(...peaks);
        audio = max < 0.0001 ? "silent" : "present";
        if (max > 0) peaks = peaks.map((p) => p / max);
      }
      const after = await lstat(source);
      if (after.size !== before.size || after.mtimeMs !== before.mtimeMs)
        throw new MovieError("Video changed while preparing the timeline", 409);
      const result: MovieReviewAssets = {
        renderId,
        duration,
        fps: Number.isFinite(fps) && fps > 0 ? fps : 30,
        thumbnailFile: `${relative}/strip.jpg`,
        thumbnailCount: count,
        audio,
        peaks,
        shots: snapshot.shots.map(({ id, title, duration }) => ({
          id,
          title,
          duration,
        })),
      };
      await rename(temp, output);
      const tempManifest = path.join(root, `${token}.json`);
      await writeFile(tempManifest, JSON.stringify(result), { flag: "wx" });
      await rename(tempManifest, manifest);
      return result;
    } finally {
      await rm(temp, { force: true });
    }
  })();
  pending.set(root, job);
  try {
    return await job;
  } finally {
    pending.delete(root);
  }
}
