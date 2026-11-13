import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

/**
 * Development acquisition of the pinned official pi runtime for the daemon's
 * TokenToSea/BYOK agents. The pin (version, asset, sha256) is owned by
 * `tools/pack/resources/pi-runtime.json`; this module reads it by path and
 * shares tools-pack's cache layout:
 *
 *   <workspaceRoot>/.tmp/pi-runtime/<version>/<platform>-<arch>/pi/            runtime directory
 *   <workspaceRoot>/.tmp/pi-runtime/<version>/<platform>-<arch>/acquired.json  completion marker
 */
export const FANTAY_PI_BIN_ENV = 'FANTAY_PI_BIN';
const PI_OVERRIDE_ENV = 'OPEN_DESIGN_PI_BIN';
const exec = promisify(execFile);

type PiAsset = { file: string; sha256: string; root: 'pi' | '.'; executable: string };
type PiManifest = { schemaVersion: 1; version: string; releaseBaseUrl: string; assets: Record<string, PiAsset> };
export type DevPiRuntimeDeps = {
  fetch?: typeof fetch;
  runVersion?: (binary: string) => Promise<string>;
  target?: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readManifest(workspaceRoot: string): Promise<PiManifest> {
  const file = path.join(workspaceRoot, 'tools', 'pack', 'resources', 'pi-runtime.json');
  const manifest = JSON.parse(await readFile(file, 'utf8')) as PiManifest;
  if (manifest?.schemaVersion !== 1 || typeof manifest.version !== 'string' || typeof manifest.releaseBaseUrl !== 'string'
    || !manifest.assets || typeof manifest.assets !== 'object') {
    throw new Error(`invalid pi runtime manifest: ${file}`);
  }
  return manifest;
}

async function isFile(file: string): Promise<boolean> {
  return stat(file).then(info => info.isFile(), () => false);
}

async function isAcquired(entry: string, manifest: PiManifest, asset: PiAsset): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(path.join(entry, 'acquired.json'), 'utf8')) as Record<string, unknown>;
    return marker.version === manifest.version && marker.file === asset.file && marker.sha256 === asset.sha256
      && await isFile(path.join(entry, 'pi', asset.executable));
  } catch {
    return false;
  }
}

async function extract(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const zip = archive.endsWith('.zip');
  const tar = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const [command, args] = zip && process.platform === 'linux'
    ? ['unzip', ['-q', '-o', archive, '-d', destination]]
    : [tar, [zip ? '-xf' : '-xzf', archive, '-C', destination]];
  try {
    await exec(command, args, { maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (cause) {
    throw new Error(`failed to extract ${path.basename(archive)}: ${errorMessage(cause)}`, { cause });
  }
}

/** Return the cached pi executable for the host, acquiring it once (sha256 verified before extraction). */
export async function acquireDevPiRuntime(
  workspaceRoot: string,
  deps: DevPiRuntimeDeps = {},
  log?: (message: string) => void,
): Promise<string> {
  const manifest = await readManifest(workspaceRoot);
  const target = deps.target ?? `${process.platform}-${process.arch}`;
  const asset = manifest.assets[target];
  if (!asset) throw new Error(`pi ${manifest.version} has no official standalone build for ${target}`);
  const versionRoot = path.join(workspaceRoot, '.tmp', 'pi-runtime', manifest.version);
  const entry = path.join(versionRoot, target);
  const executable = path.join(entry, 'pi', asset.executable);
  if (await isAcquired(entry, manifest, asset)) return executable;

  const url = `${manifest.releaseBaseUrl}/${asset.file}`;
  const staging = path.join(versionRoot, `.staging-${target}-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    log?.(`[tools-dev] downloading pi ${manifest.version} (${target}) from ${url}`);
    let response: Response;
    try {
      response = await (deps.fetch ?? fetch)(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
    } catch (cause) {
      throw new Error(`pi download failed for ${url}: ${errorMessage(cause)}`, { cause });
    }
    if (!response.ok) throw new Error(`pi download failed for ${url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== asset.sha256) throw new Error(`pi archive ${asset.file} failed sha256 verification: expected ${asset.sha256}, got ${actual}`);
    const archive = path.join(staging, asset.file);
    await writeFile(`${archive}.part`, bytes, { flag: 'wx' });
    await rename(`${archive}.part`, archive);
    await extract(archive, asset.root === 'pi' ? staging : path.join(staging, 'pi'));
    await rm(archive, { force: true });
    const entries = await readdir(staging);
    const staged = path.join(staging, 'pi', asset.executable);
    if (entries.length !== 1 || entries[0] !== 'pi' || !(await isFile(staged))) {
      throw new Error(`pi archive ${asset.file} has an unexpected layout: ${entries.join(', ')}`);
    }
    if (process.platform !== 'win32') await chmod(staged, 0o755);
    const reported = (await (deps.runVersion ?? (async binary => (await exec(binary, ['--version'], { timeout: 30_000, windowsHide: true })).stdout))(staged)).trim();
    if (reported !== manifest.version) throw new Error(`pi --version printed ${JSON.stringify(reported)}, expected ${manifest.version}`);
    await writeFile(path.join(staging, 'acquired.json'), `${JSON.stringify({
      schemaVersion: 1, version: manifest.version, target, file: asset.file, sha256: asset.sha256, url,
    }, null, 2)}\n`);
    if (await isAcquired(entry, manifest, asset)) return executable;
    await rm(entry, { recursive: true, force: true });
    try {
      await rename(staging, entry);
    } catch (error) {
      if (!(await isAcquired(entry, manifest, asset))) throw error;
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Env additions for the dev daemon: `FANTAY_PI_BIN` pointing at the pinned pi.
 * A user-exported `FANTAY_PI_BIN` is inherited unchanged; `OPEN_DESIGN_PI_BIN`
 * selects a local runtime; otherwise the pinned release is acquired and cached.
 */
export async function resolveDevPiEnv(
  workspaceRoot: string,
  env: NodeJS.ProcessEnv = process.env,
  log?: (message: string) => void,
  deps: DevPiRuntimeDeps = {},
): Promise<Record<string, string>> {
  if (env[FANTAY_PI_BIN_ENV]?.trim()) return {};
  const override = env[PI_OVERRIDE_ENV]?.trim();
  if (override) return { [FANTAY_PI_BIN_ENV]: path.resolve(override) };
  try {
    const binary = await acquireDevPiRuntime(workspaceRoot, deps, log);
    return { [FANTAY_PI_BIN_ENV]: binary };
  } catch (error) {
    log?.(`[tools-dev] pinned pi runtime is unavailable (${errorMessage(error)}); TokenToSea/BYOK agents need ${FANTAY_PI_BIN_ENV}`);
    return {};
  }
}
