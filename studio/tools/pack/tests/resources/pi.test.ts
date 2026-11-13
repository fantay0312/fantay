import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import {
  acquirePiRuntime,
  copyStandalonePi,
  parsePiRuntimeManifest,
  piRuntimeAsset,
  piTarget,
  PI_RUNTIME,
  PI_VERSION,
  resolveStandalonePi,
  type PiRuntimeManifest,
} from '@/resources/pi.js';

const exec = promisify(execFile);
const roots: string[] = [];
let sharedTarRoot = '';
let sharedTarBytes: Buffer;

beforeAll(async () => {
  sharedTarRoot = await mkdtemp(join(tmpdir(), 'tools-pack-pi-shared-'));
  const source = join(sharedTarRoot, 'release');
  await writeRuntime(join(source, 'pi'));
  const archive = join(sharedTarRoot, 'pi-test.tar.gz');
  await exec('tar', ['-czf', archive, '-C', source, 'pi']);
  sharedTarBytes = await readFile(archive);
});

afterAll(async () => {
  if (sharedTarRoot) await rm(sharedTarRoot, { recursive: true, force: true });
});

afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'tools-pack-pi-'));
  roots.push(root);
  return root;
}

/** A release-shaped runtime directory: executable plus the files it loads from beside itself. */
async function writeRuntime(dir: string, executable = 'pi', version = PI_VERSION): Promise<void> {
  await mkdir(join(dir, 'native', 'darwin', 'prebuilds', 'darwin-arm64'), { recursive: true });
  await mkdir(join(dir, 'theme'), { recursive: true });
  await writeFile(join(dir, executable), 'pi executable fixture', { mode: 0o755 });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name: '@earendil-works/pi-coding-agent', version }));
  await writeFile(join(dir, 'photon_rs_bg.wasm'), 'wasm');
  await writeFile(join(dir, 'theme', 'dark.json'), '{}');
  await writeFile(join(dir, 'native', 'darwin', 'prebuilds', 'darwin-arm64', 'darwin-platform.node'), 'addon');
}

function manifestFor(target: string, file: string, bytes: Buffer, root: 'pi' | '.' = 'pi', sha256?: string): PiRuntimeManifest {
  return {
    schemaVersion: 1,
    version: PI_VERSION,
    releaseBaseUrl: 'https://example.invalid/pi',
    assets: {
      [target]: {
        file,
        sha256: sha256 ?? createHash('sha256').update(bytes).digest('hex'),
        root,
        executable: target.startsWith('win32-') ? 'pi.exe' : 'pi',
      },
    },
  };
}

function fakeFetch(bytes: Buffer, requests: string[] = []): typeof fetch {
  return (async (url: string | URL | Request) => { requests.push(String(url)); return new Response(new Uint8Array(bytes)); }) as typeof fetch;
}

describe('pinned pi runtime manifest', () => {
  it('maps package platforms to manifest targets', () => {
    expect(piTarget('mac', 'arm64')).toBe('darwin-arm64');
    expect(piTarget('linux', 'x64')).toBe('linux-x64');
    expect(piTarget('win')).toBe('win32-x64');
    expect(() => piRuntimeAsset('freebsd-x64')).toThrow('no official standalone build');
  });

  it('rejects a manifest entry without a valid sha256', () => {
    const asset = { file: 'pi-darwin-arm64.tar.gz', sha256: 'abc', root: 'pi', executable: 'pi' };
    expect(() => parsePiRuntimeManifest({ ...PI_RUNTIME, assets: { 'darwin-arm64': asset } })).toThrow('invalid asset darwin-arm64');
  });
});

