import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { inspectJianyingEnvironment, draftRoot } from '../../src/jianying/environment.js';
import { listSkills, skillBodyWithRootPreamble } from '../../src/skills.js';

describe('Jianying capability detection', () => {
  const options = { arch: 'arm64', home: '/home/test', env: {}, running: async () => false, hasFfprobe: async () => true };
  it('recognizes the installed macOS 11.6 build without updating it', async () => {
    const status = await inspectJianyingEnvironment({ ...options, platform: 'darwin', readApp: async file => file.endsWith('VideoFusion-macOS.app') ? { version: '11.6.0', build: '11.6.0', bundleId: 'com.lemon.lvpro' } : null });
    expect(status.compatibility).toBe('verified'); expect(status.capabilities.editEncrypted).toBe(true); expect(status.capabilities.automaticUpdate).toBe(false);
  });
  it('does not treat an untested known schema version as verified', async () => {
    const status = await inspectJianyingEnvironment({ ...options, platform: 'darwin', readApp: async () => ({ version: '11.7.0', build: '11.7.0', bundleId: 'com.lemon.lvpro' }) });
    expect(status.compatibility).toBe('known'); expect(status.capabilities.editEncrypted).toBe(false); expect(status.capabilities.editPlaintext).toBe(true);
  });
  it('detects a Windows executable and keeps version-specific native limits explicit', async () => {
    const status = await inspectJianyingEnvironment({ ...options, platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'C:\\Users\\test\\AppData\\Local' }, readApp: async file => file.endsWith('JianyingPro.exe') ? { version: '11.6.0.14552', build: '11.6.0.14552', bundleId: 'JianyingPro.exe' } : null });
    expect(status.application.installed).toBe(true); expect(status.compatibility).toBe('known'); expect(status.capabilities.create).toBe(true); expect(status.capabilities.editEncrypted).toBe(false);
    expect(status.draftsRoot).toContain('JianyingPro\\User Data\\Projects\\com.lveditor.draft');
  });
  it('keeps offline plaintext creation available when the app is absent', async () => {
    const status = await inspectJianyingEnvironment({ ...options, platform: 'darwin', readApp: async () => null });
    expect(status.compatibility).toBe('not-installed'); expect(status.capabilities.create).toBe(true); expect(status.capabilities.editEncrypted).toBe(false);
  });
  it('does not enable a native adapter just because a different build shares the version', async () => {
    const status = await inspectJianyingEnvironment({ ...options, platform: 'darwin', readApp: async () => ({ version: '11.6.0', build: '999', bundleId: 'com.lemon.lvpro' }) });
    expect(status.capabilities.editEncrypted).toBe(false);
  });
  it('honors an explicit draft root on each platform', () => expect(draftRoot('win32', 'C:\\Users\\test', { FANTAY_JIANYING_DRAFTS_ROOT: 'D:\\Drafts' })).toBe('D:\\Drafts'));
  it('discovers the bundled Jianying skill with staged operational references', async () => {
    const root = fileURLToPath(new URL('../../../../skills', import.meta.url));
    const skills = await listSkills([root]);
    const skill = skills.find(item => item.id === 'jianying-draft');
    expect(skill).toBeDefined();
    expect(skill?.displayName?.['zh-CN']).toBe('剪映草稿');
    const dir = `${root}/jianying-draft`;
    const body = await readFile(`${dir}/SKILL.md`, 'utf8');
    const staged = await skillBodyWithRootPreamble(body, dir);
    expect(staged).toContain('references/plans.md');
    expect(staged).toContain('references/operations.md');
  });
});
