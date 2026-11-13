import { createHash, randomUUID } from "node:crypto";
import { copyFile, lstat, mkdir, rename, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { movieAssetPaths, type MovieDocument } from "@open-design/contracts";
import { safeMovieAsset, MovieError } from "./store.js";
import { stageMovieClips } from "./video-sources.js";

const digestEntries = (entries: string[][]) =>
  createHash("sha256")
    .update(JSON.stringify(entries.sort(([a], [b]) => a!.localeCompare(b!))))
    .digest("hex");

export async function movieAssetDigest(
  projectDir: string,
  document: MovieDocument,
): Promise<string> {
  const entries: string[][] = [];
  let total = 0;
  for (const relative of movieAssetPaths(document)) {
    const source = await safeMovieAsset(projectDir, relative);
    total += (await lstat(source)).size;
    if (total > 256 * 1024 * 1024)
      throw new MovieError("Render media exceeds 256 MiB");
    entries.push([
      relative,
      createHash("sha256")
        .update(await readFile(source))
        .digest("hex"),
    ]);
  }
  return digestEntries(entries);
}

/** Renderers serve their composition root; copy media into that root first. */
export async function stageMovieAssets(
  projectDir: string,
  compositionDir: string,
  document: MovieDocument,
): Promise<{ document: MovieDocument; files: string[]; digest: string }> {
  const paths = movieAssetPaths(document),
    mapped = new Map<string, string>(),
    files: string[] = [],
    entries: string[][] = [];
  if (paths.length) {
    const mediaDir = path.join(projectDir, compositionDir, "media");
    await mkdir(mediaDir, { recursive: true });
    const stat = await lstat(mediaDir);
    if (stat.isSymbolicLink() || !stat.isDirectory())
      throw new MovieError("Render media directory must be a real directory");
    let total = 0;
    for (const relative of paths) {
      const source = await safeMovieAsset(projectDir, relative),
        info = await lstat(source);
      total += info.size;
      if (total > 256 * 1024 * 1024)
        throw new MovieError("Render media exceeds 256 MiB");
      const name =
        createHash("sha256").update(relative).digest("hex").slice(0, 16) +
        path.extname(relative).toLowerCase();
      const target = path.join(mediaDir, name);
      try {
        const info = await lstat(target);
        if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1)
          throw new MovieError("Render asset must be a regular file");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const temp = path.join(mediaDir, `.asset-${randomUUID()}`);
      await copyFile(source, temp, constants.COPYFILE_EXCL);
      await rename(temp, target);
      entries.push([
        relative,
        createHash("sha256")
          .update(await readFile(target))
          .digest("hex"),
      ]);
      mapped.set(relative, `media/${name}`);
      files.push(`${compositionDir}/media/${name}`);
    }
  }
  const copy = structuredClone(document);
  copy.shots = copy.shots.map((s) =>
    s.media ? { ...s, media: mapped.get(s.media)! } : s,
  );
  if (copy.style.assets)
    copy.style.assets = copy.style.assets.map((a) => ({
      ...a,
      path: mapped.get(a.path)!,
    }));
  if (copy.style.demoShots)
    copy.style.demoShots = copy.style.demoShots.map((s) =>
      s.media ? { ...s, media: mapped.get(s.media)! } : s,
    );
  files.push(...(await stageMovieClips(projectDir, compositionDir, copy)));
  return { document: copy, files, digest: digestEntries(entries) };
}
