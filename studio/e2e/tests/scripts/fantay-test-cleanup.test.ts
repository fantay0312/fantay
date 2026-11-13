import { spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, open, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, test } from 'vitest';

import { cleanupTestArtifacts, cleanupTestScratch, registerTestScratch } from '../../../scripts/fantay-test-cleanup.ts';
import { createSmokeSuite } from '@/vitest/suite';

const roots: string[] = [];
const sourceRoot = fileURLToPath(new URL('../../../', import.meta.url));
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'fantay-test-cleanup-'));
  roots.push(root);
  return root;
}

async function put(root: string, path: string, content = 'keep') {
  const target = join(root, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
  return target;
}

async function absent(path: string) { await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' }); }

describe('test cleanup safety and retention', () => {
  test('removes temporary databases and caches while keeping runtime logs, screenshots, traces and reports', async () => {
    const root = await fixture();
    const scratch = join(root, '.tmp/e2e/failed/scratch');
    const report = join(root, '.tmp/e2e/failed/report');
    await put(scratch, 'tools-dev/test/web/next/cache/compiled.js');
    await put(scratch, 'tools-dev/test/logs/daemon/latest.log', 'failure details');
    await put(scratch, 'data/app.sqlite', 'temporary database');
    await put(report, 'failure.png');
    await put(report, 'trace.zip');
    await put(report, 'result.json');
    const result = await cleanupTestScratch({ workspaceRoot: root, scratchDir: scratch, reportDir: report, busyPaths: [] });
    expect(result.removed).toEqual([scratch]);
    await absent(scratch);
    expect(await readFile(join(report, 'runtime-logs/tools-dev/test/logs/daemon/latest.log'), 'utf8')).toBe('failure details');
    for (const name of ['failure.png', 'trace.zip', 'result.json']) expect(await readFile(join(report, name), 'utf8')).toBe('keep');
  });

  test('retains live owners and open runtime files', async () => {
    const root = await fixture();
    const scratch = join(root, '.tmp/e2e/live/scratch');
    await put(scratch, 'data/app.sqlite');
    await registerTestScratch(scratch);
    const options = { workspaceRoot: root, scratchDir: scratch, reportDir: join(root, '.tmp/e2e/live/report') };
    expect((await cleanupTestScratch({ ...options, busyPaths: [] })).skipped).toHaveLength(1);
    expect((await cleanupTestScratch({ ...options, busyPaths: [join(scratch, 'data/app.sqlite')], ownerStopped: true })).skipped).toHaveLength(1);
    expect(await readFile(join(scratch, 'data/app.sqlite'), 'utf8')).toBe('keep');
    expect((await cleanupTestScratch({ ...options, busyPaths: [], ownerStopped: true })).removed).toEqual([scratch]);
  });

  test('does not remove an actually open file, including canonical temporary-directory paths', async () => {
    const root = await fixture();
    const scratch = join(root, '.tmp/e2e/open/scratch');
    const file = await put(scratch, 'data/app.sqlite');
    const handle = await open(file);
    try {
      const result = await cleanupTestScratch({ workspaceRoot: root, scratchDir: scratch, reportDir: join(root, '.tmp/e2e/open/report'), ownerStopped: true });
      expect(result.skipped).toHaveLength(1);
      expect(await readFile(file, 'utf8')).toBe('keep');
    } finally { await handle.close(); }
  });

  test('a failed e2e suite retains diagnostics and runtime logs while removing its scratch', async () => {
    const suite = await createSmokeSuite('cleanup-failure-test');
    roots.push(suite.root);
    await put(suite.scratchDir, 'data/app.sqlite');
    await put(suite.scratchDir, 'tools-dev/failure/logs/daemon/latest.log', 'runtime failure');
    await suite.finalize({ success: false, error: new Error('intentional failure'), diagnostics: { request: 'example' } });
    await absent(suite.scratchDir);
    const diagnostics = JSON.parse(await readFile(join(suite.report.root, 'failure/diagnostics.json'), 'utf8'));
    expect(diagnostics.diagnostics).toEqual({ request: 'example' });
    expect(diagnostics.error).toContain('Error: intentional failure');
    expect(diagnostics.error).toContain('fantay-test-cleanup.test.ts');
    expect(await readFile(join(suite.report.root, 'runtime-logs/tools-dev/failure/logs/daemon/latest.log'), 'utf8')).toBe('runtime failure');
  });

  test('refuses real data, external report paths and symlinked ancestors', async () => {
    const root = await fixture();
    const outside = await fixture();
    await put(root, '.od/app.sqlite');
    expect((await cleanupTestScratch({ workspaceRoot: root, scratchDir: join(root, '.od'), reportDir: join(root, '.tmp/report'), busyPaths: [] })).skipped).toHaveLength(1);
    await put(root, '.tmp/e2e/test/scratch/temp');
    expect((await cleanupTestScratch({ workspaceRoot: root, scratchDir: join(root, '.tmp/e2e/test/scratch'), reportDir: outside, busyPaths: [] })).skipped).toHaveLength(1);
    await put(outside, 'e2e/foreign/scratch/temp');
    const linked = await fixture();
    await symlink(outside, join(linked, '.tmp'));
    expect((await cleanupTestScratch({ workspaceRoot: linked, scratchDir: join(linked, '.tmp/e2e/foreign/scratch'), reportDir: join(linked, '.tmp/e2e/foreign/report'), busyPaths: [] })).skipped).toHaveLength(1);
    expect(await readFile(join(outside, 'e2e/foreign/scratch/temp'), 'utf8')).toBe('keep');
  });

  test('does not follow a nested symlink when preserving diagnostics', async () => {
    const root = await fixture();
    const outside = await fixture();
    const scratch = join(root, '.tmp/e2e/nested/scratch');
    const report = join(root, '.tmp/e2e/nested/report');
    await put(scratch, 'logs/daemon.log', 'new log');
    await put(outside, 'daemon.log', 'protected');
    await mkdir(join(report, 'runtime-logs'), { recursive: true });
    await symlink(outside, join(report, 'runtime-logs/logs'));
    const result = await cleanupTestScratch({ workspaceRoot: root, scratchDir: scratch, reportDir: report, busyPaths: [] });
    expect(result.skipped).toHaveLength(1);
    expect(await readFile(join(outside, 'daemon.log'), 'utf8')).toBe('protected');
    expect(await readFile(join(scratch, 'logs/daemon.log'), 'utf8')).toBe('new log');
  });

  test('uses a narrow cache allowlist and preserves application data, dependencies and records', async () => {
    const root = await fixture();
    for (const p of ['.tmp/tools-dev/qa/web/next/cache/data', '.tmp/tools-pack/cache/entries/data', 'apps/web/.next/cache/data']) await put(root, p);
    const kept = ['.od/app.sqlite', 'node_modules/pkg/index.js', 'apps/web/.next/types/app.ts', '.tmp/qa-gpt/shots/page.png', '.tmp/test-records/run/test.log', '.tmp/tools-pack/runtime/data/app.sqlite', 'src/source.ts'];
    for (const p of kept) await put(root, p);
    const result = await cleanupTestArtifacts({ workspaceRoot: root, busyPaths: [], sharedBusy: false });
    expect(result.removed).toHaveLength(3);
    for (const p of kept) expect(await readFile(join(root, p), 'utf8')).toBe('keep');
  });

  test('copies and verifies the newest installer before removing duplicate build outputs', async () => {
    const root = await fixture();
    const older = await put(root, '.tmp/tools-pack/out/mac/namespaces/old/dmg/Fantaydesign-old.dmg', 'old installer');
    const newer = await put(root, '.tmp/tools-pack/out/mac/namespaces/new/dmg/Fantaydesign-new.dmg', 'latest installer');
    await utimes(older, 1, 1); await utimes(newer, 2, 2);
    await cleanupTestArtifacts({ workspaceRoot: root, busyPaths: [], sharedBusy: false });
    expect(await readFile(join(root, '.tmp/desktop/Fantaydesign.dmg'), 'utf8')).toBe('latest installer');
    await absent(join(root, '.tmp/tools-pack/out'));
  });

  test('never overwrites a newer delivered installer and refuses a symlinked delivery directory', async () => {
    const root = await fixture();
    const source = await put(root, '.tmp/tools-pack/out/mac/namespaces/test/dmg/Fantaydesign.dmg', 'older');
    await utimes(source, 1, 1);
    await put(root, '.tmp/desktop/Fantaydesign.dmg', 'delivered');
    await cleanupTestArtifacts({ workspaceRoot: root, busyPaths: [], sharedBusy: false });
    expect(await readFile(join(root, '.tmp/desktop/Fantaydesign.dmg'), 'utf8')).toBe('delivered');
    const outside = await fixture();
    await rm(join(root, '.tmp/desktop'), { recursive: true });
    await symlink(outside, join(root, '.tmp/desktop'));
    await put(root, '.tmp/tools-pack/out/mac/namespaces/test/dmg/Fantaydesign.dmg');
    const result = await cleanupTestArtifacts({ workspaceRoot: root, busyPaths: [], sharedBusy: false });
    expect(result.skipped.some((s) => s.reason.includes('symlink'))).toBe(true);
    expect(await readFile(join(root, '.tmp/tools-pack/out/mac/namespaces/test/dmg/Fantaydesign.dmg'), 'utf8')).toBe('keep');
    await absent(join(outside, 'Fantaydesign.dmg'));
  });

  test.each([null, ['active'], []])('keeps caches if process inspection is unavailable or a producer is active: %s', async (busyPaths) => {
    const root = await fixture();
    const cache = await put(root, '.tmp/tools-pack/cache/entry');
    await cleanupTestArtifacts({ workspaceRoot: root, busyPaths: busyPaths?.[0] === 'active' ? [cache] : busyPaths, sharedBusy: busyPaths?.length === 0 });
    expect(await readFile(cache, 'utf8')).toBe('keep');
  });
});

describe('test command lifecycle', () => {
  test.each([0, 7])('preserves exit code %s and cleans after the child exits', async (exitCode) => {
    const root = await fixture();
    await mkdir(join(root, 'scripts'));
    for (const name of ['fantay-test.ts', 'fantay-test-cleanup.ts']) await copyFile(join(sourceRoot, 'scripts', name), join(root, 'scripts', name));
    const scratch = join(root, '.tmp/e2e/child/scratch');
    await put(scratch, 'data/temp.db');
    const result = spawnSync(process.execPath, ['--experimental-strip-types', join(root, 'scripts/fantay-test.ts'), 'run', '--', process.execPath, '-e', `console.log('test-output'); process.exit(${exitCode})`], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(exitCode);
    expect(result.stdout).toContain('test-output');
    await absent(scratch);
    const reportDir = result.stdout.match(/Test records: (.+)/)?.[1];
    expect(reportDir).toBeTruthy();
    expect(await readFile(join(reportDir!, 'test.log'), 'utf8')).toContain('test-output');
    expect(JSON.parse(await readFile(join(reportDir!, 'result.json'), 'utf8')).exitCode).toBe(exitCode);
  });

  test('cleans after an interrupt and reports exit 130', async () => {
    const root = await fixture();
    await mkdir(join(root, 'scripts'));
    for (const name of ['fantay-test.ts', 'fantay-test-cleanup.ts']) await copyFile(join(sourceRoot, 'scripts', name), join(root, 'scripts', name));
    const scratch = join(root, '.tmp/e2e/interrupted/scratch');
    await put(scratch, 'data/temp.db');
    const child = spawn(process.execPath, ['--experimental-strip-types', join(root, 'scripts/fantay-test.ts'), 'run', '--', process.execPath, '-e', 'console.log("ready"); setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let interrupted = false;
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      if (!interrupted && output.includes('ready')) { interrupted = true; child.kill('SIGINT'); }
    });
    const code = await new Promise<number | null>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    expect(code).toBe(130);
    await absent(scratch);
    expect(output).toContain('Test records:');
  });
});
