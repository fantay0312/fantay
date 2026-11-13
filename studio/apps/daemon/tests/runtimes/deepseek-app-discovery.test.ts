import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deepSeekAppBundleCandidates, resolveAgentExecutable } from '../../src/runtimes/executables.js';
import { deepseekHarnessAgentDef } from '../../src/runtimes/defs/deepseek-harness.js';

const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true }); });
describe('DeepSeek Harness app discovery', () => {
  it.skipIf(process.platform !== 'darwin')('finds the bundled CLI without leaking outside an overridden home', () => {
    const home = mkdtempSync(path.join(tmpdir(), 'dsh-native-')); temporary.push(home);
    vi.stubEnv('OD_AGENT_HOME', home); vi.stubEnv('PATH', ''); vi.stubEnv('DSH_BIN', '');
    const candidate = path.join(home, 'Applications', 'DeepSeek Harness.app', 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh');
    expect(deepSeekAppBundleCandidates()).toEqual([candidate]);
    mkdirSync(path.dirname(candidate), { recursive: true }); writeFileSync(candidate, '#!/bin/sh\nexit 0\n'); chmodSync(candidate, 0o755);
    expect(resolveAgentExecutable(deepseekHarnessAgentDef)).toBe(candidate);
  });
  it('accepts the verified native release without accepting its next untested release', () => {
    const policy = deepseekHarnessAgentDef.versionPolicy;
    expect(policy.supportedVersions).toContain('0.2.1-rc.3');
    expect(policy.supportedVersions).not.toContain('0.2.1-rc.4');
    expect(policy.supportedVersionPattern.test('0.2.1-rc.4')).toBe(false);
  });
});
