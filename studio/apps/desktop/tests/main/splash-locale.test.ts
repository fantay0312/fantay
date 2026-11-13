// The splash status line has to pick its language before the renderer — the
// only owner of the app language — exists. These specs pin the mapping from a
// language tag to a label table and the remembered-language round trip.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import {
  SPLASH_LOCALE_STATE_FILE,
  readSplashLocale,
  resolveSplashLocale,
  splashStageLabel,
  writeSplashLocale,
} from '../../src/main/splash-locale.js';

const dirs: string[] = [];
function stateDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fantay-splash-locale-'));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('splash status-line language', () => {
  test('splits Chinese the way the renderer does and sends other languages to English', () => {
    expect(resolveSplashLocale('zh-CN')).toBe('zh-CN');
    expect(resolveSplashLocale('zh')).toBe('zh-CN');
    expect(resolveSplashLocale('zh-Hans-CN')).toBe('zh-CN');
    expect(resolveSplashLocale('zh-TW')).toBe('zh-TW');
    expect(resolveSplashLocale('zh-Hant-HK')).toBe('zh-TW');
    expect(resolveSplashLocale('zh_HK')).toBe('zh-TW');
    expect(resolveSplashLocale('en-US')).toBe('en');
    expect(resolveSplashLocale('de')).toBe('en');
  });

  test('treats a missing tag as unknown rather than English', () => {
    // null lets the caller fall through to the next source (stored → OS → default).
    expect(resolveSplashLocale('')).toBeNull();
    expect(resolveSplashLocale('  ')).toBeNull();
    expect(resolveSplashLocale(undefined)).toBeNull();
    expect(resolveSplashLocale(42)).toBeNull();
  });

  test('labels every stage in every language', () => {
    expect(splashStageLabel('engine', 'en')).toBe('Starting the local engine');
    expect(splashStageLabel('engine', 'zh-CN')).toBe('正在启动本地引擎');
    expect(splashStageLabel('finishing', 'zh-TW')).toBe('即將完成');
  });

  test('remembers the app language for the next boot', () => {
    const dir = stateDir();
    expect(readSplashLocale(dir)).toBeNull();
    expect(writeSplashLocale(dir, 'zh-CN')).toBe(true);
    expect(readSplashLocale(dir)).toBe('zh-CN');
    // Unchanged language: no write.
    expect(writeSplashLocale(dir, 'zh-Hans')).toBe(false);
    // An unusable tag never clears what is stored.
    expect(writeSplashLocale(dir, '')).toBe(false);
    expect(readSplashLocale(dir)).toBe('zh-CN');
    expect(writeSplashLocale(dir, 'fr')).toBe(true);
    expect(readSplashLocale(dir)).toBe('en');
  });

  test('ignores a damaged or foreign state file', () => {
    const dir = stateDir();
    writeFileSync(join(dir, SPLASH_LOCALE_STATE_FILE), '{"locale":"constructor"}');
    expect(readSplashLocale(dir)).toBeNull();
    writeFileSync(join(dir, SPLASH_LOCALE_STATE_FILE), 'not json');
    expect(readSplashLocale(dir)).toBeNull();
  });
});
