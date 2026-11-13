import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, copyFile, cp, lstat, mkdir, mkdtemp, open, readdir, readFile, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { allocatePort, describeSidecarGeneration, findSidecarProcesses, getSidecarStatus, invokeSidecar, launchSidecar, type SidecarStamp } from "@open-design/sidecar";
import { APP_KEYS, PACKAGED_KERNEL as KERNEL, SIDECAR_MESSAGES, SIDECAR_MODES, SIDECAR_SOURCES, isPackagedKernelVersion, type DaemonStatusSnapshot } from "@open-design/sidecar-proto";
import type { PackagedNamespacePaths } from "./paths.js";

const SQLITE_BINDING = "app/node_modules/better-sqlite3/build/Release/better_sqlite3.node";
const BUNDLE_DIGEST_FILE = "bundle-digest.json";
const START_TIMEOUT = 90_000;
const DESKTOP_ONLY_PACKAGES = new Set([
  "app/node_modules/@open-design/components",
  "app/node_modules/@open-design/host",
  "app/node_modules/@fantay/tokens",
]);

function belongsToKernel(name: string): boolean {
  return name !== SQLITE_BINDING && !DESKTOP_ONLY_PACKAGES.has(name) && !name.endsWith("/.DS_Store");
}

export function macKernelStamp(stamp: SidecarStamp): SidecarStamp {
  return { ...stamp, app: APP_KEYS.DAEMON, mode: SIDECAR_MODES.RUNTIME, source: SIDECAR_SOURCES.PACKAGED };
}

async function exists(path: string): Promise<boolean> {
  return await access(path).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return false;
  });
}

async function hashMetaTree(hash: ReturnType<typeof createHash>, path: string, name: string, boundary: string): Promise<void> {
  if (!belongsToKernel(name)) return;
  const stat = await lstat(path);
  if (stat.isDirectory()) {
    hash.update(JSON.stringify([name, stat.mode & 0o777, "dir"]));
    for (const item of (await readdir(path)).sort()) await hashMetaTree(hash, join(path, item), `${name}/${item}`, boundary);
  } else if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    const child = relative(boundary, resolve(dirname(path), target));
    if (target.startsWith("/") || child === ".." || child.startsWith("../")) throw new Error(`Kernel dependency symlink escapes its bundle: ${name}`);
    hash.update(JSON.stringify([name, stat.mode & 0o777, "link", target]));
  } else if (stat.isFile()) {
    hash.update(JSON.stringify([name, stat.mode & 0o777, "file", stat.size, stat.mtimeMs, stat.ctimeMs]));
  } else {
    throw new Error(`Unsupported kernel dependency: ${name}`);
  }
}

async function hashTree(hash: ReturnType<typeof createHash>, path: string, name: string, boundary: string): Promise<void> {
  if (!belongsToKernel(name)) return;
  const stat = await lstat(path);
  hash.update(JSON.stringify([name, stat.mode & 0o777, stat.isDirectory() ? "dir" : stat.isSymbolicLink() ? "link" : stat.size]));
  if (stat.isDirectory()) {
    for (const item of (await readdir(path)).sort()) await hashTree(hash, join(path, item), `${name}/${item}`, boundary);
  } else if (stat.isSymbolicLink()) {
    const target = await readlink(path);
    const child = relative(boundary, resolve(dirname(path), target));
    if (target.startsWith("/") || child === ".." || child.startsWith("../")) throw new Error(`Kernel dependency symlink escapes its bundle: ${name}`);
    hash.update(JSON.stringify(target));
  } else if (stat.isFile()) {
    for await (const chunk of createReadStream(path)) hash.update(chunk);
  } else {
    throw new Error(`Unsupported kernel dependency: ${name}`);
  }
}

