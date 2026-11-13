import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackCache } from "@/cache/index.js";
import type { ToolPackConfig } from "@/config/index.js";
import { prepareResourceTree } from "@/win/resources.js";
import type { WinPaths } from "@/win/types.js";
import * as piRuntime from '@/resources/pi.js';

// Resource-tree tests never download pi: without OPEN_DESIGN_PI_BIN the pinned release is unreachable.
beforeEach(() => { vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network disabled in tools-pack tests'); })); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function stubPiVersion() {
  const copy = piRuntime.copyStandalonePi;
  vi.spyOn(piRuntime, 'copyStandalonePi').mockImplementation(options => copy({ ...options, version: async () => piRuntime.PI_VERSION }));
}

const RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS = 15_000;

async function createWorkspaceFixture(workspaceRoot: string): Promise<void> {
  await mkdir(join(workspaceRoot, 'vendor', 'jianying-draft'), { recursive: true });
  await writeFile(join(workspaceRoot, 'vendor', 'jianying-draft', 'worker.ts'), '/* draft worker v1 */');
  await mkdir(join(workspaceRoot, "licenses"), { recursive: true });
  await writeFile(join(workspaceRoot, "LICENSE"), "Apache-2.0");
  await writeFile(join(workspaceRoot, "THIRD_PARTY_NOTICES.md"), "Third-party notices");
  await writeFile(join(workspaceRoot, "licenses", "sample.txt"), "MIT");
  await writeFile(join(workspaceRoot, "package.json"), JSON.stringify({ packageManager: "pnpm@10.33.2" }));
  await mkdir(join(workspaceRoot, "skills", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "design-templates", "orbit-general"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "design-systems", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "craft", "sample"), { recursive: true });
  await mkdir(join(workspaceRoot, "plugins", "_official", "sample"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "_official", "sample", "open-design.json"),
    "{\"id\":\"sample\"}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "community"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "plugins", "registry", "community", "open-design-marketplace.json"),
    "{\"plugins\":[]}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "assets", "frames"), { recursive: true });
  await mkdir(join(workspaceRoot, "assets", "community-pets", "sample"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "assets", "workbench"), { recursive: true });
  await mkdir(join(workspaceRoot, "prompt-templates", "image"), {
    recursive: true,
  });
  await mkdir(join(workspaceRoot, "data", "plugin-previews"), {
    recursive: true,
  });
  await writeFile(
    join(workspaceRoot, "data", "plugin-previews", "manifest.json"),
    "{\"previews\":{}}\n",
    "utf8",
  );
  await mkdir(join(workspaceRoot, "plugins", "registry", "official"), {
    recursive: true,
  });
}

async function createDshRuntimeFixture(workspaceRoot: string): Promise<void> {
  const packageRoot = join(workspaceRoot, "packages", "dsh-runtime");
  await mkdir(join(packageRoot, "dist", "types"), { recursive: true });
  await writeFile(
    join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: "@open-design/dsh-runtime",
      version: "0.1.0",
      files: ["dist"],
    }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(packageRoot, "dist", "index.js"), "export {};\n", "utf8");
  await writeFile(
    join(packageRoot, "dist", "types", "index.d.ts"),
    "export {};\n",
    "utf8",
  );
}

describe("prepareResourceTree", () => {
  it("invalidates cached legal notices and materializes their updated content", async () => {
    const root = await mkdtemp(join(tmpdir(), "fantay-legal-cache-"));
    try {
      const workspaceRoot = join(root, "workspace"), resourceRoot = join(root, "resources");
      await createWorkspaceFixture(workspaceRoot);
      const cache = new ToolPackCache(join(root, "cache"));
      const config = { workspaceRoot } as ToolPackConfig;
      const paths = { resourceRoot } as WinPaths;
      const first = await prepareResourceTree(config, paths, cache, { materialize: true });
      await writeFile(join(workspaceRoot, "THIRD_PARTY_NOTICES.md"), "Updated notice");
      const second = await prepareResourceTree(config, paths, cache, { materialize: true });
      expect(first.key).not.toBe(second.key);
      expect(await readFile(join(resourceRoot, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe("Updated notice");
      await writeFile(join(workspaceRoot, 'vendor', 'jianying-draft', 'worker.ts'), '/* draft worker v2 */');
      const third = await prepareResourceTree(config, paths, cache, { materialize: true });
      expect(third.key).not.toBe(second.key);
      expect(await readFile(join(resourceRoot, 'vendor', 'jianying-draft', 'worker.ts'), 'utf8')).toContain('v2');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("bundles the DeepSeek Harness runtime into the Windows resource tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-dsh-runtime-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await createDshRuntimeFixture(workspaceRoot);

      await prepareResourceTree(
        config,
        paths,
        cache,
        { bundleAgentRuntimes: true, materialize: true },
        "workspace-build-dsh-v1",
      );

      const runtimeRoot = join(resourceRoot, "agent-runtimes", "deepseek-harness");
      const manifest = JSON.parse(
        await readFile(join(runtimeRoot, "manifest.json"), "utf8"),
      ) as {
        file: string;
        packageName: string;
        schemaVersion: number;
        sha256: string;
        version: string;
      };
      const tarballs = (await readdir(runtimeRoot)).filter((entry) => entry.endsWith(".tgz"));

      expect(manifest).toMatchObject({
        file: tarballs[0],
        packageName: "@open-design/dsh-runtime",
        schemaVersion: 1,
        version: "0.1.0",
      });
      expect(manifest.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(tarballs).toHaveLength(1);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("invalidates the Windows resource tree cache when design templates change", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-resources-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const templatePath = join(
      workspaceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );
    const materializedTemplatePath = join(
      resourceRoot,
      "design-templates",
      "orbit-general",
      "SKILL.md",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(templatePath, "version one\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version one\n",
      );

      await writeFile(templatePath, "version two\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedTemplatePath, "utf8")).resolves.toBe(
        "version two\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("invalidates the Windows resource tree cache when the plugin-preview manifest changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-previews-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const manifestPath = join(
      workspaceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );
    const materializedManifestPath = join(
      resourceRoot,
      "data",
      "plugin-previews",
      "manifest.json",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await writeFile(manifestPath, "{\"previews\":{\"a\":1}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":1}}\n",
      );

      await writeFile(manifestPath, "{\"previews\":{\"a\":2}}\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedManifestPath, "utf8")).resolves.toBe(
        "{\"previews\":{\"a\":2}}\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);

  it("copies a configured pi runtime directory into the Windows resource tree", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-pi-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const source = join(root, "source", "pi.exe");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const originalPiBin = process.env.OPEN_DESIGN_PI_BIN;

    try {
      await createWorkspaceFixture(workspaceRoot);
      await mkdir(join(root, "source"), { recursive: true });
      await writeFile(source, "fake pi exe\n", "utf8");
      await writeFile(join(root, 'source', 'support.dll'), 'runtime library');
      process.env.OPEN_DESIGN_PI_BIN = source;
      stubPiVersion();

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(join(resourceRoot, "bin", "libexec", "pi", "pi.exe"), "utf8")).resolves.toBe(
        "fake pi exe\n",
      );
      await expect(
        readFile(join(resourceRoot, "bin", "libexec", "pi", "support.dll"), "utf8"),
      ).resolves.toBe("runtime library");
    } finally {
      if (originalPiBin == null) delete process.env.OPEN_DESIGN_PI_BIN;
      else process.env.OPEN_DESIGN_PI_BIN = originalPiBin;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("fails strict Windows resource preparation when configured pi is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-pi-strict-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = {
      workspaceRoot,
      requireVelaCli: true,
    } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const originalPiBin = process.env.OPEN_DESIGN_PI_BIN;

    try {
      await createWorkspaceFixture(workspaceRoot);
      process.env.OPEN_DESIGN_PI_BIN = join(root, "missing", "pi.exe");
      await expect(
        prepareResourceTree(config, paths, cache, { materialize: true }),
      ).rejects.toThrow();
    } finally {
      if (originalPiBin == null) delete process.env.OPEN_DESIGN_PI_BIN;
      else process.env.OPEN_DESIGN_PI_BIN = originalPiBin;
      await rm(root, { force: true, recursive: true });
    }
  });

  it("invalidates the Windows resource tree cache when a pi runtime file changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "open-design-win-pi-companion-"));
    const workspaceRoot = join(root, "workspace");
    const resourceRoot = join(root, "materialized", "open-design");
    const source = join(root, "source", "pi.exe");
    const cache = new ToolPackCache(join(root, "cache"));
    const config = { workspaceRoot } as ToolPackConfig;
    const paths = { resourceRoot } as WinPaths;
    const originalPiBin = process.env.OPEN_DESIGN_PI_BIN;
    const materializedCompanion = join(
      resourceRoot,
      "bin",
      "libexec",
      "pi",
      "support.dll",
    );

    try {
      await createWorkspaceFixture(workspaceRoot);
      await mkdir(join(root, "source"), { recursive: true });
      await writeFile(source, "fake pi exe\n", "utf8");
      const sourceCompanion = join(root, 'source', 'support.dll');
      await writeFile(sourceCompanion, 'companion one\n');
      process.env.OPEN_DESIGN_PI_BIN = source;
      stubPiVersion();

      await prepareResourceTree(config, paths, cache, { materialize: true });
      await expect(readFile(materializedCompanion, "utf8")).resolves.toBe(
        "companion one\n",
      );

      await writeFile(sourceCompanion, "companion two\n", "utf8");

      await prepareResourceTree(config, paths, cache, { materialize: true });

      await expect(readFile(materializedCompanion, "utf8")).resolves.toBe(
        "companion two\n",
      );
      expect(cache.report().entries.map((entry) => entry.status)).toEqual([
        "miss",
        "miss",
      ]);
    } finally {
      if (originalPiBin == null) delete process.env.OPEN_DESIGN_PI_BIN;
      else process.env.OPEN_DESIGN_PI_BIN = originalPiBin;
      await rm(root, { force: true, recursive: true });
    }
  }, RESOURCE_TREE_CACHE_TEST_TIMEOUT_MS);
});
