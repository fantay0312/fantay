import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ToolPackConfig } from "@/config/index.js";
import { resolveMacInstallIdentity } from "@/mac/identity.js";
import { resolveMacPaths } from "@/mac/paths.js";

function makeConfig(root: string, namespace: string): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "/x/electron-builder/cli.js",
    electronDistPath: "/x/electron/dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace,
    platform: "mac",
    portable: true,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      output: {
        appBuilderRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace, "builder"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "out", "mac", "namespaces", namespace),
        platformRoot: join(root, ".tmp", "tools-pack", "out", "mac"),
        root: join(root, ".tmp", "tools-pack", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces"),
        namespaceRoot: join(root, ".tmp", "tools-pack", "runtime", "mac", "namespaces", namespace),
      },
      cacheRoot: join(root, ".tmp", "tools-pack", "cache"),
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dmg",
    webOutputMode: "standalone",
    workspaceRoot: root,
  };
}

describe("resolveMacInstallIdentity", () => {
  it("keeps stable builds on the canonical mac identity", () => {
    expect(resolveMacInstallIdentity(makeConfig("/work", "release-stable"))).toMatchObject({
      appId: "design.fantay.desktop",
      displayName: "Fantay",
      executableName: "Fantay",
      installerTitle: "Fantay",
      productName: "Fantay",
      publicAppBundleName: "Fantay.app",
      runtimeProductName: "Fantaydesign",
      systemAppBundleName: "Fantay.app",
    });
  });

  it("keeps local install paths isolated by namespace", () => {
    expect(resolveMacInstallIdentity(makeConfig("/work", "a b/c"))).toMatchObject({
      appId: "design.fantay.desktop",
      displayName: "Fantay",
      publicAppBundleName: "Fantay.app",
      runtimeProductName: "Fantaydesign",
      systemAppBundleName: "Fantay.a-b-c.app",
    });
  });

  it("uses first-class beta app identity for beta release namespaces", () => {
    const config = makeConfig("/work", "release-beta");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "design.fantay.desktop.beta",
      executableName: "Fantay Beta",
      displayName: "Fantay Beta",
      installerTitle: "Fantay Beta",
      productName: "Fantay Beta",
      publicAppBundleName: "Fantay Beta.app",
      runtimeProductName: "Fantaydesign Beta",
      systemAppBundleName: "Fantay Beta.app",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/Fantay Beta\.app$/);
  });

  it("uses first-class preview app identity for preview release namespaces", () => {
    const config = makeConfig("/work", "release-preview");

    expect(resolveMacInstallIdentity(config)).toEqual({
      appId: "design.fantay.desktop.preview",
      executableName: "Fantay Preview",
      displayName: "Fantay Preview",
      installerTitle: "Fantay Preview",
      productName: "Fantay Preview",
      publicAppBundleName: "Fantay Preview.app",
      runtimeProductName: "Fantaydesign Preview",
      systemAppBundleName: "Fantay Preview.app",
    });
    expect(resolveMacPaths(config).appPath).toMatch(/Fantay Preview\.app$/);
  });

  it("uses first-class prerelease app identity for prerelease release versions and namespaces", () => {
    const prereleaseVersionConfig = {
      ...makeConfig("/work", "release-stable"),
      appVersion: "0.8.0-prerelease.2",
    };
    const prereleaseNamespaceConfig = makeConfig("/work", "release-prerelease");

    expect(resolveMacInstallIdentity(prereleaseVersionConfig)).toEqual({
      appId: "design.fantay.desktop.prerelease",
      executableName: "Fantay Prerelease",
      displayName: "Fantay Prerelease",
      installerTitle: "Fantay Prerelease",
      productName: "Fantay Prerelease",
      publicAppBundleName: "Fantay Prerelease.app",
      runtimeProductName: "Fantaydesign Prerelease",
      systemAppBundleName: "Fantay Prerelease.app",
    });
    expect(resolveMacPaths(prereleaseVersionConfig).appPath).toMatch(/Fantay Prerelease\.app$/);
    expect(resolveMacInstallIdentity(prereleaseNamespaceConfig)).toMatchObject({
      productName: "Fantay Prerelease",
      publicAppBundleName: "Fantay Prerelease.app",
    });
  });
});
