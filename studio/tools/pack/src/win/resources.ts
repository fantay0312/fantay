import { cp, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { hashJson, hashPath, ToolPackCache } from "../cache/index.js";
import type { ToolPackConfig } from "../config/index.js";
import { BUNDLED_LEGAL_FILES, BUNDLED_RESOURCE_TREES, copyBundledResourceTrees, packBundledDshRuntime, winResources } from "../resources/index.js";
import { copyStandalonePi, PI_VERSION, piRuntimeAsset, piTarget, resolveStandalonePi } from "../resources/pi.js";
import type { WinPaths, ResourceTreeCacheMetadata } from "./types.js";

const RESOURCE_TREE_CACHE_SCHEMA_VERSION = 11;

async function createResourceTreeCacheKey(config: ToolPackConfig, workspaceBuildKey: string, piBin: string | null): Promise<string> {
  return hashJson({
    bundledResourceTrees: await Promise.all(BUNDLED_RESOURCE_TREES.map(async entry => [entry.from, entry.to, await hashPath(join(config.workspaceRoot, entry.from))])),
    node: "win.resource-tree",
    legalNotices: await Promise.all(BUNDLED_LEGAL_FILES.map(async name => [name, await hashPath(join(config.workspaceRoot, name))])),
    schemaVersion: RESOURCE_TREE_CACHE_SCHEMA_VERSION,
    sevenZipDll: await hashPath(winResources.sevenZipDll),
    sevenZipExe: await hashPath(winResources.sevenZipExe),
    requireVelaCli: config.requireVelaCli,
    piVersion: PI_VERSION,
    piArchiveSha256: piRuntimeAsset(piTarget("win")).sha256,
    piTree: piBin ? await hashPath(dirname(piBin)) : null,
    workspaceBuildKey,
  });
}

export type ResourceTreeResult = {
  key: string;
  resourceRoot: string;
};

export async function prepareResourceTree(
  config: ToolPackConfig,
  paths: WinPaths,
  cache: ToolPackCache,
  options: { bundleAgentRuntimes?: boolean; materialize: boolean },
  workspaceBuildKey = "workspace-build-not-provided",
): Promise<ResourceTreeResult> {
  const piBin = await resolveStandalonePi({
    platform: "win",
    requireBundled: config.requireVelaCli,
    workspaceRoot: config.workspaceRoot,
  });
  const key = await createResourceTreeCacheKey(config, workspaceBuildKey, piBin);
  const node = {
    id: "win.resource-tree",
    key,
    outputs: ["open-design"],
    invalidate: async () => null,
    build: async ({ entryRoot }: { entryRoot: string }): Promise<ResourceTreeCacheMetadata> => {
      const resourceRoot = join(entryRoot, "open-design");
      await mkdir(resourceRoot, { recursive: true });
      await copyBundledResourceTrees({
        workspaceRoot: config.workspaceRoot,
        resourceRoot,
      });
      if (options.bundleAgentRuntimes === true) {
        await packBundledDshRuntime({
          workspaceRoot: config.workspaceRoot,
          resourceRoot,
        });
      }
      await mkdir(join(resourceRoot, "bin"), { recursive: true });
      await cp(winResources.sevenZipExe, join(resourceRoot, "bin", "7z.exe"));
      await cp(winResources.sevenZipDll, join(resourceRoot, "bin", "7z.dll"));
      await copyStandalonePi({
        platform: "win",
        resourceRoot,
        source: piBin,
        workspaceRoot: config.workspaceRoot,
      });
      return { resourceName: "open-design" };
    },
  };
  const manifest = await cache.acquire({
    materialize: options.materialize ? [{ from: "open-design", to: paths.resourceRoot }] : [],
    node,
  });
  return {
    key,
    resourceRoot: options.materialize ? paths.resourceRoot : join(manifest.entryPath, "open-design"),
  };
}

export async function copyWinIcon(paths: WinPaths): Promise<void> {
  await mkdir(dirname(paths.winIconPath), { recursive: true });
  await cp(winResources.icon, paths.winIconPath);
}
