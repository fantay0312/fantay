import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareCliVersions, normalizeCliVersion } from '../../src/runtimes/cli-update-version.js';
import { executeCliUpdate, latestCliVersion, resolveCliUpdateTarget, type CliUpdateTarget } from '../../src/runtimes/cli-update-sources.js';
import { createCliUpdateService, isCliUpdateInProgress } from '../../src/services/cli-updates.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.unstubAllGlobals(); });
const target = (agentId = 'claude'): CliUpdateTarget => ({ agentId, selectedPath: `/bin/${agentId}`, identity: `native:${agentId}`, version: '1.0.0', method: 'native', env: {} });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };

describe('CLI version ordering', () => {
  it('uses numeric components, prerelease ordering, and ignores build metadata', () => {
    expect(normalizeCliVersion('codex-cli 0.166.0')).toBe('0.166.0');
    expect(normalizeCliVersion('2.1.316 (Claude Code)')).toBe('2.1.316');
    expect(compareCliVersions('0.2.1-rc.10', '0.2.1-rc.3')).toBeGreaterThan(0);
    expect(compareCliVersions('0.2.1', '0.2.1-rc.10')).toBeGreaterThan(0);
    expect(compareCliVersions('1.10.0', '1.9.99')).toBeGreaterThan(0);
    expect(compareCliVersions('1.0.0+two', '1.0.0+one')).toBe(0);
    expect(compareCliVersions('unknown', '1.0.0')).toBeNull();
  });
  it('orders date versions without inventing an ordering for hashes on the same day', () => {
    expect(compareCliVersions('2026.10.23-abc', '2026.10.22-def')).toBeGreaterThan(0);
    expect(compareCliVersions('2026.10.22-abc', '2026.10.22-def')).toBeNull();
  });
});

describe('installation ownership', () => {
  function fixture() { const root = mkdtempSync(path.join(os.tmpdir(), 'cli-update-')); roots.push(root); return root; }
  it('anchors npm to the existing prefix including shell metacharacters', () => {
    const root = fixture(); const prefix = path.join(root, 'node $(no-shell); test');
    const pkg = path.join(prefix, 'lib/node_modules/@openai/codex');
    mkdirSync(pkg, { recursive: true }); mkdirSync(path.join(prefix, 'bin'));
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const bin = path.join(pkg, 'codex.js'); writeFileSync(bin, '');
    const npm = path.join(prefix, 'bin/npm'); writeFileSync(npm, ''); chmodSync(npm, 0o755);
    const result = resolveCliUpdateTarget('codex', bin, {});
    expect(result.method).toBe('npm'); expect(result.command).toBe(realpathSync(npm));
    expect(result.args).toContain(realpathSync(prefix)); expect(result.env.PATH?.split(path.delimiter)[0]).toBe(realpathSync(path.join(prefix, 'bin')));
  });
  it('never updates the npm package inside a Homebrew keg directly', () => {
    const root = fixture(); mkdirSync(path.join(root, 'bin'));
    const brew = path.join(root, 'bin/brew'); writeFileSync(brew, ''); chmodSync(brew, 0o755);
    const result = resolveCliUpdateTarget('opencode', path.join(root, 'Cellar/opencode/1.0/lib/node_modules/opencode-ai/bin/opencode'), {});
    expect(result.method).toBe('homebrew'); expect(result.command).toBe(brew);
  });
  it('leaves bundled applications and unknown binaries to their owner', () => {
    expect(resolveCliUpdateTarget('deepseek-harness', '/Applications/DeepSeek Harness.app/Contents/Resources/bin/dsh', {}).reason).toBe('app-managed');
    expect(resolveCliUpdateTarget('codex', '/custom/bin/codex', {}).method).toBe('manual');
  });
  it.runIf(process.platform !== 'win32')('runs the exact pinned npm update argv without evaluating path characters', async () => {
    const root = fixture(); const prefix = path.join(root, 'node $(not-executed); space');
    const pkg = path.join(prefix, 'lib/node_modules/@openai/codex');
    mkdirSync(pkg, { recursive: true }); mkdirSync(path.join(prefix, 'bin'));
    writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@openai/codex' }));
    const bin = path.join(pkg, 'codex.js'); writeFileSync(bin, '');
    const capture = path.join(root, 'args.json');
    const npm = path.join(prefix, 'bin/npm');
    writeFileSync(npm, `#!${process.execPath}\nrequire('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify(process.argv.slice(2)));\n`);
    chmodSync(npm, 0o755);
    const result = resolveCliUpdateTarget('codex', bin, process.env);
    await executeCliUpdate(result, '1.2.3');
    expect(JSON.parse(readFileSync(capture, 'utf8'))).toEqual(['install', '--global', '--prefix', realpathSync(prefix), '--include=optional', '@openai/codex@1.2.3']);
  });
  it('reads the native agy platform manifest without executing an installer', async () => {
    const fetch = vi.fn(async (_url: string) => new Response('{"version":"1.4.13"}'));
    vi.stubGlobal('fetch', fetch);
    expect(await latestCliVersion({ ...target('antigravity'), native: 'agy' })).toBe('1.4.13');
    expect(fetch.mock.calls[0]?.[0]).toBe(`https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/${process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'windows' : 'linux'}_${process.arch === 'x64' ? 'amd64' : process.arch}.json`);
  });
});

