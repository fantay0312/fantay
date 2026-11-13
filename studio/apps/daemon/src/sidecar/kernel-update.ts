import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, readFile, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import Database from "better-sqlite3";

import { compareLauncherVersions } from "@open-design/launcher-proto";
import { handoffCurrentSidecarGeneration } from "@open-design/sidecar";
import { isPackagedKernelVersion, PACKAGED_KERNEL as KERNEL, type DaemonStatusSnapshot } from "@open-design/sidecar-proto";

const execFileAsync = promisify(execFile);
type Candidate = { directory: string; version: string; release: string | null };

/** Hold an OS-backed writer lock across startup, work, and final shutdown. */
export function lockKernelDataRoot(dataRoot: string): Database.Database {
  const lock = new Database(join(dataRoot, ".kernel-writer.sqlite"), { timeout: 0 });
  try {
    lock.exec("BEGIN EXCLUSIVE");
    return lock;
  } catch (error) {
    lock.close();
    throw new Error("Another Fantay kernel is using this data directory", { cause: error });
  }
}

async function readCandidate(root: string, version: string): Promise<Candidate> {
  const directory = join(root, KERNEL.versions, version);
  const manifest = JSON.parse(await readFile(join(directory, KERNEL.manifestFile), "utf8")) as {
    version?: unknown; release?: unknown; protocol?: unknown;
  };
  if (manifest.version !== version || manifest.protocol !== 1 || (manifest.release !== null && typeof manifest.release !== "string")) {
    throw new Error("Incompatible Fantay kernel manifest");
  }
  return { directory, version, release: manifest.release };
}

export async function startKernelUpdates(options: {
  acquire: () => (() => void) | null;
  exit: () => Promise<void>;
}) {
  const root = process.env[KERNEL.rootEnv];
  const version = process.env[KERNEL.versionEnv];
  if (root == null && version == null) return null;
  if (root == null || !isAbsolute(root) || !isPackagedKernelVersion(version)) throw new Error("Invalid Fantay kernel launch context");
  const active = await readCandidate(root, version);
  const activeFile = join(root, KERNEL.activeFile);
  const temporary = `${activeFile}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify({ version }), { mode: 0o600 });
    await rename(temporary, activeFile);
  } finally {
    await rm(temporary, { force: true });
  }

  let pending: Candidate | null = null;
  let switching = false;
  let closed = false;
  let updateError: string | null = null;
  const timer = setInterval(() => {
    if (pending == null || switching || closed) return;
    let release: (() => void) | null;
    try {
      release = options.acquire();
    } catch (error) {
      pending = null;
      updateError = "Fantay could not check active background work";
      console.error("[kernel] update drain check failed", error);
      return;
    }
    if (release == null) return;
    switching = true;
    const candidate = pending;
    const command = join(candidate.directory, KERNEL.node);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      [KERNEL.versionEnv]: candidate.version,
      OD_APP_VERSION: candidate.release ?? process.env.OD_APP_VERSION,
      OD_DAEMON_CLI_PATH: join(candidate.directory, KERNEL.cli),
      OD_DAEMON_PROCESS_INSTANCE_ID: randomUUID(),
      OD_NODE_BIN: command,
      OD_RESOURCE_ROOT: join(candidate.directory, KERNEL.resources),
    };
    void handoffCurrentSidecarGeneration({ args: [join(candidate.directory, KERNEL.entry)], command, env })
      .then(options.exit)
      .catch((error: unknown) => {
        pending = null;
        switching = false;
        updateError = "Fantay could not activate the staged kernel";
        console.error("[kernel] activation failed", error);
        release();
      });
  }, 1_000);
  timer.unref();

  return {
    close() { closed = true; clearInterval(timer); },
    status(): NonNullable<DaemonStatusSnapshot["kernel"]> {
      return { version, release: active.release, pendingVersion: pending?.version ?? null, updateError };
    },
    async stage(input: unknown) {
      const { version: proposed, release } = (input ?? {}) as { version?: unknown; release?: unknown };
      if (!isPackagedKernelVersion(proposed)) throw new Error("Invalid Fantay kernel candidate");
      if (closed || switching) throw new Error("Fantay kernel switch is already in progress");
      if (proposed === version || pending?.version === proposed) return { accepted: true };
      const candidate = await readCandidate(root, proposed);
      if (candidate.release == null || active.release == null || release !== candidate.release
        || compareLauncherVersions(candidate.release, active.release) <= 0) return { accepted: false };
      await Promise.all([KERNEL.cli, KERNEL.entry, KERNEL.supervisor].map((path) => access(join(candidate.directory, path))));
      // Validate the actual installed Node/binding pair before closing admission.
      await execFileAsync(join(candidate.directory, KERNEL.node), [
        "-e", 'new (require(process.argv[1]))(":memory:").close()',
        join(candidate.directory, "app/node_modules/better-sqlite3"),
      ], { timeout: 4_000 });
      if (closed || switching) throw new Error("Fantay kernel switch is already in progress");
      if (pending?.release != null && compareLauncherVersions(candidate.release, pending.release) <= 0) return { accepted: false };
      pending = candidate;
      updateError = null;
      return { accepted: true };
    },
  };
}
