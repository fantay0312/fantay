import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import {
  movieAssetPaths,
  type MovieDocument,
  type MovieStyle,
} from "@open-design/contracts";
import { stageMovieAssets } from "./assets.js";
import { MovieError, safeMovieAsset } from "./store.js";

/** Saved styles own copies of their media, independent of later scene edits. */
export async function snapshotMovieStyle(
  dir: string,
  doc: MovieDocument,
  id: string,
  expectedDigest: string,
): Promise<MovieStyle> {
  if (
    !movieAssetPaths(doc).length &&
    !doc.style.references?.some((r) => r.receipt)
  )
    return {
      ...structuredClone(doc.style),
      demoShots: structuredClone(doc.shots),
      aspect: doc.aspect,
    };
  const root = path.join(dir, "movie-styles");
  await mkdir(root, { recursive: true });
  if ((await lstat(root)).isSymbolicLink())
    throw new MovieError("Style snapshot folder must be a real directory");
  const relative = `movie-styles/${id}`,
    target = path.join(dir, relative);
  await mkdir(target);
  try {
    const staged = await stageMovieAssets(dir, relative, doc);
    if (staged.digest !== expectedDigest)
      throw new MovieError(
        "The assets changed during style save. Preview again.",
        409,
      );
    const style = staged.document.style;
    if (style.assets)
      style.assets = style.assets.map((a) => ({
        ...a,
        path: `${relative}/${a.path}`,
      }));
    style.demoShots = staged.document.shots.map((s) =>
      s.media ? { ...s, media: `${relative}/${s.media}` } : s,
    );
    if (style.references) {
      const evidence = path.join(target, "evidence");
      await mkdir(evidence);
      for (let i = 0; i < style.references.length; i++) {
        const ref = style.references[i]!;
        if (!ref.receipt) continue;
        const source = await safeMovieAsset(dir, ref.receipt);
        if ((await lstat(source)).size > 2 * 1024 * 1024)
          throw new MovieError("Material receipt exceeds 2 MiB");
        const name = `${i}-${path.basename(ref.receipt)}`;
        await copyFile(
          source,
          path.join(evidence, name),
          constants.COPYFILE_EXCL,
        );
        ref.receipt = `${relative}/evidence/${name}`;
      }
    }
    style.aspect = doc.aspect;
    return style;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
}