describe('CLI update lifecycle', () => {
  it('does not claim latest when the source check fails', async () => {
    const service = createCliUpdateService({ discover: async () => [target()], latest: async () => { throw new Error('offline'); } });
    expect(service.check().checking).toBe(true); await service.settled();
    expect(service.snapshot().items[0]).toMatchObject({ state: 'error', reason: 'check-failed', latestVersion: null });
  });
  it('deduplicates checks and serializes updates until their versions are verified', async () => {
    const versions = new Map([['claude', '1.0.0'], ['codex', '1.0.0']]);
    const gate = deferred(); const order: string[] = [];
    const discover = vi.fn(async () => [...versions].map(([id, version]) => ({ ...target(id), version })));
    const service = createCliUpdateService({ discover, latest: async () => '1.1.0', execute: async t => { order.push(t.agentId); if (t.agentId === 'claude') await gate.promise; versions.set(t.agentId, '1.1.0'); } });
    service.check(); service.check(); await service.settled(); expect(discover).toHaveBeenCalledTimes(1);
    service.update(['claude', 'codex']);
    expect(() => service.update(['claude'])).toThrow('running');
    await vi.waitFor(() => expect(order).toEqual(['claude']));
    expect(service.snapshot().items.find(item => item.agentId === 'codex')?.state).toBe('queued');
    gate.resolve(); await service.settled();
    expect(order).toEqual(['claude', 'codex']); expect(service.snapshot().items.every(item => item.state === 'updated')).toBe(true);
  });
  it('treats successful exit with unchanged version as a failed verification and continues the batch', async () => {
    let codexVersion = '1.0.0';
    const service = createCliUpdateService({ discover: async () => [target(), { ...target('codex'), version: codexVersion }], latest: async () => '1.1.0', execute: async t => { if (t.agentId === 'codex') codexVersion = '1.1.0'; } });
    service.check(); await service.settled(); service.update(['claude', 'codex']); await service.settled();
    expect(service.snapshot().items[0]).toMatchObject({ state: 'error', reason: 'verification-failed' });
    expect(service.snapshot().items[1]?.state).toBe('updated');
  });
  it('refuses a target that changed between checking and updating', async () => {
    let changed = false; const execute = vi.fn();
    const service = createCliUpdateService({ discover: async () => [{ ...target(), identity: changed ? 'different-prefix' : target().identity }], latest: async () => '1.1.0', execute });
    service.check(); await service.settled(); changed = true; service.update(['claude']); await service.settled();
    expect(execute).not.toHaveBeenCalled(); expect(service.snapshot().items[0]?.reason).toBe('installation-changed');
  });
  it('does not run updates for active agents, unknown IDs, or app-managed binaries', async () => {
    const service = createCliUpdateService({ discover: async () => [target(), { ...target('codex'), method: 'manual' as const }], latest: async () => '1.1.0', isBusy: id => id === 'claude' });
    service.check(); await service.settled();
    expect(() => service.update(['claude'])).toThrow('active task');
    expect(() => service.update(['codex'])).toThrow('Check this CLI');
    expect(() => service.update(['made-up; rm'])).toThrow('Check this CLI');
  });

  it('reserves the CLI and rechecks activity after asynchronous installation discovery', async () => {
    const gate = deferred(); let busy = false; let discovers = 0; const execute = vi.fn();
    const service = createCliUpdateService({
      discover: async () => { if (++discovers > 1) await gate.promise; return [target()]; },
      latest: async () => '1.1.0', isBusy: () => busy, execute,
    });
    service.check(); await service.settled(); service.update(['claude']);
    expect(isCliUpdateInProgress('claude')).toBe(true);
    await vi.waitFor(() => expect(discovers).toBe(2));
    busy = true; gate.resolve(); await service.settled();
    expect(execute).not.toHaveBeenCalled();
    expect(service.snapshot().items[0]?.reason).toBe('busy');
    expect(isCliUpdateInProgress('claude')).toBe(false);
  });
});
