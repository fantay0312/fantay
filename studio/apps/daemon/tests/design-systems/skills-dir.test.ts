import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveDesignSystemSkillsDir } from '../../src/design-systems/index.js';

let tmp: string;
let builtInRoot: string;
let userRoot: string;

const skillsDir = (root: string, dirId: string) => path.join(root, dirId, 'system', 'skills');
const ship = (root: string, dirId: string) => {
  const dir = skillsDir(root, dirId);
  mkdirSync(path.join(dir, 'screen-review'), { recursive: true });
  writeFileSync(path.join(dir, 'screen-review', 'SKILL.md'), '# Screen review\n');
  return dir;
};

describe('resolveDesignSystemSkillsDir', () => {
  beforeEach(() => {
    tmp = mkdtempSync(path.join(tmpdir(), 'od-ds-skills-dir-'));
    builtInRoot = path.join(tmp, 'built-in');
    userRoot = path.join(tmp, 'user');
    mkdirSync(builtInRoot, { recursive: true });
    mkdirSync(userRoot, { recursive: true });
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('resolves a user id from the user root', async () => {
    const dir = ship(userRoot, 'my-brand');
    expect(await resolveDesignSystemSkillsDir('user:my-brand', builtInRoot, userRoot)).toBe(dir);
  });

  it('never looks in the built-in root for a user id', async () => {
    ship(builtInRoot, 'my-brand');
    expect(await resolveDesignSystemSkillsDir('user:my-brand', builtInRoot, userRoot)).toBeNull();
  });

  it('prefers the user root for a user id even when the built-in root has the same directory name', async () => {
    ship(builtInRoot, 'my-brand');
    const userDir = ship(userRoot, 'my-brand');
    expect(await resolveDesignSystemSkillsDir('user:my-brand', builtInRoot, userRoot)).toBe(userDir);
  });

  it('resolves a built-in id from the built-in root', async () => {
    const dir = ship(builtInRoot, 'linear');
    expect(await resolveDesignSystemSkillsDir('linear', builtInRoot, userRoot)).toBe(dir);
  });

  it('prefers the built-in root over the user root for a built-in id', async () => {
    const builtInDir = ship(builtInRoot, 'linear');
    ship(userRoot, 'linear');
    expect(await resolveDesignSystemSkillsDir('linear', builtInRoot, userRoot)).toBe(builtInDir);
  });

  it('falls back to the user-installed root for a built-in id the built-in root does not ship', async () => {
    const userDir = ship(userRoot, 'linear');
    expect(await resolveDesignSystemSkillsDir('linear', builtInRoot, userRoot)).toBe(userDir);
  });

  it('returns null when no root ships a system/skills directory', async () => {
    expect(await resolveDesignSystemSkillsDir('user:missing', builtInRoot, userRoot)).toBeNull();
    expect(await resolveDesignSystemSkillsDir('missing', builtInRoot, userRoot)).toBeNull();
  });

  it('returns null when the design system exists but has no skills folder', async () => {
    mkdirSync(path.join(userRoot, 'my-brand', 'system'), { recursive: true });
    expect(await resolveDesignSystemSkillsDir('user:my-brand', builtInRoot, userRoot)).toBeNull();
  });

  it('returns null when system/skills is a file rather than a directory', async () => {
    mkdirSync(path.join(userRoot, 'my-brand', 'system'), { recursive: true });
    writeFileSync(skillsDir(userRoot, 'my-brand'), 'not a directory');
    expect(await resolveDesignSystemSkillsDir('user:my-brand', builtInRoot, userRoot)).toBeNull();
  });

  it('returns null for ids that are not safe directory names, even when a matching folder exists', async () => {
    ship(userRoot, 'my-brand');
    ship(builtInRoot, 'linear');
    for (const id of ['user:', 'user:..', 'user:.', 'user:../user/my-brand', 'user:my-brand/../my-brand', 'user:a/b', '', '..', '../built-in/linear', 'lin/ear', 'lin ear']) {
      expect(await resolveDesignSystemSkillsDir(id, builtInRoot, userRoot), `id ${JSON.stringify(id)}`).toBeNull();
    }
  });
});