describe('acquirePiRuntime', () => {
  it('verifies, extracts and caches the archive, then reuses the cache without network', async () => {
    const root = await tempRoot();
    const bytes = sharedTarBytes;
    const requests: string[] = [];
    const options = {
      cacheRoot: join(root, 'cache'),
      target: 'darwin-arm64',
      manifest: manifestFor('darwin-arm64', 'pi-test.tar.gz', bytes),
      fetch: fakeFetch(bytes, requests),
      runVersion: async () => `${PI_VERSION}\n`,
      log: () => {},
    };
    const executable = await acquirePiRuntime(options);
    const entry = join(root, 'cache', PI_VERSION, 'darwin-arm64');
    expect(executable).toBe(join(entry, 'pi', 'pi'));
    expect(requests).toEqual(['https://example.invalid/pi/pi-test.tar.gz']);
    expect((await readdir(entry)).sort()).toEqual(['acquired.json', 'pi']);
    await access(join(entry, 'pi', 'native', 'darwin', 'prebuilds', 'darwin-arm64', 'darwin-platform.node'));
    expect(JSON.parse(await readFile(join(entry, 'acquired.json'), 'utf8'))).toMatchObject({ version: PI_VERSION, file: 'pi-test.tar.gz' });

    await expect(acquirePiRuntime(options)).resolves.toBe(executable);
    expect(requests).toHaveLength(1);
    expect(await readdir(join(root, 'cache', PI_VERSION))).toEqual(['darwin-arm64']);
  });

  it('rejects a checksum mismatch before extraction and leaves no cache entry', async () => {
    const root = await tempRoot();
    const bytes = sharedTarBytes;
    await expect(acquirePiRuntime({
      cacheRoot: join(root, 'cache'),
      target: 'darwin-arm64',
      manifest: manifestFor('darwin-arm64', 'pi-test.tar.gz', bytes, 'pi', 'f'.repeat(64)),
      fetch: fakeFetch(bytes),
      runVersion: async () => PI_VERSION,
      log: () => {},
    })).rejects.toThrow('sha256');
    expect(await readdir(join(root, 'cache', PI_VERSION))).toEqual([]);
  });

  it('reports a failed download with its URL', async () => {
    const root = await tempRoot();
    await expect(acquirePiRuntime({
      cacheRoot: join(root, 'cache'),
      target: 'darwin-arm64',
      manifest: manifestFor('darwin-arm64', 'pi-test.tar.gz', Buffer.from('x')),
      fetch: (async () => new Response('missing', { status: 404 })) as typeof fetch,
      log: () => {},
    })).rejects.toThrow('https://example.invalid/pi/pi-test.tar.gz: HTTP 404');
  });

  it('rejects a runtime whose --version does not match the pin', async () => {
    const root = await tempRoot();
    const bytes = sharedTarBytes;
    await expect(acquirePiRuntime({
      cacheRoot: join(root, 'cache'),
      target: 'darwin-arm64',
      manifest: manifestFor('darwin-arm64', 'pi-test.tar.gz', bytes),
      fetch: fakeFetch(bytes),
      runVersion: async () => '1.4.0',
      log: () => {},
    })).rejects.toThrow('expected 1.5.0');
  });

  it.skipIf(process.platform === 'win32')('normalizes a root-level Windows zip into the cached pi directory', async () => {
    const root = await tempRoot();
    const source = join(root, 'zip-source');
    await writeRuntime(source, 'pi.exe');
    const archive = join(root, 'pi-test.zip');
    try { await exec('zip', ['-qr', archive, '.'], { cwd: source }); } catch { return; }
    const bytes = await readFile(archive);
    const executable = await acquirePiRuntime({
      cacheRoot: join(root, 'cache'),
      target: 'win32-x64',
      manifest: manifestFor('win32-x64', 'pi-test.zip', bytes, '.'),
      fetch: fakeFetch(bytes),
      log: () => {},
    });
    expect(executable).toBe(join(root, 'cache', PI_VERSION, 'win32-x64', 'pi', 'pi.exe'));
    await access(join(root, 'cache', PI_VERSION, 'win32-x64', 'pi', 'theme', 'dark.json'));
  });
});

