import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { mkdir, lstat, readFile, writeFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { movieFps, type MovieDocument, type MovieVideoSource } from "@open-design/contracts";
import { MovieError, safeMovieAsset } from "./store.js";
import { sourceAudioPeaks } from "./audio-peaks.js";
const exec = promisify(execFile);
const pending = new Map<string, Promise<MovieVideoSource>>();
const sourceKeyCache = new Map<string, Promise<string>>();
const cachedJsonMemo = new Map<string, { sig: string; value: unknown }>();

async function streamSourceKey(file: string, info: { size: number; mtimeMs: number; ino: number }): Promise<string> {
  const sig = `${file}\0${info.size}:${info.mtimeMs}:${info.ino}`;
  const hit = sourceKeyCache.get(sig);
  if (hit) {
    sourceKeyCache.delete(sig);
    sourceKeyCache.set(sig, hit);
    return hit;
  }
  const work = (async () => {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex").slice(0, 20);
  })();
  sourceKeyCache.set(sig, work);
  if (sourceKeyCache.size > 128) {
    const oldest = sourceKeyCache.keys().next().value;
    if (oldest !== undefined) sourceKeyCache.delete(oldest);
  }
  work.catch(() => {
    if (sourceKeyCache.get(sig) === work) sourceKeyCache.delete(sig);
  });
  return work;
}

async function readStatCachedJson<T>(resolvedFile: string): Promise<T> {
  const info = await lstat(resolvedFile);
  const sig = `${info.size}:${info.mtimeMs}:${info.ino}`;
  const hit = cachedJsonMemo.get(resolvedFile);
  if (hit?.sig === sig) return hit.value as T;
  const parsed = JSON.parse(await readFile(resolvedFile, "utf8")) as T;
  if (cachedJsonMemo.size >= 256 && !cachedJsonMemo.has(resolvedFile)) {
    const oldest = cachedJsonMemo.keys().next().value;
    if (oldest !== undefined) cachedJsonMemo.delete(oldest);
  }
  cachedJsonMemo.set(resolvedFile, { sig, value: parsed });
  return parsed;
}
export const movieFfmpeg = () =>
  process.env.HYPERFRAMES_FFMPEG_PATH?.trim() || ffmpegInstaller.path;
export async function probeMovieVideo(file: string) {
  const info = await probeMovieMedia(file);
  if (info.kind !== "video") throw new MovieError("This file is not a readable video");
  return info;
}
export async function probeMovieMedia(file: string) {
  const { stderr } = await exec(
    movieFfmpeg(),
    ["-nostdin", "-hide_banner", "-i", file, "-t", "0", "-f", "null", "-"],
    { timeout: 20000, maxBuffer: 512000 },
  );
  const durationMatch = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  const size = /Video:[^\n]*?\b(\d{2,5})x(\d{2,5})\b/.exec(stderr);
  const image = /\.(png|jpe?g|webp|gif|svg)$/i.test(file);
  if ((!durationMatch && !image) || (!size && !/Audio:/.test(stderr)))
    throw new MovieError("This file is not readable video, audio or image media");
  const duration =
    image ? 5 : Number(durationMatch![1]) * 3600 +
    Number(durationMatch![2]) * 60 + Number(durationMatch![3]);
  if (duration <= 0 || duration > 14400)
    throw new MovieError("Choose media up to four hours long");
  return {
    duration,
    kind: (image ? "image" : size ? "video" : "audio") as "image" | "video" | "audio",
    width: Number(size?.[1] ?? 0),
    height: Number(size?.[2] ?? 0),
    fps: Number(/(\d+(?:\.\d+)?) fps/.exec(stderr)?.[1] ?? 30),
    hasAudio: /Stream #[^\n]+Audio:/.test(stderr),
    videoCodec: /Video:\s*([^,\s]+)/.exec(stderr)?.[1],
  };
}
/** About one frame per second (6-48) over the picture's span, each at the middle of its slot, so a tile is never far
 * from the time under it. No time passes `lastFrame`, the last picture a seek can still land on; slots that collapse
 * onto the same time (a one-picture video) are cut once. */
export function movieSourceFrameTimes(duration: number, lastFrame = duration - 0.04): number[] {
  const count = Math.min(48, Math.max(6, Math.ceil(duration)));
  const times = Array.from({ length: count }, (_, i) =>
    Math.max(0, Math.min(lastFrame, (duration * (i + 0.5)) / count)));
  return times.filter((time, i) => i === 0 || time !== times[i - 1]);
}
export const movieSourceFramePath = (relative: string, count: number, index: number) =>
  `${relative}/frame-${count}-${index}.jpg`;
/** Runs at most `limit` at once; once any run fails, no lane starts another. */
export async function mapLimit<T, R>(items: T[], limit: number, run: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { out[i] = await run(items[i]!, i); }
      catch (error) { failed = true; throw error; }
    }
  }));
  return out;
}
export interface MovieVideoEnd {
  /** Time of the last picture; an input seek past it finds nothing. */
  lastFrame: number;
  /** When that picture stops showing: the video stream's own end, which audio may outlast. */
  end: number;
}
/** Reads the first video stream's packet timestamps by stream copy (no decoding), on the clock `-ss` seeks on.
 * Null when ffmpeg cannot read them; callers then fall back to the container duration. */
