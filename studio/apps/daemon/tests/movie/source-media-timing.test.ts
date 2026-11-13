import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import ffmpeg from "@ffmpeg-installer/ffmpeg";
import { afterEach, describe, expect, it } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import {
  agentMovieSource,
  audioPeakBins,
  poolAudioPeaks,
  sourceAudioPeaks,
} from "../../src/movie/audio-peaks.js";
import {
  mapLimit,
  movieSourceFramePath,
  movieSourceFrameTimes,
  movieVideoSources,
  probeMovieVideoEnd,
} from "../../src/movie/video-sources.js";

let root = "";
const ffmpegOverride = process.env.HYPERFRAMES_FFMPEG_PATH;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = "";
  if (ffmpegOverride === undefined) delete process.env.HYPERFRAMES_FFMPEG_PATH;
  else process.env.HYPERFRAMES_FFMPEG_PATH = ffmpegOverride;
});

/** Routes the daemon's ffmpeg through a logging wrapper that behaves like newer ffmpeg: a still that finds no picture
 * exits non-zero, here after leaving a partial file behind. Returns the per-call argument log. */
async function newerFfmpeg(dir: string) {
  const shim = path.join(dir, "ffmpeg-shim.sh"), log = path.join(dir, "ffmpeg.log");
  const real = ffmpegOverride?.trim() || ffmpeg.path;
  await writeFile(shim, `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
"${real}" "$@" || exit $?
for last; do :; done
case " $* " in *" -frames:v "*) [ -s "$last" ] || { echo partial > "$last"; exit 234; } ;; esac
`);
  await chmod(shim, 0o755);
  await writeFile(log, "");
  process.env.HYPERFRAMES_FFMPEG_PATH = shim;
  return async () => (await readFile(log, "utf8")).split("\n").filter(Boolean);
}
const strayTemps = async (cache: string) =>
  (await readdir(cache)).filter((f) => !/^(frame-[\w-]+\.jpg|audio-peaks(-v2)?\.json|video-end\.json)$/.test(f));

/** 4 s of picture; a loud 1.0-1.5 s burst in a quiet tone, optionally delayed against the picture. */
function footage(file: string, { delay = 0, audio = 3, video = 4 } = {}) {
  execFileSync(ffmpeg.path, [
    "-nostdin", "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", `testsrc2=size=160x90:rate=24:duration=${video}`,
    ...(delay ? ["-itsoffset", String(delay)] : []),
    "-f", "lavfi", "-i", `aevalsrc='0.05*sin(2*PI*440*t)+0.9*between(t,1,1.5)*sin(2*PI*220*t)':s=48000:d=${audio}`,
    "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p", "-c:a", "aac", file,
  ], { stdio: "ignore" });
}
const loud = (peaks: number[]): [number, number] => {
  const bins = peaks.flatMap((p, i) => (p > 0.5 ? [i] : []));
  return [bins[0]!, bins.at(-1)!];
};