describe('resolveStandalonePi', () => {
  it('prefers OPEN_DESIGN_PI_BIN and fails strictly when it is missing', async () => {
    const root = await tempRoot();
    await writeRuntime(join(root, 'local'));
    const source = join(root, 'local', 'pi');
    await expect(resolveStandalonePi({ platform: 'mac', workspaceRoot: root, env: { OPEN_DESIGN_PI_BIN: source } })).resolves.toBe(source);
    await expect(resolveStandalonePi({
      platform: 'mac', workspaceRoot: root, requireBundled: true, env: { OPEN_DESIGN_PI_BIN: join(root, 'missing', 'pi') },
    })).rejects.toThrow('OPEN_DESIGN_PI_BIN');
  });

  it('returns null with a diagnostic when the pinned release is unreachable and not required', async () => {
    const root = await tempRoot();
    const logs: string[] = [];
    const offline = (async () => { throw new Error('offline'); }) as typeof fetch;
    await expect(resolveStandalonePi({ platform: 'linux', arch: 'x64', workspaceRoot: root, env: {}, fetch: offline, log: text => logs.push(text) }))
      .resolves.toBeNull();
    expect(logs.join('\n')).toMatch(/pi 1\.5\.0 runtime is unavailable.*offline/);
    await expect(resolveStandalonePi({ platform: 'linux', arch: 'x64', workspaceRoot: root, env: {}, fetch: offline, requireBundled: true, log: () => {} }))
      .rejects.toThrow('offline');
  });
});

describe('copyStandalonePi', () => {
  it('copies the whole runtime directory to bin/libexec/pi', async () => {
    const root = await tempRoot();
    await writeRuntime(join(root, 'cache', 'pi'));
    const resourceRoot = join(root, 'resources');
    await mkdir(join(resourceRoot, 'bin', 'libexec', 'pi'), { recursive: true });
    await writeFile(join(resourceRoot, 'bin', 'libexec', 'pi', 'stale.txt'), 'old');
    const result = await copyStandalonePi({
      platform: 'mac', resourceRoot, workspaceRoot: root, source: join(root, 'cache', 'pi', 'pi'), version: async () => `${PI_VERSION}\n`,
    });
    const directory = join(resourceRoot, 'bin', 'libexec', 'pi');
    expect(result?.target).toBe(join(directory, 'pi'));
    expect((await readdir(directory)).sort()).toEqual(['native', 'package.json', 'photon_rs_bg.wasm', 'pi', 'theme']);
    await access(join(directory, 'native', 'darwin', 'prebuilds', 'darwin-arm64', 'darwin-platform.node'));
    if (process.platform !== 'win32') expect((await stat(join(directory, 'pi'))).mode & 0o111).not.toBe(0);
    await expect(access(join(resourceRoot, 'bin', 'libexec', 'opencode'))).rejects.toThrow();
  });

  it('uses the canonical pi.exe name for Windows packages', async () => {
    const root = await tempRoot();
    await writeRuntime(join(root, 'local'), 'pi-custom.exe');
    const result = await copyStandalonePi({
      platform: 'win', resourceRoot: join(root, 'resources'), workspaceRoot: root, source: join(root, 'local', 'pi-custom.exe'), version: async () => PI_VERSION,
    });
    expect(result?.target).toBe(join(root, 'resources', 'bin', 'libexec', 'pi', 'pi.exe'));
    await expect(readFile(result!.target, 'utf8')).resolves.toBe('pi executable fixture');
  });

  it.skipIf(process.platform === 'win32')('checks a cross-platform runtime through its package.json version', async () => {
    const root = await tempRoot();
    await writeRuntime(join(root, 'win'), 'pi.exe', '1.4.0');
    await expect(copyStandalonePi({ platform: 'win', resourceRoot: join(root, 'resources'), workspaceRoot: root, source: join(root, 'win', 'pi.exe') }))
      .rejects.toThrow('pi version 1.4.0 differs from the pinned 1.5.0');
  });

  it('rejects a different runtime version before packaging', async () => {
    const root = await tempRoot();
    await expect(copyStandalonePi({ platform: 'mac', source: '/unused/pi', resourceRoot: root, workspaceRoot: root, version: async () => '0.0.1' }))
      .rejects.toThrow('version');
  });
});
