// SPDX-License-Identifier: AGPL-3.0-only
// Terminal escape codes in saved logs: taken out of the text, kept as tinted runs.
import { describe, expect, it } from 'vitest';

import { hasAnsi, parseAnsi, stripAnsi } from '../../../src/fantay/artifact/viewers/text/ansi';

const E = '\u001b[';

describe('stripAnsi', () => {
  it('removes colour, cursor, title and hyperlink sequences', () => {
    expect(stripAnsi(`${E}1;31mERROR${E}0m failed`)).toBe('ERROR failed');
    expect(stripAnsi(`${E}2K${E}1Gprogress 100%`)).toBe('progress 100%');
    expect(stripAnsi('\u001b]0;window title\u0007ready')).toBe('ready');
    expect(stripAnsi('\u001b]8;;https://example.test\u001b\\link\u001b]8;;\u001b\\')).toBe('link');
  });

  it('returns text without sequences untouched', () => {
    const plain = 'INFO 处理完成 [1/3]';
    expect(hasAnsi(plain)).toBe(false);
    expect(stripAnsi(plain)).toBe(plain);
  });
});

describe('parseAnsi', () => {
  it('returns clean text and the runs that were coloured', () => {
    const parsed = parseAnsi(`${E}90m08:00${E}0m ${E}32mINFO${E}0m ok`);
    expect(parsed.text).toBe('08:00 INFO ok');
    expect(parsed.spans).toEqual([
      { from: 0, to: 5, tone: 'faint', bold: false },
      { from: 6, to: 10, tone: 'green', bold: false },
    ]);
  });

  it('folds terminal colours into the five tones and tracks bold', () => {
    const parsed = parseAnsi(`${E}1;31mERR${E}0m ${E}33mWARN${E}39m ${E}36mnote${E}0m ${E}35mx${E}0m ${E}1mB${E}22m n`);
    expect(parsed.text).toBe('ERR WARN note x B n');
    expect(parsed.spans).toEqual([
      { from: 0, to: 3, tone: 'red', bold: true },
      { from: 4, to: 8, tone: 'yellow', bold: false },
      { from: 9, to: 13, tone: 'blue', bold: false },
      { from: 14, to: 15, tone: 'red', bold: false },
      { from: 16, to: 17, tone: null, bold: true },
    ]);
  });

  it('reads 256-colour and true-colour codes and never draws a background', () => {
    const parsed = parseAnsi(`${E}38;5;196mA${E}0m${E}38;2;30;200;60mB${E}0m${E}48;5;21mC${E}0m${E}38;5;244mD${E}0m`);
    expect(parsed.text).toBe('ABCD');
    expect(parsed.spans).toEqual([
      { from: 0, to: 1, tone: 'red', bold: false },
      { from: 1, to: 2, tone: 'green', bold: false },
      { from: 3, to: 4, tone: 'faint', bold: false },
    ]);
  });

  it('joins runs that look the same and survive a sequence that changed nothing', () => {
    const parsed = parseAnsi(`${E}31mab${E}31mcd${E}0m`);
    expect(parsed.spans).toEqual([{ from: 0, to: 4, tone: 'red', bold: false }]);
  });

  it('keeps offsets right across lines and wide characters', () => {
    const parsed = parseAnsi(`第一行\n${E}32m成功${E}0m\n`);
    expect(parsed.text).toBe('第一行\n成功\n');
    expect(parsed.spans).toEqual([{ from: 4, to: 6, tone: 'green', bold: false }]);
  });

  it('returns the same text and no runs when there is nothing to parse', () => {
    expect(parseAnsi('plain')).toEqual({ text: 'plain', spans: [] });
  });
});
