import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, describe, it, expect } from "vitest";
import {
  createMovieDocument,
  buildMovieHtml,
  MOVIE_STYLES,
} from "@open-design/contracts";
import { stageMovieAssets, movieAssetDigest } from "../../src/movie/assets.js";
const dirs: string[] = [];
async function temp() {
  const p = await mkdtemp(path.join(os.tmpdir(), "movie-assets-"));
  dirs.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("Render media staging", () => {
  it("puts library media inside the renderer root and rewrites both style and shot paths", async () => {
    const root = await temp();
    await mkdir(path.join(root, "references"));
    await mkdir(path.join(root, "motion-source", "test"), { recursive: true });
    await writeFile(path.join(root, "references", "art.svg"), "<svg/>");
    const doc = createMovieDocument(
      "Artwork",
      "library",
      MOVIE_STYLES.find((s) => s.id === "gallery")!,
    );
    doc.style.assets = [{ id: "cover", path: "references/art.svg" }];
    doc.shots[0]!.media = "references/art.svg";
    const staged = await stageMovieAssets(root, "motion-source/test", doc);
    expect(staged.digest).toBe(await movieAssetDigest(root, doc));
    expect(staged.files).toHaveLength(1);
    expect(staged.document.shots[0]?.media).toMatch(/^media\//);
    expect(doc.shots[0]?.media).toBe("references/art.svg");
    expect(await readFile(path.join(root, staged.files[0]!), "utf8")).toBe(
      "<svg/>",
    );
    expect(buildMovieHtml(staged.document)).not.toContain('src="../../');
    await writeFile(
      path.join(root, "references", "art.svg"),
      "<svg><path/></svg>",
    );
    expect(staged.digest).not.toBe(await movieAssetDigest(root, doc));
  });
  it("rejects a linked renderer media folder", async () => {
    const root = await temp(),
      outside = await temp();
    await mkdir(path.join(root, "motion-source", "test"), { recursive: true });
    await writeFile(path.join(root, "art.svg"), "<svg/>");
    await symlink(outside, path.join(root, "motion-source", "test", "media"));
    const doc = createMovieDocument();
    doc.style.assets = [{ id: "cover", path: "art.svg" }];
    await expect(
      stageMovieAssets(root, "motion-source/test", doc),
    ).rejects.toThrow("real directory");
  });
});
