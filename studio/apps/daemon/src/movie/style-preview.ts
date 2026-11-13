import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readdir, writeFile, lstat, rename } from "node:fs/promises";
import path from "node:path";
import {
  buildMovieHtml,
  movieTransitionDuration,
  movieAssetPaths,
  movieShotStarts,
  type MovieDocument,
} from "@open-design/contracts";
import { scaffoldHyperFramesComposition } from "../media/hyperframes-scaffold.js";
import { safeMovieAsset, MovieError } from "./store.js";
import { stageMovieAssets, movieAssetDigest } from "./assets.js";
import {
  renderMoviePreviewFramesWithDesktop,
  resolveMoviePreviewRenderer,
  type MovieFrameRenderer,
} from "./preview-renderer.js";
const exec = promisify(execFile),
  require = createRequire(import.meta.url),
  pending = new Map<string, Promise<string[]>>();

async function assertPreviewPath(dir: string, relative: string): Promise<void> {
  let current = dir;
  for (const part of relative.split("/")) {
    current = path.join(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink())
        throw new MovieError("Preview paths cannot be symbolic links");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }
}

export interface MoviePreviewOptions {
  storyboard?: boolean;
  motion?: boolean;
  shotIds?: string[];
}
export function moviePreviewShotIds(
  document: MovieDocument,
  options: MoviePreviewOptions = {},
): string[] {
  const ids =
    options.shotIds ??
    document.shots
      .slice(0, options.storyboard || options.motion ? 6 : 1)
      .map((s) => s.id);
  if (
    !ids.length ||
    ids.length > 6 ||
    new Set(ids).size !== ids.length ||
    ids.some(
      (id) =>
        typeof id !== "string" || !document.shots.some((s) => s.id === id),
    )
  )
    throw new MovieError("Choose 1–6 existing unique shot IDs for a preview");
  return ids;
}
export function moviePreviewTimes(
  document: MovieDocument,
  options: MoviePreviewOptions = {},
): number[] {
  if (!document.shots.length)
    throw new MovieError("Design a scene before previewing");
  const selected = new Set(moviePreviewShotIds(document, options));
  const starts = movieShotStarts(document);
  return document.shots.flatMap((shot, index) => {
    const start = starts[index]!;
    const times = !selected.has(shot.id)
      ? []
      : options.motion
        ? [0.15, 0.5, 0.85].map((p) => start + shot.duration * p)
        : [start + Math.min(0.85, shot.duration / 2)];
    const blend = index ? movieTransitionDuration(document, index - 1) : 0;
    if (options.motion && selected.has(shot.id) && blend > 0)
      times.push(start + blend / 2);
    times.sort((a, b) => a - b);
    return times;
  });
}
/**
 * Renders (or reuses) the sample stills. Renderer rule (amendment C6, same as `renderHyperFrames`):
 * HYPERFRAMES_BROWSER_PATH → HyperFrames CLI snapshot; else `desktopFrameRenderer` → the desktop
 * app's Electron Chromium; else 503. Never downloads a browser.
 */
export async function previewMovieStyle(
  dir: string,
  document: MovieDocument,
  options: MoviePreviewOptions = {},
  desktopFrameRenderer: MovieFrameRenderer | null = null,
): Promise<string[]> {
  const renderer = resolveMoviePreviewRenderer(desktopFrameRenderer);
  if (!renderer)
    throw new MovieError(
      "Open the Fantay desktop app or configure HYPERFRAMES_BROWSER_PATH before generating style samples.",
      503,
    );
  for (const asset of movieAssetPaths(document))
    await safeMovieAsset(dir, asset);
  const hash = createHash("sha256")
    .update(
      JSON.stringify([
        "motion-scenes-v7",
        !!options.storyboard,
        !!options.motion,
        options.shotIds ?? null,
        document.title,
        document.style,
        document.shots,
        document.aspect,
        await movieAssetDigest(dir, document),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
  const relative = `motion-source/style-${hash}`,
    root = path.join(dir, relative),
    output = path.join(root, "samples");
  await assertPreviewPath(dir, relative + "/samples");
  await assertPreviewPath(dir, relative + "/index.html");
  const cached = await readdir(output).catch(() => [] as string[]);
  for (const name of cached.filter((name) => name.endsWith(".png")))
    await safeMovieAsset(dir, `${relative}/samples/${name}`);
  if (
    !options.storyboard &&
    cached.filter((name) => name.endsWith(".png")).length ===
      moviePreviewTimes(document, options).length
  ) {
    const paths = cached
      .filter((n) => n.endsWith(".png"))
      .sort()
      .map((n) => `${relative}/samples/${n}`);
    for (const file of paths) await safeMovieAsset(dir, file);
    return paths;
  }
  const existing = pending.get(root);
  if (existing) return existing;
  const run = (async () => {
    try {
      await scaffoldHyperFramesComposition({
        projectDir: dir,
        compositionDir: relative,
      });
    } catch (error) {
      if (!String(error).includes("already exists")) throw error;
    }
    await assertPreviewPath(dir, relative + "/samples");
    await assertPreviewPath(dir, relative + "/index.html");
    await mkdir(output, { recursive: true });
    const staged = await stageMovieAssets(dir, relative, document);
    const tempIndex = path.join(root, `.preview-${randomUUID()}.html`);
    await writeFile(tempIndex, buildMovieHtml(staged.document), { flag: "wx" });
    await rename(tempIndex, path.join(root, "index.html"));
    const cli = path.join(
      path.dirname(require.resolve("hyperframes/package.json")),
      "bin",
      "hyperframes.mjs",
    );
    if (renderer.kind === "desktop")
      await renderMoviePreviewFramesWithDesktop({
        compositionDir: root,
        outputDir: output,
        times: moviePreviewTimes(document, options),
        render: renderer.render,
      });
    else await exec(
      process.execPath,
      [
        cli,
        "snapshot",
        root,
        "--at",
        moviePreviewTimes(document, options).join(","),
        "--no-end",
        "--describe",
        "false",
        "--output",
        output,
      ],
      {
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1" },
      },
    );
    const files = (await readdir(output))
      .filter((n) => n.endsWith(".png"))
      .sort();
    if (!files.length)
      throw new MovieError("Preview renderer returned no images", 500);
    return files.map((n) => `${relative}/samples/${n}`);
  })();
  pending.set(root, run);
  try {
    return await run;
  } finally {
    pending.delete(root);
  }
}
