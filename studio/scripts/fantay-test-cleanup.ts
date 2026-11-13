import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type CleanupResult = {
  removed: string[];
  retained: string[];
  skipped: Array<{ path: string; reason: string }>;
};

type CleanupOptions = {
  workspaceRoot: string;
  /** An explicit empty list is reserved for hermetic filesystem tests. */
  busyPaths?: string[] | null;
  sharedBusy?: boolean;
};

function inside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

type OwnershipChecker = (path: string) => Promise<void>;

/** Never follow a symlink, including a symlink in an ancestor of a candidate. */
function createOwnershipChecker(root: string): OwnershipChecker {
  let canonicalRootPromise: Promise<string> | undefined;
  const verifiedPrefixes = new Map<string, boolean>();
  return async (path: string): Promise<void> => {
    if (!inside(root, path)) throw new Error(`Cleanup path is outside its owner: ${path}`);
    const canonicalRoot = await (canonicalRootPromise ??= realpath(root));
    let cursor = root;
    for (const part of relative(root, path).split(sep)) {
      cursor = join(cursor, part);
      if (verifiedPrefixes.get(cursor)) continue;
      let st;
      try { st = await lstat(cursor); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
        throw error;
      }
      if (st.isSymbolicLink()) throw new Error(`Cleanup refuses symlink: ${cursor}`);
      if (!inside(canonicalRoot, await realpath(cursor))) throw new Error(`Cleanup path escaped its owner: ${cursor}`);
      verifiedPrefixes.set(cursor, true);
    }
  };
}

async function isBusy(path: string, busyPaths: string[]): Promise<boolean> {
  const canonical = await realpath(path);
  return busyPaths.some((open) => open === path || inside(path, open)
    || open === canonical || inside(canonical, open));
}

/** Unknown process state means retain data, never assume that it is idle. */
export async function readBusyPaths(): Promise<string[] | null> {
  if (process.platform === 'win32') return null;
  try {
    const { stdout } = await execFileAsync('lsof', ['-nP', '-Fn'], { maxBuffer: 32 * 1024 * 1024 });
    return stdout.split('\n').filter((line) => line.startsWith('n/')).map((line) => line.slice(1));
  } catch { return null; }
}

async function sharedProducerIsRunning(): Promise<boolean> {
  if (process.platform === 'win32') return true;
  try {
    const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command=']);
    return stdout.split('\n').some((line) => {
      const match = /^\s*(\d+)\s+(.*)$/.exec(line);
      if (match == null || Number(match[1]) === process.pid) return false;
      const cmd = match[2] ?? '';
      if (cmd.includes('.app/Contents/')) return false;
      return /(?:fantay-test\.ts\s+run|[\/]vitest(?:\.mjs)?(?:\s|$)|[\/]playwright[\/]|next(?:-server|[\/]dist[\/].*build)|tools-pack.*\bbuild\b|\btsc(?:\.js)?(?:\s|$))/.test(cmd);
    });
  } catch { return true; }
}

async function directories(path: string): Promise<string[]> {
  try {
    const st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink()) return [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
    .map((entry) => join(path, entry.name));
}

async function retainLogs(assertOwned: OwnershipChecker, source: string, destination: string): Promise<void> {
  await assertOwned(destination);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue;
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) {
      if (['next', '.next', 'node_modules', 'data', 'codex-home', 'amr-home', '.git'].includes(entry.name)) continue;
      await retainLogs(assertOwned, from, to);
    } else if (entry.isFile() && /(?:\.log|error-context\.md|trace\.zip|\.(?:png|jpg|jpeg|webp|webm|mp4))$/.test(entry.name)) {
      await assertOwned(to);
      await mkdir(dirname(to), { recursive: true });
      await copyFile(from, to);
    }
  }
}

export async function registerTestScratch(scratch: string): Promise<void> {
  await writeFile(join(scratch, '.test-owner.json'), JSON.stringify({ pid: process.pid }));
}

