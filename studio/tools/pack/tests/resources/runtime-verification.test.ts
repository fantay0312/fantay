import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyPackagedRuntime } from '@/resources/runtime-verification.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'od-runtime-verification-'));
  roots.push(root);
  const resources = join(await realpath(root), 'resources');
  await mkdir(join(resources, 'open-design/bin/libexec/pi'), { recursive: true });
  await writeFile(join(resources, 'open-design-config.json'), JSON.stringify({ appVersion: '0.22.0-prerelease.19' }));
  await writeFile(join(resources, 'open-design/bin/libexec/pi/pi'), 'pi fixture');
  const manifest = join(root, 'mac_arm64.json');
  await writeFile(manifest, JSON.stringify({ channel: 'prerelease', releaseVersion: '0.22.0-prerelease.19', platformKey: 'mac_arm64', github: { commit: 'a'.repeat(40) } }));
  const runVersion = vi.fn(async (_binary: string): Promise<string> => '1.5.0\n');
  return { root, resources, manifest, runVersion, expectedPi: '1.5.0', host: { platform: 'darwin', arch: 'arm64' } as const };
}

describe('packaged runtime identity', () => {
  it('records exact installed bytes, versions, host and release provenance without claiming regression acceptance', async () => {
    const input = await fixture();
    const result = await verifyPackagedRuntime(input);
    expect(result.release).toMatchObject({ channel: 'prerelease', version: '0.22.0-prerelease.19', commit: 'a'.repeat(40) });
    expect(result.binaries.pi.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.binaries.pi.version).toBe('1.5.0');
    expect(input.runVersion.mock.calls.map(([binary]) => binary)).toEqual([
      join(input.resources, 'open-design/bin/libexec/pi/pi'),
    ]);
    expect(result.scope).toBe('binary-identity-only');
  });
  it('rejects an app/manifest mismatch before executing a binary', async () => {
    const input = await fixture();
    await writeFile(join(input.resources, 'open-design-config.json'), JSON.stringify({ appVersion: '0.22.0-prerelease.18' }));
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('app version');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
  it('rejects a manifest for another platform', async () => {
    const input = await fixture();
    await expect(verifyPackagedRuntime({ ...input, host: { platform: 'linux', arch: 'x64' } })).rejects.toThrow('platform');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
  it('rejects a wrong binary version, including a misleading substring', async () => {
    const input = await fixture();
    input.runVersion.mockResolvedValue('1.5.00');
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('pi version');
  });
  it('rejects a missing companion instead of finding pi on PATH', async () => {
    const input = await fixture();
    await rm(join(input.resources, 'open-design/bin/libexec/pi/pi'));
    await expect(verifyPackagedRuntime(input)).rejects.toThrow();
  });
  it('rejects binaries that escape the selected package through symlinks', async () => {
    const input = await fixture();
    const binary = join(input.resources, 'open-design/bin/libexec/pi/pi');
    await rm(binary);
    await writeFile(join(input.root, 'outside-vela'), 'foreign');
    await symlink(join(input.root, 'outside-vela'), binary);
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('outside');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
  it('rejects a binary that changes while its version is probed', async () => {
    const input = await fixture();
    input.runVersion.mockImplementation(async binary => { await writeFile(binary, 'changed'); return '1.5.0'; });
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('changed');
  });
  it('rejects missing explicit target versions', async () => {
    const input = await fixture();
    await expect(verifyPackagedRuntime({ ...input, expectedPi: '' })).rejects.toThrow('expected pi');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
  it('rejects a package that retains the Vela executable', async () => {
    const input = await fixture();
    await writeFile(join(input.resources, 'open-design/bin/vela'), 'retired');
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('retired Vela');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
  it('rejects a package that retains the bundled OpenCode runtime', async () => {
    const input = await fixture();
    await mkdir(join(input.resources, 'open-design/bin/libexec/opencode'), { recursive: true });
    await writeFile(join(input.resources, 'open-design/bin/libexec/opencode/opencode'), 'retired');
    await expect(verifyPackagedRuntime(input)).rejects.toThrow('retired bundled OpenCode');
    expect(input.runVersion).not.toHaveBeenCalled();
  });
});
