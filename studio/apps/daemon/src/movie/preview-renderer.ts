// SPDX-License-Identifier: Apache-2.0
/**
 * Frame renderer for movie style samples (样张) and one-pass production (amendment C6).
 *
 * Same rule as `renderHyperFrames` in `media/index.ts`: an explicit `HYPERFRAMES_BROWSER_PATH`
 * keeps the headless HyperFrames CLI (daemon-only development), else the desktop frame renderer
 * the daemon was started with (the Electron Chromium that ships with the desktop app), else
 * nothing. The daemon never discovers or downloads a second browser.
 *
 * The desktop renderer captures a timeline at a fixed frame rate. Style samples need stills at
 * chosen times, so the composition gets the same HyperFrames frame bridge a final render uses
 * plus a small remap: the capture walks frames 0..n-1 at 1 fps and frame i seeks to times[i].
 */
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, mkdtemp, readFile, rename, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { load } from "cheerio";
import type {
  DesktopRenderFramesInput,
  DesktopRenderFramesResult,
} from "@open-design/sidecar-proto";
import type { MoviePreviewAvailability } from "@open-design/contracts";
export type { MoviePreviewAvailability, MoviePreviewRendererKind } from "@open-design/contracts";
import {
  findRealTagOffset,
  HTML_TAG_PATTERNS,
} from "@open-design/contracts/runtime/html-injection-points";
import { injectMotionSourcePlayer } from "@open-design/contracts/runtime/motion-source-player";
import {
  hyperFramesCompositionMetrics,
  injectHyperFramesFrameBridge,
} from "../media/index.js";
import { resolveHyperFramesBrowserRuntimePath } from "../media/hyperframes-runtime.js";
import { MovieError } from "./store.js";

/** The daemon's desktop frame renderer (`StartServerOptions.desktopFrameRenderer`). */
export type MovieFrameRenderer = (
  input: DesktopRenderFramesInput,
) => Promise<DesktopRenderFramesResult>;

export type MoviePreviewRenderer =
  | { kind: "browser" }
  | { kind: "desktop"; render: MovieFrameRenderer };

/** What `GET /api/movie/integration?include=capabilities` reports as `capabilities.preview`. */
type PreviewEnv = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** An explicitly configured headless browser for the HyperFrames CLI (never auto-discovered). */
export function hasHeadlessPreviewBrowser(env: PreviewEnv = process.env): boolean {
  return Boolean(env.HYPERFRAMES_BROWSER_PATH?.trim());
}

/** HYPERFRAMES_BROWSER_PATH first, else the desktop frame renderer, else null. */
export function resolveMoviePreviewRenderer(
  desktopFrameRenderer: MovieFrameRenderer | null | undefined,
  env: PreviewEnv = process.env,
): MoviePreviewRenderer | null {
  if (hasHeadlessPreviewBrowser(env)) return { kind: "browser" };
  if (typeof desktopFrameRenderer === "function")
    return { kind: "desktop", render: desktopFrameRenderer };
  return null;
}

export async function moviePreviewAvailability(
  desktopFrameRenderer: MovieFrameRenderer | null | undefined,
  env: PreviewEnv = process.env,
  desktopFrameRendererReady?: (() => Promise<boolean>) | null,
): Promise<MoviePreviewAvailability> {
  if (hasHeadlessPreviewBrowser(env)) return { available: true, renderer: "browser" };
  const ready = typeof desktopFrameRenderer === 'function' && typeof desktopFrameRendererReady === 'function'
    && await desktopFrameRendererReady().catch(() => false);
  return { available: Boolean(ready), renderer: ready ? 'desktop' : null };
}

/** Sample file name; identical to the HyperFrames CLI snapshot names, so order and cache match. */
export function moviePreviewFrameName(index: number, time: number): string {
  return `frame-${String(index).padStart(2, "0")}-at-${Number(time.toFixed(3))}s.png`;
}