async function hasLiveOwner(scratch: string): Promise<boolean> {
  const marker = join(scratch, '.test-owner.json');
  if (!(await exists(marker))) return false;
  const owner: unknown = JSON.parse(await readFile(marker, 'utf8'));
  const pid = (owner as { pid?: number }).pid;
  if (!Number.isInteger(pid) || pid == null || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The owner must first stop its runtime. Curated reports live outside scratch. */
export async function cleanupTestScratch(
  options: CleanupOptions & { scratchDir: string; reportDir: string; ownerStopped?: boolean; assertOwned?: OwnershipChecker },
): Promise<CleanupResult> {
  const result: CleanupResult = { removed: [], retained: [], skipped: [] };
  if (!(await exists(options.scratchDir))) return result;
  const root = resolve(options.workspaceRoot);
  const assertOwned = options.assertOwned ?? createOwnershipChecker(root);
  const scratch = resolve(options.scratchDir);
  const report = resolve(options.reportDir);
  try {
    if (!inside(join(root, '.tmp', 'e2e'), scratch) || basename(scratch) !== 'scratch') {
      throw new Error('Not an e2e scratch directory');
    }
    if (inside(scratch, report) || report === scratch) throw new Error('Report overlaps scratch');
    await assertOwned(scratch);
    await assertOwned(report);
    const busy = options.busyPaths === undefined ? await readBusyPaths() : options.busyPaths;
    if (busy == null || await isBusy(scratch, busy) || (!options.ownerStopped && await hasLiveOwner(scratch))) {
      result.skipped.push({ path: scratch, reason: busy == null ? 'Process inspection unavailable' : 'Runtime is still active' });
      return result;
    }
    await mkdir(report, { recursive: true });
    await retainLogs(assertOwned, scratch, join(report, 'runtime-logs'));
    // Write the diagnostic location before deleting the transient data.
    await assertOwned(join(report, 'cleanup.json'));
    await writeFile(join(report, 'cleanup.json'), JSON.stringify({ scratch, runtimeLogs: join(report, 'runtime-logs'), removedAt: new Date().toISOString() }, null, 2));
    await rm(scratch, { recursive: true });
    result.removed.push(scratch);
    result.retained.push(report);
  } catch (error) {
    result.skipped.push({ path: scratch, reason: String(error) });
  }
  return result;
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Keep the newest installer of each platform/format before dropping pack output. */
async function retainInstallers(root: string, output: string, assertOwned: OwnershipChecker): Promise<string[]> {
  const latest = new Map<string, { path: string; mtimeMs: number; suffix: string }>();
  for (const platform of await directories(output)) {
    for (const namespace of await directories(join(platform, 'namespaces'))) {
      for (const folder of ['dmg', 'builder']) {
        const dir = join(namespace, folder);
        if (!(await exists(dir))) continue;
        await assertOwned(dir);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (!entry.isFile() || !/^(?:Fantay|Open[ -]?Design)/i.test(entry.name)) continue;
          const suffix = entry.name.match(/(\.dmg|-setup\.exe|-portable\.zip|\.AppImage)$/i)?.[1];
          if (!suffix) continue;
          const from = join(dir, entry.name);
          const mtimeMs = (await stat(from)).mtimeMs;
          const key = `${basename(platform)}${suffix}`;
          if (mtimeMs > (latest.get(key)?.mtimeMs ?? -1)) latest.set(key, { path: from, mtimeMs, suffix });
        }
      }
    }
  }
  const retained: string[] = [];
  for (const source of latest.values()) {
    const target = join(root, '.tmp', 'desktop', `Fantaydesign${source.suffix}`);
    await assertOwned(target);
    // A newer already-delivered installer wins over an old build directory.
    if (await exists(target) && (await stat(target)).mtimeMs > source.mtimeMs) { retained.push(target); continue; }
    await mkdir(dirname(target), { recursive: true });
    const temp = `${target}.${process.pid}.tmp`;
    await assertOwned(temp);
    try {
      await copyFile(source.path, temp);
      const [tempHash, sourceHash] = await Promise.all([hashFile(temp), hashFile(source.path)]);
      if (tempHash !== sourceHash) throw new Error('Installer copy checksum mismatch');
      await rename(temp, target);
    } finally { await rm(temp, { force: true }); }
    retained.push(target);
  }
  return retained;
}

/** Conservative allowlist: real data, dependencies, reports and delivered builds are excluded. */
export async function cleanupTestArtifacts(options: CleanupOptions): Promise<CleanupResult> {
  const root = resolve(options.workspaceRoot);
  const assertOwned = createOwnershipChecker(root);
  const result: CleanupResult = { removed: [], retained: [], skipped: [] };
  let busyPromise: Promise<string[] | null> | undefined;
  let sharedBusyPromise: Promise<boolean> | undefined;
  const getBusy = () => (busyPromise ??= options.busyPaths !== undefined ? Promise.resolve(options.busyPaths) : readBusyPaths());
  const getSharedBusy = () => (sharedBusyPromise ??= options.sharedBusy !== undefined ? Promise.resolve(options.sharedBusy) : sharedProducerIsRunning());
  async function remove(path: string, before?: () => Promise<void>): Promise<void> {
    if (!(await exists(path))) return;
    try {
      await assertOwned(path);
      const [busy, sharedBusy] = await Promise.all([getBusy(), getSharedBusy()]);
      if (busy == null || await isBusy(path, busy) || sharedBusy) {
        result.skipped.push({ path, reason: 'Active or unverified test/build process' }); return;
      }
      await before?.();
      await rm(path, { recursive: true }); result.removed.push(path);
    } catch (error) { result.skipped.push({ path, reason: String(error) }); }
  }
  async function scratchDirs(parent: string): Promise<void> {
    for (const child of await directories(parent)) {
      await assertOwned(child);
      if (basename(child) === 'scratch') {
        const busy = await getBusy();
        const cleaned = await cleanupTestScratch({ workspaceRoot: root, scratchDir: child, reportDir: join(dirname(child), 'report'), busyPaths: busy, assertOwned });
        result.removed.push(...cleaned.removed); result.retained.push(...cleaned.retained); result.skipped.push(...cleaned.skipped);
      } else if (!['report', 'node_modules', 'data'].includes(basename(child))) await scratchDirs(child);
    }
  }
  await scratchDirs(join(root, '.tmp', 'e2e'));
  for (const namespace of await directories(join(root, '.tmp', 'tools-dev'))) {
    await remove(join(namespace, 'web', 'next'));
  }
  await remove(join(root, 'apps', 'web', '.next', 'cache'));
  await remove(join(root, 'node_modules', '.cache'));
  await remove(join(root, '.tmp', 'tools-pack', 'cache'));
  const packOutput = join(root, '.tmp', 'tools-pack', 'out');
  await remove(packOutput, async () => { result.retained.push(...await retainInstallers(root, packOutput, assertOwned)); });
  return result;
}
