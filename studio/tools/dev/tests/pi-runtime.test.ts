import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

import { resolveDevPiEnv } from '../src/pi-runtime.js';

const exec = promisify(execFile);
const target = `${process.platform}-${process.arch}`;
const executable = process.platform === 'win32' ? 'pi.exe' : 'pi';

async function fixture(t: { after: (fn: () => Promise<void>) => void }, sha256?: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tools-dev-pi-')); t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, 'release');
  await mkdir(path.join(source, 'pi', 'theme'), { recursive: true });
  await writeFile(path.join(source, 'pi', executable), 'fixture executable', { mode: 0o755 });
  await writeFile(path.join(source, 'pi', 'package.json'), '{"version":"1.5.0"}');
  await writeFile(path.join(source, 'pi', 'theme', 'dark.json'), '{}');
  const archive = path.join(root, 'pi-fixture.tar.gz');
  await exec('tar', ['-czf', archive, '-C', source, 'pi']);
  const bytes = await readFile(archive);
  const workspaceRoot = path.join(root, 'workspace');
  await mkdir(path.join(workspaceRoot, 'tools', 'pack', 'resources'), { recursive: true });
  await writeFile(path.join(workspaceRoot, 'tools', 'pack', 'resources', 'pi-runtime.json'), JSON.stringify({
    schemaVersion: 1, version: '1.5.0', releaseBaseUrl: 'https://example.invalid/pi',
    assets: { [target]: { file: 'pi-fixture.tar.gz', sha256: sha256 ?? createHash('sha256').update(bytes).digest('hex'), root: 'pi', executable } },
  }));
  const requests: string[] = [];
  const fetch = (async (url: string) => { requests.push(String(url)); return new Response(bytes); }) as unknown as typeof globalThis.fetch;
  return { workspaceRoot, requests, fetch };
}

test('an exported FANTAY_PI_BIN stays authoritative', async () => {
  assert.deepEqual(await resolveDevPiEnv('/unused', { FANTAY_PI_BIN: '/custom/pi' }), {});
});

test('OPEN_DESIGN_PI_BIN selects a local pi runtime', async () => {
  assert.deepEqual(await resolveDevPiEnv('/unused', { OPEN_DESIGN_PI_BIN: '/local/pi/pi' }), { FANTAY_PI_BIN: path.resolve('/local/pi/pi') });
});

test('the pinned release is verified, extracted into the shared cache and then reused offline', async t => {
  const { workspaceRoot, requests, fetch } = await fixture(t);
  const deps = { fetch, runVersion: async () => '1.5.0\n' };
  const entry = path.join(workspaceRoot, '.tmp', 'pi-runtime', '1.5.0', target);
  const expected = { FANTAY_PI_BIN: path.join(entry, 'pi', executable) };
  assert.deepEqual(await resolveDevPiEnv(workspaceRoot, {}, undefined, deps), expected);
  assert.deepEqual(requests, ['https://example.invalid/pi/pi-fixture.tar.gz']);
  await access(path.join(entry, 'pi', 'theme', 'dark.json'));
  assert.deepEqual((await readdir(entry)).sort(), ['acquired.json', 'pi']);
  assert.deepEqual(await resolveDevPiEnv(workspaceRoot, {}, undefined, deps), expected);
  assert.equal(requests.length, 1);
});

test('a checksum mismatch is reported and leaves no cache entry', async t => {
  const { workspaceRoot, fetch } = await fixture(t, '0'.repeat(64));
  const logs: string[] = [];
  assert.deepEqual(await resolveDevPiEnv(workspaceRoot, {}, text => logs.push(text), { fetch, runVersion: async () => '1.5.0' }), {});
  assert.match(logs.join('\n'), /sha256/);
  assert.deepEqual(await readdir(path.join(workspaceRoot, '.tmp', 'pi-runtime', '1.5.0')), []);
});

test('a runtime reporting another version is rejected', async t => {
  const { workspaceRoot, fetch } = await fixture(t);
  const logs: string[] = [];
  assert.deepEqual(await resolveDevPiEnv(workspaceRoot, {}, text => logs.push(text), { fetch, runVersion: async () => '1.4.9' }), {});
  assert.match(logs.join('\n'), /expected 1\.5\.0/);
});