describe("source peak bins", () => {
  it("scale at 50 per second within 600-24000", () => {
    expect(audioPeakBins(0)).toBe(600);
    expect(audioPeakBins(Number.NaN)).toBe(600);
    expect(audioPeakBins(10)).toBe(600);
    expect(audioPeakBins(60)).toBe(3000);
    expect(audioPeakBins(180.5)).toBe(9025);
    expect(audioPeakBins(480)).toBe(24000);
    expect(audioPeakBins(14400)).toBe(24000);
  });

  it("put the audio on the picture clock when the first packet is late and the stream ends early", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-peaks-"));
    const aligned = path.join(root, "aligned.mp4"), delayed = path.join(root, "delayed.mp4");
    footage(aligned);
    footage(delayed, { delay: 1 });
    // 600 bins over 4 s: bin i covers [i, i + 1) * 4 / 600 s.
    const a = await sourceAudioPeaks(ffmpeg.path, aligned, 4);
    const b = await sourceAudioPeaks(ffmpeg.path, delayed, 4);
    expect(a).toHaveLength(600);
    expect(b).toHaveLength(600);
    const [aStart, aEnd] = loud(a), [bStart, bEnd] = loud(b);
    expect(Math.abs(aStart * 4 / 600 - 1)).toBeLessThan(0.03);
    expect(Math.abs(aEnd * 4 / 600 - 1.5)).toBeLessThan(0.03);
    expect(Math.abs(bStart * 4 / 600 - 2)).toBeLessThan(0.03);
    expect(Math.abs(bEnd * 4 / 600 - 2.5)).toBeLessThan(0.03);
    // The delayed stream is silent before its first packet; both are silent after they end.
    expect(Math.max(...b.slice(0, 140))).toBe(0);
    expect(Math.max(...a.slice(460))).toBe(0);
    expect(Math.max(...a)).toBe(1);
  });

  it("max-pool to at most 600 bins for agents, every output the max of the input bins it overlaps", () => {
    const full = Array.from({ length: 24000 }, () => 0.1);
    full[12345] = 1;
    const pooled = poolAudioPeaks(full);
    expect(pooled).toHaveLength(600);
    expect(pooled.flatMap((p, i) => (p === 1 ? [i] : []))).toEqual([Math.floor((12345 * 600) / 24000)]);
    // An uneven ratio: input bin i spans [i, i + 1) * 600 / 1000 of the output, so a straddling bin feeds both outputs.
    const uneven = Array.from({ length: 1000 }, (_, i) => Math.round(Math.abs(Math.sin(i * 7.3)) * 1000) / 1000);
    const pooledUneven = poolAudioPeaks(uneven);
    expect(pooledUneven).toHaveLength(600);
    pooledUneven.forEach((value, j) => {
      const covered = uneven.filter((_, i) => (i + 1) * 600 > j * 1000 && i * 600 < (j + 1) * 1000);
      expect(value).toBe(Math.max(...covered));
    });
    const spike = Array.from({ length: 1000 }, () => 0);
    spike[3] = 1; // [1.8, 2.4) of the output
    expect(poolAudioPeaks(spike).flatMap((p, i) => (p ? [i] : []))).toEqual([1, 2]);
    const short = [0, 0.5, 1];
    expect(poolAudioPeaks(short)).toBe(short);
  });

  it("give agents the same source with a pooled waveform", () => {
    const source = { assetId: "a", duration: 480, frames: [], audioPeaks: Array.from({ length: 24000 }, (_, i) => i / 24000) };
    const agent = agentMovieSource(source);
    expect(agent).toMatchObject({ assetId: "a", duration: 480, frames: [] });
    expect(agent.audioPeaks).toHaveLength(600);
    expect(source.audioPeaks).toHaveLength(24000);
    const silent = { assetId: "b", frames: [] };
    expect(agentMovieSource(silent)).toBe(silent);
  });
});