export async function probeMovieVideoEnd(file: string): Promise<MovieVideoEnd | null> {
  const child = spawn(
    movieFfmpeg(),
    ["-nostdin", "-loglevel", "error", "-i", file, "-map", "0:v:0", "-c", "copy", "-f", "framecrc", "-"],
    { stdio: ["ignore", "pipe", "ignore"], timeout: 60000 },
  );
  // framecrc prints `#tb 0: num/den`, then one `stream, dts, pts, duration, size, crc` line per packet.
  let num = 0, den = 0, last = -Infinity, end = -Infinity, rest = "";
  const read = (line: string) => {
    const tb = /^#tb 0: (\d+)\/(\d+)/.exec(line);
    if (tb) { num = Number(tb[1]); den = Number(tb[2]); return; }
    if (!line || line.startsWith("#")) return;
    const [stream, dts, pts, duration] = line.split(",").map((field) => Number(field.trim()));
    // A missing pts prints as INT64_MIN, which is not a safe integer.
    const at = Number.isSafeInteger(pts) ? pts! : Number.isSafeInteger(dts) ? dts! : undefined;
    if (stream !== 0 || at === undefined) return;
    last = Math.max(last, at);
    end = Math.max(end, at + (Number.isSafeInteger(duration) && duration! > 0 ? duration! : 0));
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    const lines = (rest + chunk).split("\n");
    rest = lines.pop() ?? "";
    lines.forEach(read);
  });
  const code = await new Promise<number | null>((resolve) => {
    child.once("error", () => resolve(null));
    child.once("close", resolve);
  });
  read(rest);
  if (code !== 0 || !num || !den || last === -Infinity) return null;
  // Floor to the millisecond so a seek to lastFrame never rounds past the picture's own timestamp.
  const lastFrame = Math.max(0, Math.floor((last * num * 1000) / den) / 1000);
  return { lastFrame, end: Math.max(lastFrame, (end * num) / den) };
}
/** Cuts one still at `time` (0 = the first picture); null when the seek finds no picture or ffmpeg fails,
 * so one slot never fails the whole source. */
