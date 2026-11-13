import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { chmod, cp, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { resourcesRoot } from './index.js';

/**
 * The pinned official pi standalone runtime (TokenToSea/BYOK agent engine).
 *
 * `tools/pack/resources/pi-runtime.json` is the single source of truth for the
 * version and per-platform release asset + sha256. tools-dev reads the same
 * file by path and shares the cache layout below:
 *
 *   <workspaceRoot>/.tmp/pi-runtime/<version>/<platform>-<arch>/pi/            runtime directory
 *   <workspaceRoot>/.tmp/pi-runtime/<version>/<platform>-<arch>/acquired.json  completion marker
 *
 * Packaged apps carry the whole runtime directory at `<resourceRoot>/bin/libexec/pi/`.
 */
export const PI_BIN_ENV = 'OPEN_DESIGN_PI_BIN';
export const PI_RUNTIME_MANIFEST_PATH = join(resourcesRoot, 'pi-runtime.json');
const DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
const exec = promisify(execFile);

export type PiRuntimeAsset = { file: string; sha256: string; root: 'pi' | '.'; executable: 'pi' | 'pi.exe' };
export type PiRuntimeManifest = { schemaVersion: 1; version: string; releaseBaseUrl: string; assets: Record<string, PiRuntimeAsset> };
type PackPlatform = 'mac' | 'win' | 'linux';

export function parsePiRuntimeManifest(value: unknown): PiRuntimeManifest {
  const record = value as Partial<PiRuntimeManifest> | null;
  if (!record || record.schemaVersion !== 1) throw new Error('pi runtime manifest: unsupported schemaVersion');
  if (typeof record.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(record.version)) throw new Error('pi runtime manifest: invalid version');
  if (typeof record.releaseBaseUrl !== 'string' || !record.releaseBaseUrl.startsWith('https://')) throw new Error('pi runtime manifest: invalid releaseBaseUrl');
  if (!record.assets || typeof record.assets !== 'object') throw new Error('pi runtime manifest: missing assets');
  for (const [target, asset] of Object.entries(record.assets)) {
    const windows = target.startsWith('win32-');
    if (!/^(darwin|linux|win32)-(x64|arm64)$/.test(target)
      || typeof asset?.file !== 'string' || !/^[\w.-]+\.(tar\.gz|zip)$/.test(asset.file)
      || typeof asset.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(asset.sha256)
      || (asset.root !== 'pi' && asset.root !== '.')
      || asset.executable !== (windows ? 'pi.exe' : 'pi')) {
      throw new Error(`pi runtime manifest: invalid asset ${target}`);
    }
  }
  return record as PiRuntimeManifest;
}

export const PI_RUNTIME: PiRuntimeManifest = parsePiRuntimeManifest(JSON.parse(readFileSync(PI_RUNTIME_MANIFEST_PATH, 'utf8')));
export const PI_VERSION = PI_RUNTIME.version;

/** Node-style `<platform>-<arch>` key used by the manifest and the cache. */
export function piTarget(platform: PackPlatform | NodeJS.Platform, arch?: string): string {
  const node = platform === 'mac' ? 'darwin' : platform === 'win' ? 'win32' : platform;
  // Windows packages are x64-only; mac and linux package the host architecture.
  return `${node}-${arch ?? (node === 'win32' ? 'x64' : process.arch)}`;
}

export function piRuntimeAsset(target: string, manifest: PiRuntimeManifest = PI_RUNTIME): PiRuntimeAsset {
  const asset = manifest.assets[target];
  if (!asset) throw new Error(`pi ${manifest.version} has no official standalone build for ${target}`);
  return asset;
}

export function piRuntimeCacheRoot(workspaceRoot: string): string {
  return join(workspaceRoot, '.tmp', 'pi-runtime');
}

/** Packaged location the daemon resolves through `OD_RESOURCE_ROOT/bin/libexec/pi/pi[.exe]`. */
export function piResourceDirectory(resourceRoot: string): string {
  return join(resourceRoot, 'bin', 'libexec', 'pi');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(info => info.isFile(), () => false);
}

async function runPiVersion(binary: string): Promise<string> {
  return (await exec(binary, ['--version'], { timeout: 30_000, maxBuffer: 64 * 1024, windowsHide: true, encoding: 'utf8' })).stdout;
}

async function packageJsonVersion(runtimeDir: string): Promise<string> {
  const parsed = JSON.parse(await readFile(join(runtimeDir, 'package.json'), 'utf8')) as { version?: unknown };
  return typeof parsed.version === 'string' ? parsed.version : '';
}

function hostRuns(target: string): boolean {
  return target === `${process.platform}-${process.arch}`;
}

async function isAcquired(entry: string, manifest: PiRuntimeManifest, asset: PiRuntimeAsset): Promise<boolean> {
  try {
    const marker = JSON.parse(await readFile(join(entry, 'acquired.json'), 'utf8')) as Record<string, unknown>;
    return marker.version === manifest.version && marker.file === asset.file && marker.sha256 === asset.sha256
      && await isFile(join(entry, 'pi', asset.executable));
  } catch {
    return false;
  }
}

async function downloadVerified(url: string, destination: string, expectedSha256: string, fetchImpl: typeof fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (cause) {
    throw new Error(`pi download failed for ${url}: ${errorMessage(cause)}`, { cause });
  }
  if (!response.ok) throw new Error(`pi download failed for ${url}: HTTP ${response.status} ${response.statusText}`.trim());
  const bytes = Buffer.from(await response.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expectedSha256) {
    throw new Error(`pi archive ${basename(destination)} failed sha256 verification: expected ${expectedSha256}, got ${actual}`);
  }
  // Verified bytes land under a temporary name first; only a complete file is renamed into place.
  const partial = `${destination}.part`;
  await writeFile(partial, bytes, { flag: 'wx' });
  await rename(partial, destination);
}

async function extractArchive(archive: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  const zip = archive.endsWith('.zip');
  // Windows ships bsdtar (zip-capable) in System32; prefer it over a GNU tar from Git on PATH.
  const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
  const [command, args] = zip && process.platform === 'linux'
    ? ['unzip', ['-q', '-o', archive, '-d', destination]]
    : [tar, [zip ? '-xf' : '-xzf', archive, '-C', destination]];
  try {
    await exec(command, args, { maxBuffer: 1024 * 1024, windowsHide: true });
  } catch (cause) {
    throw new Error(`failed to extract ${basename(archive)} with ${basename(command)}: ${errorMessage(cause)}`, { cause });
  }
}

/**
 * Download (sha256-verified before extraction), extract, validate, and cache the
 * official pi runtime for `target`. Returns the cached executable path; a
 * completed cache entry is reused without network access.
 */
export async function acquirePiRuntime(options: {
  cacheRoot: string;
  target: string;
  manifest?: PiRuntimeManifest;
  fetch?: typeof fetch;
  runVersion?: (binary: string) => Promise<string>;
  log?: (message: string) => void;
}): Promise<string> {
  const manifest = options.manifest ?? PI_RUNTIME;
  const asset = piRuntimeAsset(options.target, manifest);
  const versionRoot = join(options.cacheRoot, manifest.version);
  const entry = join(versionRoot, options.target);
  const executable = join(entry, 'pi', asset.executable);
  if (await isAcquired(entry, manifest, asset)) return executable;

  const url = `${manifest.releaseBaseUrl}/${asset.file}`;
  const staging = join(versionRoot, `.staging-${options.target}-${process.pid}-${randomUUID()}`);
  await mkdir(staging, { recursive: true });
  try {
    (options.log ?? (message => process.stderr.write(`${message}\n`)))(`[pi-runtime] downloading pi ${manifest.version} (${options.target}) from ${url}`);
    const archive = join(staging, asset.file);
    await downloadVerified(url, archive, asset.sha256, options.fetch ?? fetch);
    await extractArchive(archive, asset.root === 'pi' ? staging : join(staging, 'pi'));
    await rm(archive, { force: true });
    const entries = (await readdir(staging)).sort();
    if (entries.length !== 1 || entries[0] !== 'pi') throw new Error(`pi archive ${asset.file} has an unexpected layout: ${entries.join(', ')}`);
    const stagedExecutable = join(staging, 'pi', asset.executable);
    if (!(await isFile(stagedExecutable))) throw new Error(`pi archive ${asset.file} does not contain ${asset.executable}`);
    if (!options.target.startsWith('win32-')) await chmod(stagedExecutable, 0o755);
    const declared = await packageJsonVersion(join(staging, 'pi'));
    if (declared !== manifest.version) throw new Error(`pi archive ${asset.file} declares version ${declared || '(none)'}, expected ${manifest.version}`);
    if (options.runVersion || hostRuns(options.target)) {
      const reported = (await (options.runVersion ?? runPiVersion)(stagedExecutable)).trim();
      if (reported !== manifest.version) throw new Error(`pi --version printed ${JSON.stringify(reported)}, expected ${manifest.version}`);
    }
    await writeFile(join(staging, 'acquired.json'), `${JSON.stringify({
      schemaVersion: 1, version: manifest.version, target: options.target, file: asset.file, sha256: asset.sha256, url,
    }, null, 2)}\n`);
    if (await isAcquired(entry, manifest, asset)) return executable;
    // An incomplete entry (no valid marker) is never reused.
    await rm(entry, { recursive: true, force: true });
    try {
      await rename(staging, entry);
    } catch (error) {
      // A concurrent acquisition may have completed the same entry first.
      if (!(await isAcquired(entry, manifest, asset))) throw error;
    }
    return executable;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Resolve the pi executable for a package target: `OPEN_DESIGN_PI_BIN` wins,
 * otherwise the pinned release is acquired into the workspace cache. Returns
 * null (with a warning) when unavailable unless `requireBundled` is set.
 */
export async function resolveStandalonePi(options: {
  platform: PackPlatform;
  workspaceRoot: string;
  arch?: string;
  cacheRoot?: string;
  env?: NodeJS.ProcessEnv;
  requireBundled?: boolean;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}): Promise<string | null> {
  const override = (options.env ?? process.env)[PI_BIN_ENV]?.trim();
  try {
    if (override) {
      if (!(await isFile(override))) throw new Error(`${PI_BIN_ENV} is not a regular file: ${override}`);
      return override;
    }
    return await acquirePiRuntime({
      cacheRoot: options.cacheRoot ?? piRuntimeCacheRoot(options.workspaceRoot),
      target: piTarget(options.platform, options.arch),
      ...(options.fetch ? { fetch: options.fetch } : {}),
      ...(options.log ? { log: options.log } : {}),
    });
  } catch (cause) {
    const message = `pinned pi ${PI_VERSION} runtime is unavailable: ${errorMessage(cause)}`;
    if (options.requireBundled) throw new Error(message, { cause });
    (options.log ?? (text => process.stderr.write(`${text}\n`)))(`[tools-pack] ${message}; the package will not bundle the TokenToSea/BYOK agent runtime`);
    return null;
  }
}

/** Copy the complete pi runtime directory into `<resourceRoot>/bin/libexec/pi/`. */
export async function copyStandalonePi(options: {
  platform: PackPlatform;
  resourceRoot: string;
  workspaceRoot: string;
  arch?: string;
  cacheRoot?: string;
  requireBundled?: boolean;
  env?: NodeJS.ProcessEnv;
  /** Already-resolved executable; `null` means unavailable. Omit to resolve here. */
  source?: string | null;
  version?: (binary: string) => Promise<string>;
  fetch?: typeof fetch;
  log?: (message: string) => void;
}): Promise<{ source: string; target: string } | null> {
  const source = options.source !== undefined ? options.source : await resolveStandalonePi(options);
  if (!source) return null;
  const runtimeDir = dirname(source);
  const actual = options.version || hostRuns(piTarget(options.platform, options.arch))
    ? (await (options.version ?? runPiVersion)(source)).trim()
    // A cross-platform target cannot run here; its archive identity was sha256-verified on acquisition.
    : await packageJsonVersion(runtimeDir).catch(() => '');
  if (actual !== PI_VERSION) throw new Error(`pi version ${actual || '(unknown)'} differs from the pinned ${PI_VERSION}`);
  const directory = piResourceDirectory(options.resourceRoot);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true });
  // The bun-compiled executable loads its themes, wasm, native prebuilds and docs from beside itself.
  await cp(runtimeDir, directory, { recursive: true, force: true });
  const target = join(directory, options.platform === 'win' ? 'pi.exe' : 'pi');
  if (basename(source) !== basename(target)) await rename(join(directory, basename(source)), target);
  if (options.platform !== 'win') await chmod(target, 0o755);
  return { source, target };
}
