import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { hashPackageSourcePath, packageSourceHashOptions } from "@/package-source-hash.js";

describe("hashPackageSourcePath", () => {
  it('tracks vendored search source while excluding prepared runtime and Python caches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'native-search-hash-'));
    const source = join(root, 'vendor/smart-search/src');
    const options = packageSourceHashOptions('@fantay/native-web-search');
    try {
      await mkdir(source, { recursive: true });
      await writeFile(join(source, 'engine.py'), 'version = 1');
      const before = await hashPackageSourcePath(root, options);
      for (const dir of ['runtime', '.tmp', 'vendor/smart-search/.venv', 'vendor/smart-search/src/__pycache__']) {
        await mkdir(join(root, dir), { recursive: true });
        await writeFile(join(root, dir, 'generated'), 'binary or cache');
      }
      expect(await hashPackageSourcePath(root, options)).toBe(before);
      await writeFile(join(source, 'engine.py'), 'version = 2');
      expect(await hashPackageSourcePath(root, options)).not.toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("includes package versions in the source hash", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-package-source-hash-"));
    const packageRoot = join(root, "apps", "packaged");
    try {
      await mkdir(join(packageRoot, "src"), { recursive: true });
      await writeFile(join(packageRoot, "src", "index.ts"), "export const value = 1;\n", "utf8");
      await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "@open-design/packaged", version: "1.0.0" }, null, 2)}\n`, "utf8");
      const firstHash = await hashPackageSourcePath(packageRoot);

      await writeFile(join(packageRoot, "package.json"), `${JSON.stringify({ name: "@open-design/packaged", version: "1.0.1" }, null, 2)}\n`, "utf8");
      const secondHash = await hashPackageSourcePath(packageRoot);

      expect(secondHash).not.toBe(firstHash);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
