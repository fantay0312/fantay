import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  symlink,
  readFile,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  createMovieDocument,
  type MovieDocument,
} from "@open-design/contracts";
import { previewMovieStyle } from "../../src/movie/style-preview.js";
const dirs: string[] = [];
const temp = async () => {
  const p = await mkdtemp(path.join(os.tmpdir(), "style-preview-"));
  dirs.push(p);
  return p;
};
const folder = (d: MovieDocument) =>
  "style-" +
  createHash("sha256")
    .update(
      JSON.stringify([
        "motion-scenes-v7",
        false,
        false,
        null,
        d.title,
        d.style,
        d.shots,
        d.aspect,
        createHash("sha256").update("[]").digest("hex"),
      ]),
    )
    .digest("hex")
    .slice(0, 16);
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(
    dirs.splice(0).map((p) => rm(p, { recursive: true, force: true })),
  );
});
describe("Style preview cache", () => {
  it("rejects a linked cache directory before writing outside the project", async () => {
    vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "test");
    const root = await temp(),
      outside = await temp(),
      doc = createMovieDocument();
    await mkdir(path.join(root, "motion-source"));
    await writeFile(path.join(outside, "index.html"), "protected");
    await symlink(outside, path.join(root, "motion-source", folder(doc)));
    await expect(previewMovieStyle(root, doc)).rejects.toThrow("symbolic");
    expect(await readFile(path.join(outside, "index.html"), "utf8")).toBe(
      "protected",
    );
  });
  it("gives renamed films their own cache and rejects linked PNGs", async () => {
    vi.stubEnv("HYPERFRAMES_BROWSER_PATH", "test");
    const root = await temp(),
      first = createMovieDocument("One"),
      second = { ...first, title: "Two" };
    for (const d of [first, second]) {
      const dir = path.join(root, "motion-source", folder(d), "samples");
      await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, "frame.png"), "cached");
    }
    expect(await previewMovieStyle(root, first)).not.toEqual(
      await previewMovieStyle(root, second),
    );
    const outside = await temp();
    await writeFile(path.join(outside, "file.png"), "outside");
    const linked = path.join(
      root,
      "motion-source",
      folder(first),
      "samples",
      "linked.png",
    );
    await symlink(path.join(outside, "file.png"), linked);
    await expect(previewMovieStyle(root, first)).rejects.toThrow("Symbolic");
  });
});