async function writeBundleDigest(root: string, digestPath: string, metaDigest: string, version: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const temp = `${digestPath}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ metaDigest, version }), { mode: 0o600 });
  await rename(temp, digestPath).catch(async () => {
    await rm(temp, { force: true });
  });
}

export async function stageKernel(root: string, resources: string, release: string | null): Promise<string> {
  const sources = [
    [KERNEL.node, join(resources, "fantay-kernel", "node")],
    ["app/prebundled/daemon", join(resources, "app", "prebundled", "daemon")],
    ["app/node_modules", join(resources, "app", "node_modules")],
    [KERNEL.resources, join(resources, KERNEL.resources)],
  ] as const;
  const sqlite = join(resources, "fantay-kernel", "better_sqlite3.node");
  const metaHash = createHash("sha256").update("fantay-mac-kernel-meta-v1\0");
  for (const [name, path] of sources) await hashMetaTree(metaHash, path, name, path);
  await hashMetaTree(metaHash, sqlite, "node-sqlite-binding", sqlite);
  const metaDigest = metaHash.digest("hex");
  const digestPath = join(root, BUNDLE_DIGEST_FILE);
  const versions = join(root, KERNEL.versions);
  const cached = await readFile(digestPath, "utf8")
    .then((raw) => JSON.parse(raw) as { metaDigest?: unknown; version?: unknown })
    .catch(() => null);
  if (
    cached?.metaDigest === metaDigest &&
    isPackagedKernelVersion(cached.version) &&
    await exists(join(versions, cached.version, KERNEL.manifestFile))
  ) {
    return cached.version;
  }

  const hash = createHash("sha256").update("fantay-mac-kernel-v1\0");
  for (const [name, path] of sources) await hashTree(hash, path, name, path);
  await hashTree(hash, sqlite, "node-sqlite-binding", sqlite);
  const version = hash.digest("hex");
  const destination = join(versions, version);
  if (await exists(join(destination, KERNEL.manifestFile))) {
    await writeBundleDigest(root, digestPath, metaDigest, version);
    return version;
  }

  await mkdir(versions, { recursive: true, mode: 0o700 });
  const stage = await mkdtemp(join(versions, ".incoming-"));
  try {
    for (const [name, path] of sources) {
      const target = join(stage, name);
      await mkdir(dirname(target), { recursive: true });
      await cp(path, target, { recursive: true, verbatimSymlinks: true, filter: (_src, dest) => belongsToKernel(relative(stage, dest)) });
    }
    await copyFile(sqlite, join(stage, SQLITE_BINDING));
    await Promise.all([KERNEL.node, KERNEL.entry, KERNEL.cli, KERNEL.supervisor].map((name) => access(join(stage, name))));
    await writeFile(join(stage, KERNEL.manifestFile), JSON.stringify({ version, release, protocol: 1 }), { mode: 0o600 });
    if (await exists(destination) && !await exists(join(destination, KERNEL.manifestFile))) {
      await rm(destination, { recursive: true, force: true });
    }
    await rename(stage, destination).catch(async (error: unknown) => {
      if (!await exists(join(destination, KERNEL.manifestFile))) throw error;
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
  await writeBundleDigest(root, digestPath, metaDigest, version);
  return version;
}

async function readActiveVersion(root: string): Promise<string | null> {
  const path = join(root, KERNEL.activeFile);
  if (!await exists(path)) return null;
  const { version } = JSON.parse(await readFile(path, "utf8")) as { version?: unknown };
  if (!isPackagedKernelVersion(version)) throw new Error("Invalid active Fantay kernel version");
  return version;
}

async function waitForKernel(stamp: SidecarStamp, paths: PackagedNamespacePaths): Promise<DaemonStatusSnapshot> {
  const deadline = Date.now() + START_TIMEOUT;
  do {
    const description = await describeSidecarGeneration(stamp, 500);
    if (description != null) {
      if (description.resources.dataRoot !== paths.dataRoot || description.resources.runtimeRoot !== paths.runtimeRoot) {
        throw new Error("Fantay kernel is serving another installation in this namespace");
      }
      if (description.resources.ownerPid != null) throw new Error("Quit the previous Fantay desktop before starting its independent kernel");
      if (description.ready) {
        const status = await getSidecarStatus<DaemonStatusSnapshot>(stamp, { generationPid: description.resources.pid, timeoutMs: 500 }).catch(() => null);
        if (status?.state === "running" && status.url != null && status.kernel != null) return status;
      }
    }
    if ((await findSidecarProcesses(stamp)).length === 0) break;
    await sleep(150);
  } while (Date.now() < deadline);
  throw new Error("Fantay kernel failed to become ready. See the daemon log in this installation.");
}

export async function connectMacKernel(options: {
  paths: PackagedNamespacePaths;
  desktopStamp: SidecarStamp;
  release: string | null;
  environment(): NodeJS.ProcessEnv;
}): Promise<{ stamp: SidecarStamp; status: DaemonStatusSnapshot; stageUpdate(): Promise<void> } | null> {
  const { paths } = options;
  const resources = dirname(paths.resourceRoot);
  if (process.platform !== "darwin" || !await exists(join(resources, "fantay-kernel", "node"))) return null;
  const root = join(paths.namespaceRoot, "kernel");
  const stamp = macKernelStamp(options.desktopStamp);
  const shipped = await stageKernel(root, resources, options.release);
  const description = await describeSidecarGeneration(stamp, 500);
  if (description == null && (await findSidecarProcesses(stamp)).length === 0) {
    // The same namespace can have been launched by tools-pack or in headless
    // mode before migration. Give the old owner time to release the data root.
    for (const source of [SIDECAR_SOURCES.TOOLS_PACK, SIDECAR_SOURCES.PACKAGED]) {
      for (const mode of [SIDECAR_MODES.RUNTIME, "headless"] as const) {
        if (source === stamp.source && mode === stamp.mode) continue;
        const legacy = { ...stamp, source, mode };
        if ((await findSidecarProcesses(legacy)).length > 0) {
          throw new Error("The previous Fantay backend is still running. Quit the previous desktop before migrating.");
        }
      }
    }
    const version = await readActiveVersion(root) ?? shipped;
    const directory = join(root, KERNEL.versions, version);
    const { port } = await allocatePort({ label: "Fantay kernel" });
    const command = join(directory, KERNEL.node);
    await mkdir(join(paths.logsRoot, APP_KEYS.DAEMON), { recursive: true });
    const logfile = await open(join(paths.logsRoot, APP_KEYS.DAEMON, "latest.log"), "a", 0o600);
    try {
      await launchSidecar({
        args: [join(directory, KERNEL.entry)],
        command,
        cwd: paths.runtimeRoot,
        env: {
          ...options.environment(),
          [KERNEL.rootEnv]: root,
          [KERNEL.versionEnv]: version,
          OD_DAEMON_CLI_PATH: join(directory, KERNEL.cli),
          OD_DAEMON_PROCESS_INSTANCE_ID: randomUUID(),
          OD_NODE_BIN: command,
          OD_PORT: String(port),
          OD_REQUIRE_DESKTOP_AUTH: "1",
          OD_RESOURCE_ROOT: join(directory, KERNEL.resources),
        },
        logFd: logfile.fd,
        resources: { dataRoot: paths.dataRoot, ownerPid: null, port, runtimeRoot: paths.runtimeRoot },
        stamp,
        supervisor: { command, entry: join(directory, KERNEL.supervisor) },
      });
    } finally {
      await logfile.close();
    }
  }
  const status = await waitForKernel(stamp, paths);
  return {
    stamp,
    status,
    async stageUpdate() {
      if (shipped === status.kernel?.version || shipped === status.kernel?.pendingVersion) return;
      await invokeSidecar(stamp, SIDECAR_MESSAGES.STAGE_KERNEL_UPDATE, { version: shipped, release: options.release }, { timeoutMs: 5_000 });
    },
  };
}
