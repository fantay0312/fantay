import { chmod, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PACKAGED_KERNEL } from "@open-design/sidecar-proto";
import { afterEach, describe, expect, it } from "vitest";

import { stageKernel } from "../src/mac-kernel.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "fantay-mac-kernel-"));
  tempDirs.push(dir);
  return dir;
}

async function createShippedResources(base: string): Promise<string> {
  const resources = join(base, "Resources");
  await mkdir(join(resources, "fantay-kernel"), { recursive: true });
  await mkdir(join(resources, "app", "prebundled", "daemon"), { recursive: true });
  await mkdir(join(resources, "app", "node_modules", "@open-design", "sidecar", "dist"), { recursive: true });
  await mkdir(join(resources, "app", "node_modules", "@fantay", "tokens"), { recursive: true });
  await mkdir(join(resources, "app", "node_modules", "better-sqlite3", "build", "Release"), { recursive: true });
  await mkdir(join(resources, PACKAGED_KERNEL.resources), { recursive: true });

  await writeFile(join(resources, "fantay-kernel", "node"), "#!/bin/sh\n", { mode: 0o755 });
  await writeFile(join(resources, "fantay-kernel", "better_sqlite3.node"), "kernel-sqlite-binary");
  await writeFile(join(resources, "app", "node_modules", "better-sqlite3", "build", "Release", "better_sqlite3.node"), "electron-sqlite-binary");
  await writeFile(join(resources, "app", "prebundled", "daemon", "daemon-sidecar.mjs"), "export default 1;\n");
  await writeFile(join(resources, "app", "prebundled", "daemon", "daemon-cli.mjs"), "export default 2;\n");
  await writeFile(join(resources, "app", "node_modules", "@open-design", "sidecar", "dist", "supervisor.mjs"), "export default 3;\n");
  await writeFile(join(resources, "app", "node_modules", "@fantay", "tokens", "index.js"), "desktop-only");
  await writeFile(join(resources, PACKAGED_KERNEL.resources, "asset.txt"), "v1");
  await writeFile(join(resources, PACKAGED_KERNEL.resources, ".DS_Store"), "finder");
  return resources;
}

describe("stageKernel", () => {
  it("stages the macOS kernel once, caches bundle metadata on warm runs, and invalidates on bundle edits", async () => {
    const base = await makeTempDir();
    const root = join(base, "kernel");
    const resources = await createShippedResources(base);

    const v1 = await stageKernel(root, resources, "0.25.1");
    const stagedDir = join(root, PACKAGED_KERNEL.versions, v1);
    const manifestPath = join(stagedDir, PACKAGED_KERNEL.manifestFile);
    const digestPath = join(root, "bundle-digest.json");

    expect(JSON.parse(await readFile(manifestPath, "utf8"))).toEqual({
      version: v1,
      release: "0.25.1",
      protocol: 1,
    });
    const digest1 = JSON.parse(await readFile(digestPath, "utf8")) as { metaDigest: string; version: string };
    expect(digest1.version).toBe(v1);
    expect(await readFile(join(stagedDir, "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node"), "utf8")).toBe("kernel-sqlite-binary");
    await expect(readFile(join(stagedDir, "app/node_modules/@fantay/tokens/index.js"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    // Warm run with unchanged metadata returns the cached version immediately.
    const warm = await stageKernel(root, resources, "0.25.1");
    expect(warm).toBe(v1);

    // Removing the staged manifest forces re-staging even if bundle-digest.json still matches.
    await rm(manifestPath);
    expect(await stageKernel(root, resources, "0.25.1")).toBe(v1);
    expect(JSON.parse(await readFile(manifestPath, "utf8")).version).toBe(v1);

    // Same-length in-place edit with updated mtime invalidates the metadata digest and stages a new content version.
    const assetPath = join(resources, PACKAGED_KERNEL.resources, "asset.txt");
    await writeFile(assetPath, "v2");
    const future = new Date(Date.now() + 5_000);
    await utimes(assetPath, future, future);

    const v2 = await stageKernel(root, resources, "0.25.2");
    expect(v2).not.toBe(v1);
    const digest2 = JSON.parse(await readFile(digestPath, "utf8")) as { metaDigest: string; version: string };
    expect(digest2.version).toBe(v2);
    expect(digest2.metaDigest).not.toBe(digest1.metaDigest);
  });

  it("rejects symlinks that escape the shipped resource boundary even after caching", async () => {
    const base = await makeTempDir();
    const root = join(base, "kernel");
    const resources = await createShippedResources(base);
    await stageKernel(root, resources, "0.25.1");

    await chmod(join(resources, "fantay-kernel", "node"), 0o755);
    await symlink("../../../../outside", join(resources, "app", "node_modules", "escape-link"));
    await expect(stageKernel(root, resources, "0.25.1")).rejects.toThrow("Kernel dependency symlink escapes its bundle");
  });
});
