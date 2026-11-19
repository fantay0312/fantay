// SPDX-License-Identifier: AGPL-3.0-only
// The text viewer's small decisions: how much of a file is read, what wraps, what counts as a line.
import { describe, expect, it } from 'vitest';

import {
  countLines,
  languageNameFor,
  textTier,
  trimToWholeLines,
  wrapsByDefault,
} from '../../../src/fantay/artifact/viewers/text/text-format';

const MB = 1024 * 1024;

describe('textTier', () => {
  it('reads small files in full, large ones plain, and only the head of huge ones', () => {
    expect(textTier(0)).toBe('full');
    expect(textTier(2 * MB)).toBe('full');
    expect(textTier(2 * MB + 1)).toBe('plain');
    expect(textTier(10 * MB)).toBe('plain');
    expect(textTier(10 * MB + 1)).toBe('head');
  });
});

describe('wrapsByDefault', () => {
  it('wraps prose and keeps the lines of code, data and logs', () => {
    expect(wrapsByDefault('text', 'plain')).toBe(true);
    expect(wrapsByDefault('text', 'subtitle')).toBe(true);
    expect(wrapsByDefault('email', 'eml')).toBe(true);
    for (const format of ['code', 'json', 'jsonl', 'yaml', 'toml', 'xml', 'ini', 'log']) {
      expect(wrapsByDefault('text', format), format).toBe(false);
    }
    expect(wrapsByDefault('diagram', 'mermaid')).toBe(false);
  });
});

describe('countLines', () => {
  it('counts as an editor does', () => {
    expect(countLines('')).toBe(0);
    expect(countLines('one')).toBe(1);
    expect(countLines('one\n')).toBe(1);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('one\n\n')).toBe(2);
  });
});

describe('trimToWholeLines', () => {
  it('drops the line the byte limit cut through', () => {
    expect(trimToWholeLines('first\nsecond\nthi')).toBe('first\nsecond\n');
    expect(trimToWholeLines('first\nsecond\n')).toBe('first\nsecond\n');
    expect(trimToWholeLines('one very long line')).toBe('one very long line');
  });
});

describe('languageNameFor', () => {
  it('keeps names the editor already understands', () => {
    expect(languageNameFor('data/a.json', 'json', 'json')).toBe('data/a.json');
    expect(languageNameFor('src/a.go', 'code', 'go')).toBe('src/a.go');
    expect(languageNameFor('a.yaml', 'yaml', 'yaml')).toBe('a.yaml');
    expect(languageNameFor('notes/a.srt', 'subtitle', 'srt')).toBe('notes/a.srt');
  });

  it('adds a familiar extension where the format is known and the extension is not', () => {
    expect(languageNameFor('data/shops.geojson', 'json', 'geojson')).toBe('data/shops.geojson.json');
    expect(languageNameFor('events.jsonl', 'jsonl', 'jsonl')).toBe('events.jsonl.json');
    expect(languageNameFor('tsconfig.jsonc', 'json', 'jsonc')).toBe('tsconfig.jsonc.js');
    expect(languageNameFor('Info.plist', 'xml', 'plist')).toBe('Info.plist.xml');
    expect(languageNameFor('.env', 'ini', '')).toBe('.env.properties');
    expect(languageNameFor('run.zsh', 'code', 'zsh')).toBe('run.zsh.sh');
    expect(languageNameFor('notes.text', 'plain', 'text')).toBe('notes.text.txt');
  });
});
