import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ToolPackCache } from "@/cache/index.js";
import type { ToolPackConfig } from "@/config/index.js";
import { collectWorkspaceTarballs as collectLinuxWorkspaceTarballs, INTERNAL_PACKAGES as LINUX_INTERNAL_PACKAGES } from "@/linux.js";
import { collectWorkspaceTarballs as collectMacWorkspaceTarballs } from "@/mac/app.js";
import { INTERNAL_PACKAGES as MAC_INTERNAL_PACKAGES } from "@/mac/constants.js";
import { resolveMacPaths } from "@/mac/paths.js";
import { collectWorkspaceTarballs as collectWinWorkspaceTarballs } from "@/win/app.js";
import { INTERNAL_PACKAGES as WIN_INTERNAL_PACKAGES } from "@/win/constants.js";
import { resolveWinPaths } from "@/win/paths.js";

// A stand-in for npm's CLI, reached through `npm_execpath` exactly as a real
// `npm run tools-pack …` would. Like npm, it treats `-C` as `--prefix` and packs
// the package in its working directory, so any caller that relies on `-C` to
// select the package packs the workspace root instead.
const FAKE_NPM_CLI = `
const { appendFileSync, readFileSync, writeFileSync } = require("node:fs");
const { join, resolve } = require("node:path");
const argv = process.argv.slice(2);
appendFileSync(process.env.FAKE_PM_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const rest = [];
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "-C" || argv[index] === "--prefix") { index += 1; continue; }
  rest.push(argv[index]);
}
if (rest[0] !== "pack") process.exit(2);
const destination = resolve(process.cwd(), rest[rest.indexOf("--pack-destination") + 1]);
const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
writeFileSync(join(destination, manifest.name.replace(/^@/, "").replace(/\\//g, "-") + "-" + manifest.version + ".tgz"), "");
`;

type PackLogEntry = { argv: string[]; cwd: string };

function tarballName(packageName: string): string {
  return `${packageName.replace(/^@/, "").replace(/\//g, "-")}-0.0.0.tgz`;
}

function createConfig(root: string, platform: ToolPackConfig["platform"]): ToolPackConfig {
  return {
    containerized: false,
    electronBuilderCliPath: "electron-builder",
    electronDistPath: "electron-dist",
    electronVersion: "41.3.0",
    macCompression: "normal",
    namespace: "test",
    platform,
    portable: false,
    removeData: false,
    removeLogs: false,
    removeProductUserData: false,
    removeSidecars: false,
    requireVelaCli: false,
    roots: {
      cacheRoot: join(root, ".cache"),
      output: {
        appBuilderRoot: join(root, ".tmp", "builder"),
        namespaceRoot: join(root, ".tmp", "out", platform, "namespaces", "test"),
        platformRoot: join(root, ".tmp", "out", platform),
        root: join(root, ".tmp", "out"),
      },
      runtime: {
        namespaceBaseRoot: join(root, ".tmp", "runtime", platform, "namespaces"),
        namespaceRoot: join(root, ".tmp", "runtime", platform, "namespaces", "test"),
      },
      toolPackRoot: join(root, ".tmp", "tools-pack"),
    },
    signed: false,
    silent: true,
    to: "dir",
    webOutputMode: "server",
    workspaceRoot: root,
  };
}

async function writeWorkspace(
  root: string,
  packages: readonly { directory: string; name: string }[],
): Promise<void> {
  // The root manifest is what npm would pack if `-C` were taken as `--prefix`.
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "workspace-root", packageManager: "pnpm@10.33.2", version: "0.0.0" }, null, 2)}\n`,
    "utf8",
  );
  await writeFile(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  for (const packageInfo of packages) {
    await mkdir(join(root, packageInfo.directory, "src"), { recursive: true });
    await writeFile(
      join(root, packageInfo.directory, "package.json"),
      `${JSON.stringify({ name: packageInfo.name, version: "0.0.0" }, null, 2)}\n`,
      "utf8",
    );
    await writeFile(join(root, packageInfo.directory, "src", "index.ts"), "export const value = 1;\n", "utf8");
  }
}

async function readPackLog(logPath: string): Promise<PackLogEntry[]> {
  const text = await readFile(logPath, "utf8");
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PackLogEntry);
}

async function expectEveryPackRanInsideItsPackage(
  root: string,
  logPath: string,
  packages: readonly { directory: string }[],
): Promise<void> {
  const log = await readPackLog(logPath);
  expect(log.map((entry) => entry.argv.includes("-C"))).toEqual(packages.map(() => false));
  expect(log.map((entry) => entry.cwd)).toEqual(
    await Promise.all(packages.map(async (packageInfo) => await realpath(join(root, packageInfo.directory)))),
  );
}

describe("workspace tarball packing under an npm-launched tools-pack", () => {
  let root: string;
  let logPath: string;

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "open-design-pack-tarballs-")));
    const fakeNpmCli = join(root, ".fake-pm", "npm-cli.cjs");
    logPath = join(root, ".fake-pm", "invocations.jsonl");
    await mkdir(join(root, ".fake-pm"), { recursive: true });
    await writeFile(fakeNpmCli, FAKE_NPM_CLI, "utf8");
    await writeFile(logPath, "", "utf8");
    vi.stubEnv("npm_execpath", fakeNpmCli);
    vi.stubEnv("FAKE_PM_LOG", logPath);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { force: true, recursive: true });
  });

  it("linux packs every internal package from its own directory", async () => {
    await writeWorkspace(root, LINUX_INTERNAL_PACKAGES);
    const tarballsRoot = join(root, ".tmp", "out", "linux", "tarballs");

    const packed = await collectLinuxWorkspaceTarballs(createConfig(root, "linux"), { tarballsRoot });

    expect(packed).toEqual(
      LINUX_INTERNAL_PACKAGES.map((packageInfo) => ({
        fileName: tarballName(packageInfo.name),
        packageName: packageInfo.name,
      })),
    );
    await expectEveryPackRanInsideItsPackage(root, logPath, LINUX_INTERNAL_PACKAGES);
  });

  it("mac packs every internal package from its own directory", async () => {
    await writeWorkspace(root, MAC_INTERNAL_PACKAGES);
    const config = createConfig(root, "mac");

    const packed = await collectMacWorkspaceTarballs(config, resolveMacPaths(config));

    expect(packed).toEqual(
      MAC_INTERNAL_PACKAGES.map((packageInfo) => ({
        fileName: tarballName(packageInfo.name),
        packageName: packageInfo.name,
      })),
    );
    await expectEveryPackRanInsideItsPackage(root, logPath, MAC_INTERNAL_PACKAGES);
  });

  it("win packs every internal package from its own directory", async () => {
    await writeWorkspace(root, WIN_INTERNAL_PACKAGES);
    const config = createConfig(root, "win");

    const result = await collectWinWorkspaceTarballs(
      config,
      resolveWinPaths(config),
      new ToolPackCache(join(root, ".cache")),
      "workspace-build",
    );

    expect(result.tarballs).toEqual(
      WIN_INTERNAL_PACKAGES.map((packageInfo) => ({
        fileName: tarballName(packageInfo.name),
        packageName: packageInfo.name,
      })),
    );
    await expectEveryPackRanInsideItsPackage(root, logPath, WIN_INTERNAL_PACKAGES);
  });
});
