import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  symlink,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createMovieDocument } from "@open-design/contracts";
import { saveMovie, applyMovieAction } from "../../src/movie/store.js";
import { copyReusableStyle } from "../../src/movie/style-links.js";
const dirs: string[] = [];
const temp = async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "style-snapshot-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(
    dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
it("freezes media and source evidence so later edits do not change a saved reusable style", async () => {
  const source = await temp(),
    target = await temp();
  await mkdir(path.join(source, "art"));
  await writeFile(path.join(source, "art/shape.svg"), "<svg>original</svg>");
  await writeFile(
    path.join(source, "fantasy-design-receipt.json"),
    "original receipt",
  );
  const doc = createMovieDocument();
  doc.style.assets = [{ id: "art", path: "art/shape.svg" }];
  doc.shots[0]!.media = "art/shape.svg";
  doc.style.references = [
    {
      materialId: "local",
      title: "Art",
      license: "Original",
      receipt: "fantasy-design-receipt.json",
    },
  ];
  let d = await saveMovie(source, { expectedRevision: 0, document: doc });
  d = await applyMovieAction(source, d.revision, { action: "save-style" });
  expect(d.savedStyles[0]?.assets?.[0]?.path).toMatch(/^movie-styles\//);
  await writeFile(path.join(source, "art/shape.svg"), "<svg>changed</svg>");
  await writeFile(
    path.join(source, "fantasy-design-receipt.json"),
    "changed receipt",
  );
  const reused = await copyReusableStyle(d.savedStyles[0]!, source, target);
  expect(
    await readFile(path.join(target, reused.assets![0]!.path), "utf8"),
  ).toBe("<svg>original</svg>");
  expect(
    await readFile(path.join(target, reused.references![0]!.receipt!), "utf8"),
  ).toBe("original receipt");
  expect(reused.demoShots![0]!.media).toBe(reused.assets![0]!.path);
});
it("refuses a linked style-snapshot root", async () => {
  const source = await temp(),
    outside = await temp();
  await writeFile(path.join(source, "art.svg"), "<svg/>");
  await symlink(outside, path.join(source, "movie-styles"));
  const doc = createMovieDocument();
  doc.style.assets = [{ id: "art", path: "art.svg" }];
  const d = await saveMovie(source, { expectedRevision: 0, document: doc });
  await expect(
    applyMovieAction(source, d.revision, { action: "save-style" }),
  ).rejects.toThrow("real directory");
});