function insertBeforeBodyEnd(html: string, markup: string): string {
  const bodyClose = findRealTagOffset(html, HTML_TAG_PATTERNS.bodyClose);
  return bodyClose >= 0
    ? html.slice(0, bodyClose) + markup + html.slice(bodyClose)
    : html + markup;
}

/**
 * Wraps the frame bridge (`window.__odFrameRenderer`, from `injectHyperFramesFrameBridge`) so a
 * capture at 1 fps yields one still per sample time: `ready()` reports `times.length` seconds and
 * `seek(_, i)` seeks the real timeline to `times[i]`.
 */
export function injectPreviewSampleTimes(html: string, times: readonly number[]): string {
  const list = JSON.stringify(times.map((time) => Number(time))).replace(/</g, "\\u003c");
  const script = `<script data-fantay-preview-samples>(()=>{const base=window.__odFrameRenderer;const times=${list};if(!base||typeof base.ready!=='function'||typeof base.seek!=='function')return;window.__odFrameRenderer={async ready(){await base.ready();return{duration:times.length,fps:1};},async seek(time,frameIndex){const index=Number.isInteger(frameIndex)?frameIndex:Math.round(Number(time)||0);await base.seek(times[Math.max(0,Math.min(times.length-1,index))]);}};})();</script>`;
  return insertBeforeBodyEnd(html, script);
}

/** Stills need no sound, and the desktop capture refuses documents with `<audio>`. */
export function silencePreviewAudio(html: string): string {
  if (!/<audio\b/i.test(html)) return html;
  const $ = load(html);
  $("audio").each((_, element) => {
    const audio = $(element);
    audio.replaceWith($("<span hidden></span>").attr("id", audio.attr("id") ?? ""));
  });
  return $.html();
}

function framePath(pattern: string, index: number): string {
  const padded = pattern.replace(/%0(\d+)d/, (_, width: string) =>
    String(index).padStart(Number(width), "0"),
  );
  return padded === pattern ? pattern.replace("%d", String(index)) : padded;
}

/**
 * Renders `times` of the composition in `compositionDir` (absolute; holds `index.html`, staged
 * media and `gsap.min.js`) with the desktop frame renderer and writes the stills into
 * `outputDir` under the CLI snapshot names. Scratch frames live in the OS temp dir and are removed.
 */
export async function renderMoviePreviewFramesWithDesktop(input: {
  compositionDir: string;
  outputDir: string;
  times: readonly number[];
  render: MovieFrameRenderer;
}): Promise<void> {
  const { compositionDir, outputDir, times, render } = input;
  if (!times.length) throw new MovieError("Design a scene before previewing");
  const source = injectMotionSourcePlayer(
    await readFile(path.join(compositionDir, "index.html"), "utf8"),
  );
  const runtime = await readFile(resolveHyperFramesBrowserRuntimePath(), "utf8");
  const html = injectPreviewSampleTimes(
    injectHyperFramesFrameBridge(silencePreviewAudio(source), runtime),
    times,
  );
  const { width, height } = hyperFramesCompositionMetrics(html);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "fantay-movie-preview-"));
  try {
    const result = await render({
      baseHref: pathToFileURL(`${compositionDir}${path.sep}`).href,
      fps: 1,
      width,
      height,
      html,
      outputDir: path.join(scratch, "frames"),
    });
    if (!result.ok || !result.framePattern || (result.frameCount ?? 0) < times.length)
      throw new MovieError(
        result.error || "Preview renderer returned no images",
        result.errorCode === "FRAME_RENDERER_NOT_READY" ? 503 : 500,
      );
    for (let index = 0; index < times.length; index += 1) {
      // Copy to a fresh name, then rename: a link planted at the final name is replaced, not followed.
      const temp = path.join(outputDir, `.sample-${randomUUID()}.tmp`);
      await copyFile(framePath(result.framePattern, index), temp, constants.COPYFILE_EXCL);
      await rename(temp, path.join(outputDir, moviePreviewFrameName(index, times[index]!)));
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