async function cutSourceFrame(dir: string, root: string, file: string, time: number, frame: string) {
  try {
    await safeMovieAsset(dir, frame);
    return { time, path: frame };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const temp = path.join(root, `${randomUUID()}.jpg`);
  try {
    await exec(
      movieFfmpeg(),
      [
        "-nostdin",
        "-loglevel",
        "error",
        ...(time > 0 ? ["-ss", String(time)] : []),
        "-i",
        file,
        "-map",
        "0:v:0",
        "-frames:v",
        "1",
        "-vf",
        "scale=640:360:force_original_aspect_ratio=decrease",
        temp,
      ],
      { timeout: 20000, maxBuffer: 512000 },
    );
  } catch {
    // Newer ffmpeg exits non-zero when a seek finds no picture; never keep what a failed run left.
    await rm(temp, { force: true });
    return null;
  }
  try {
    await rename(temp, path.join(dir, frame));
  } catch (error) {
    // ffmpeg 4.4 exits 0 and writes nothing when a seek finds no picture.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return { time, path: frame };
}
/** The video end is a property of the content, so it is measured once per content-hashed cache directory. */
async function cachedVideoEnd(dir: string, cache: { file: string; relative: string; root: string }) {
  const endPath = `${cache.relative}/video-end.json`;
  try {
    const cached = JSON.parse(await readFile(await safeMovieAsset(dir, endPath), "utf8")) as Partial<MovieVideoEnd>;
    if (Number.isFinite(cached.lastFrame) && Number.isFinite(cached.end) && cached.lastFrame! >= 0 && cached.end! >= cached.lastFrame!)
      return cached as MovieVideoEnd;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  const measured = await probeMovieVideoEnd(cache.file);
  if (!measured) return null;
  const temp = path.join(cache.root, `${randomUUID()}.json`);
  await writeFile(temp, JSON.stringify(measured));
  await rename(temp, path.join(dir, endPath));
  return measured;
}
async function cacheRoot(dir: string, assetPath: string) {
  const file = await safeMovieAsset(dir, assetPath),
    info = await lstat(file);
  if (info.size > 256 * 1024 * 1024)
    throw new MovieError("A source video must be under 256 MiB");
  const key = await streamSourceKey(file, info);
  const relative = `movie-sources/${key}`;
  for (const part of ["movie-sources", relative]) {
    await mkdir(path.join(dir, part), { recursive: true });
    const s = await lstat(path.join(dir, part));
    if (s.isSymbolicLink() || !s.isDirectory())
      throw new MovieError("Invalid source cache directory");
  }
  return { file, relative, root: path.join(dir, relative) };
}
export async function movieVideoSources(
  dir: string,
  doc: MovieDocument,
): Promise<MovieVideoSource[]> {
  return Promise.all(
    (doc.style.assets ?? [])
      .filter((a) => /\.(mp4|m4v|mov|webm|mp3|wav|m4a|aac|flac|ogg|png|jpe?g|webp|gif)$/i.test(a.path))
      .map(async (asset) => {
        const cache = await cacheRoot(dir, asset.path);
        const key = cache.root;
        let job = pending.get(key);
        if (!job) {
          job = (async () => {
            const metadata = await probeMovieMedia(cache.file);
            let times: number[] = [];
            if (metadata.kind === "video") {
              // Slots span the picture, not the container: audio may outlast the video, and no seek may land past its last picture.
              const video = await cachedVideoEnd(dir, cache);
              times = video
                ? movieSourceFrameTimes(Math.min(metadata.duration, video.end), video.lastFrame)
                : movieSourceFrameTimes(metadata.duration);
            }
            const cut = await mapLimit(times, 4, (time, i) =>
              // The count is in the name, so frames cut at an older spacing are never reused.
              cutSourceFrame(dir, cache.root, cache.file, time, movieSourceFramePath(cache.relative, times.length, i)));
            const frames = cut.filter((frame): frame is { time: number; path: string } => frame !== null);
            if (metadata.kind === "video" && !frames.length) {
              // A video always gets a poster: its first picture.
              const poster = await cutSourceFrame(dir, cache.root, cache.file, 0, `${cache.relative}/frame-poster.jpg`);
              if (poster) frames.push(poster);
            }
            if (metadata.kind === "image") frames.push({ time: 0, path: asset.path });
            let previewPath: string | undefined;
            if (metadata.kind === 'video' && (!['h264', 'vp8', 'vp9', 'av1'].includes(metadata.videoCodec ?? '') || /\.(mov|m4v)$/i.test(asset.path))) {
              previewPath = `${cache.relative}/preview-h264.mp4`;
              try { await safeMovieAsset(dir, previewPath); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                const temp = path.join(cache.root, `${randomUUID()}.mp4`);
                await exec(movieFfmpeg(), ['-nostdin', '-v', 'error', '-i', cache.file, '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=ceil(iw/2)*2:ceil(ih/2)*2', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', ...(metadata.hasAudio ? ['-c:a', 'aac'] : ['-an']), '-movflags', '+faststart', temp], { timeout: 600000, maxBuffer: 512000 });
                await rename(temp, path.join(dir, previewPath));
              }
            }
            let audioPeaks: number[] | undefined;
            if (metadata.hasAudio) {
              // v2: duration-scaled bins on the picture's clock; old 600-bin files are left behind.
              const peaksPath = `${cache.relative}/audio-peaks-v2.json`;
              try { audioPeaks = await readStatCachedJson<number[]>(await safeMovieAsset(dir, peaksPath)); }
              catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                audioPeaks = await sourceAudioPeaks(movieFfmpeg(), cache.file, metadata.duration);
                const temp = path.join(cache.root, `${randomUUID()}.json`);
                await writeFile(temp, JSON.stringify(audioPeaks));
                await rename(temp, path.join(dir, peaksPath));
              }
            }
            return {
              assetId: asset.id,
              path: asset.path,
              label: asset.label ?? path.basename(asset.path),
              ...metadata,
              frames,
              ...(previewPath ? { previewPath } : {}),
              ...(audioPeaks ? { audioPeaks } : {}),
            };
          })();
          pending.set(key, job);
          void job.finally(() => pending.delete(key)).catch(() => {});
        }
        const result = {
          ...(await job),
          assetId: asset.id,
          path: asset.path,
          label: asset.label ?? path.basename(asset.path),
        };
        try {
          result.transcript = await readStatCachedJson(
            await safeMovieAsset(dir, `${cache.relative}/captions.json`),
          );
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        return result;
      }),
  );
}
export async function transcribeMovieSource(
  dir: string,
  doc: MovieDocument,
  assetId: string,
  language: string,
) {
  if (!/^(auto|[a-z]{2})$/.test(language))
    throw new MovieError("Invalid transcription language");
  const source = (await movieVideoSources(dir, doc)).find(
    (s) => s.assetId === assetId,
  );
  if (!source) throw new MovieError("Choose an imported video");
  if (!source.hasAudio)
    throw new MovieError(
      "This video has no audio track; add explanatory captions instead",
    );
  if (source.transcript) return source;
  const cache = await cacheRoot(dir, source.path);
  await transcribeLocalAudio(cache.file, cache.root, language);
  const raw = JSON.parse(
    await readFile(
      await safeMovieAsset(dir, `${cache.relative}/transcript.json`),
      "utf8",
    ),
  );
  const cues = (Array.isArray(raw) ? raw : (raw.transcription ?? []))
    .map(
      (s: {
        offsets?: { from: number; to: number };
        start?: number;
        end?: number;
        text?: string;
      }) => ({
        start: s.start ?? (s.offsets?.from ?? 0) / 1000,
        end: s.end ?? (s.offsets?.to ?? 0) / 1000,
        text: (s.text ?? "").trim(),
      }),
    )
    .filter(
      (c: { start: number; end: number; text: string }) =>
        c.end > c.start &&
        c.end <= source.duration + 1 &&
        c.text &&
        !/^\[[^\]]+\]$|^[♪♫\s]+$/.test(c.text),
    );
  if (!cues.length)
    throw new MovieError(
      "No reliable speech was detected. Use explanatory captions or another source.",
    );
  await writeFile(path.join(cache.root, "captions.json"), JSON.stringify(cues));
  return { ...source, transcript: cues };
}

export async function transcribeLocalAudio(file: string, outputDir: string, language: string, signal?: AbortSignal): Promise<void> {
  const cli = path.join(
    path.dirname(
      createRequire(import.meta.url).resolve("hyperframes/package.json"),
    ),
    "bin/hyperframes.mjs",
  );
  await exec(
    process.execPath,
    [
      cli,
      "transcribe",
      file,
      "--engine",
      "whisper",
      "--model",
      "small",
      ...(language === "auto" ? [] : ["--language", language]),
      "--dir",
      outputDir,
      "--json",
      "--timeout",
      "180000",
    ],
    {
      timeout: 240000,
      maxBuffer: 1024 * 1024,
      ...(signal ? { signal } : {}),
      env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" },
    },
  );
}

/** Pre-trim once, so browser capture and audio muxing share the same media clock. */
export async function stageMovieClips(
  dir: string,
  composition: string,
  doc: MovieDocument,
): Promise<string[]> {
  const files: string[] = [];
  for (const shot of doc.shots) {
    if (!shot.clip) continue;
    const clip = shot.clip;
    const asset = doc.style.assets?.find((a) => a.id === clip.assetId);
    if (!asset) throw new MovieError("Clip must reference imported media");
    if (/\.(png|jpe?g|webp|gif|svg)$/i.test(asset.path)) { shot.media = asset.path; continue; }
    const source = await safeMovieAsset(dir, `${composition}/${asset.path}`),
      info = await probeMovieMedia(source);
    if (clip.in + shot.duration * clip.rate > info.duration + 0.04)
      throw new MovieError(`Shot ${shot.id} extends beyond its source video`);
    const key = createHash("sha256")
      .update(JSON.stringify([asset.path, clip.in, clip.rate, shot.duration, movieFps(doc)]))
      .digest("hex")
      .slice(0, 16);
    const audioOnly = info.kind === "audio" || clip.audioOnly;
    const relative = `media/clip-${key}.${audioOnly ? "m4a" : "mp4"}`,
      output = path.join(dir, composition, relative);
    try {
      await safeMovieAsset(dir, `${composition}/${relative}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const temp = path.join(path.dirname(output), `${randomUUID()}${path.extname(relative)}`);
      const rate = clip.rate;
      const tempo =
        rate < 0.5
          ? `atempo=0.5,atempo=${rate * 2}`
          : rate > 2
            ? `atempo=2,atempo=${rate / 2}`
            : `atempo=${rate}`;
      await exec(
        movieFfmpeg(),
        [
          "-nostdin",
          "-loglevel",
          "error",
          "-ss",
          String(clip.in),
          "-i",
          source,
          "-t",
          String(shot.duration),
          ...(!audioOnly ? ["-vf", `setpts=(PTS-STARTPTS)/${rate},fps=${movieFps(doc)}`] : ["-vn"]),
          ...(info.hasAudio
            ? ["-af", `${tempo},apad`, "-c:a", "aac"]
            : ["-an"]),
          ...(!audioOnly ? ["-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-pix_fmt", "yuv420p"] : []),
          "-movflags",
          "+faststart",
          temp,
        ],
        { timeout: 120000, maxBuffer: 512000 },
      );
      await rename(temp, output);
    }
    shot.media = relative;
    shot.clip = {
      ...clip,
      in: 0,
      rate: 1,
      volume: info.hasAudio ? clip.volume : 0,
    };
    files.push(`${composition}/${relative}`);
  }
  return files;
}