describe("source filmstrip frames", () => {
  it("cut about one frame per second, 6-48, at the middle of each slot", () => {
    expect(movieSourceFrameTimes(2)).toHaveLength(6);
    expect(movieSourceFrameTimes(10)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
    expect(movieSourceFrameTimes(30.2)).toHaveLength(31);
    const long = movieSourceFrameTimes(600);
    expect(long).toHaveLength(48);
    expect(long[0]).toBeCloseTo(6.25, 6);
    expect(long.at(-1)).toBeCloseTo(593.75, 6);
    expect(movieSourceFrameTimes(0.02)).toEqual([0]);
    expect(movieSourceFramePath("movie-sources/abc", 10, 3)).toBe("movie-sources/abc/frame-10-3.jpg");
  });

  it("never place a slot past the last picture, and cut collapsed slots once", () => {
    // Three pictures at 24 fps: the last one starts at 0.083 s, the stream ends at 0.125 s.
    const tiny = movieSourceFrameTimes(0.125, 0.083);
    expect(tiny).toHaveLength(5);
    expect(Math.max(...tiny)).toBe(0.083);
    expect(movieSourceFrameTimes(1 / 24, 0)).toEqual([0]);
    expect(movieSourceFrameTimes(3, 2.958)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
  });

  it("stop starting work once any run fails", async () => {
    let started = 0;
    await expect(mapLimit(Array.from({ length: 12 }, (_, i) => i), 4, async (i) => {
      started++;
      await new Promise((resolve) => setTimeout(resolve, i === 0 ? 1 : 5));
      if (i === 0) throw new Error("boom");
      return i;
    })).rejects.toThrow("boom");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(started).toBe(4);
  });

  it("read where the picture stops, by stream copy, on the seek clock", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-end-"));
    footage(path.join(root, "long-audio.mp4"), { audio: 7, video: 3 });
    // 24 fps with B-frames: the last packet in decode order is not the last picture.
    expect(await probeMovieVideoEnd(path.join(root, "long-audio.mp4"))).toEqual({ lastFrame: 2.958, end: 3 });
    expect(await probeMovieVideoEnd(path.join(root, "missing.mp4"))).toBeNull();
  });

  it("upgrade an old 6-frame, 600-bin cache lazily and span the frames over the picture, not the longer audio", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-frames-"));
    // 3 s of picture under 7 s of audio: the container runs 7 s, its picture stops at 3 s.
    footage(path.join(root, "long-audio.mp4"), { audio: 7, video: 3 });
    const doc = createMovieDocument("Footage", "blank");
    doc.style.assets = [{ id: "source", path: "long-audio.mp4", label: "Source" }];
    const first = (await movieVideoSources(root, doc))[0]!;
    const cache = path.dirname(path.join(root, first.frames[0]!.path));
    // Seed what an older daemon left behind: frame-<i>.jpg and a flat 600-bin peaks file.
    for (let i = 0; i < 6; i++) await writeFile(path.join(cache, `frame-${i}.jpg`), "stale");
    await writeFile(path.join(cache, "audio-peaks.json"), JSON.stringify(Array(600).fill(0.5)));
    await rm(path.join(cache, "audio-peaks-v2.json"));
    const [source] = await movieVideoSources(root, doc);
    expect(source!.duration).toBeCloseTo(7, 1);
    expect(source!.frames.map((f) => path.basename(f.path))).toEqual([0, 1, 2, 3, 4, 5].map((i) => `frame-6-${i}.jpg`));
    expect(source!.frames.map((f) => f.time)).toEqual([0.25, 0.75, 1.25, 1.75, 2.25, 2.75]);
    expect(source!.audioPeaks).toHaveLength(600);
    expect(source!.audioPeaks).not.toEqual(Array(600).fill(0.5));
    expect(JSON.parse(await readFile(path.join(cache, "video-end.json"), "utf8"))).toEqual({ lastFrame: 2.958, end: 3 });
    expect(await readdir(cache)).toContain("audio-peaks-v2.json");
    expect(await strayTemps(cache)).toEqual([]);
  });

  it("give a one-picture video under longer audio a single frame at its start", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-still-"));
    footage(path.join(root, "still.mp4"), { audio: 10, video: 1 / 24 });
    const doc = createMovieDocument("Still", "blank");
    doc.style.assets = [{ id: "still", path: "still.mp4" }];
    const [source] = await movieVideoSources(root, doc);
    expect(source!.duration).toBeCloseTo(10, 1);
    expect(source!.frames).toEqual([{ time: 0, path: expect.stringMatching(/\/frame-1-0\.jpg$/) }]);
    expect(source!.audioPeaks).toHaveLength(600);
  });

  it.skipIf(process.platform === "win32")("skip slots newer ffmpeg rejects, drop their partial files and fall back to a poster", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-poster-"));
    footage(path.join(root, "still.mp4"), { audio: 10, video: 1 / 24 });
    const doc = createMovieDocument("Poster", "blank");
    doc.style.assets = [{ id: "still", path: "still.mp4" }];
    const first = (await movieVideoSources(root, doc))[0]!;
    const cache = path.dirname(path.join(root, first.frames[0]!.path));
    // A bound that is wrong for this content sends every seek past its only picture.
    await writeFile(path.join(cache, "video-end.json"), JSON.stringify({ lastFrame: 9.9, end: 10 }));
    const calls = await newerFfmpeg(root);
    const [source] = await movieVideoSources(root, doc);
    expect(source!.frames).toEqual([{ time: 0, path: expect.stringMatching(/\/frame-poster\.jpg$/) }]);
    expect((await calls()).filter((c) => c.includes(" -ss "))).toHaveLength(10);
    expect(await strayTemps(cache)).toEqual([]);
  });

  it.skipIf(process.platform === "win32")("cut and measure a normal file once; later requests only read its header", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-once-"));
    footage(path.join(root, "normal.mp4"), { audio: 10, video: 10 });
    const doc = createMovieDocument("Normal", "blank");
    doc.style.assets = [{ id: "normal", path: "normal.mp4" }];
    const calls = await newerFfmpeg(root);
    const [first] = await movieVideoSources(root, doc);
    expect(first!.frames.map((f) => f.time)).toEqual([0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.5, 7.5, 8.5, 9.5]);
    expect((await calls()).length).toBeGreaterThan(10);
    const before = (await calls()).length;
    const [again] = await movieVideoSources(root, doc);
    expect(again).toEqual(first);
    // Only the per-request header probe (`-t 0`) runs; frames, the video end and the peaks come from the cache.
    expect((await calls()).slice(before)).toEqual([expect.stringContaining(" -t 0 ")]);
  });

  it("keep images as their own single frame and audio without frames", async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "movie-kinds-"));
    execFileSync(ffmpeg.path, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=red:s=64x36", "-frames:v", "1", path.join(root, "still.png")]);
    execFileSync(ffmpeg.path, ["-nostdin", "-loglevel", "error", "-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac", path.join(root, "tone.m4a")]);
    const doc = createMovieDocument("Kinds", "blank");
    doc.style.assets = [{ id: "still", path: "still.png" }, { id: "tone", path: "tone.m4a" }];
    const [still, tone] = await movieVideoSources(root, doc);
    expect(still).toMatchObject({ kind: "image", frames: [{ time: 0, path: "still.png" }] });
    expect(tone).toMatchObject({ kind: "audio", hasAudio: true, frames: [] });
    expect(tone!.audioPeaks).toHaveLength(600);
  });
});
