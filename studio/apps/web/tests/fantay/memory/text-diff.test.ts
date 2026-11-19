// SPDX-License-Identifier: Apache-2.0
// The memory text diff over jsdiff: Chinese words come from Intl.Segmenter, a short Han replacement is
// refined to characters, each side of a comparison keeps its own text exactly (spacing and line breaks
// included), and an over-long pair falls back to one replacement instead of blocking the UI.
import { describe, expect, it } from 'vitest';

import { diffWords, sideBySide, type DiffSpan } from '../../../src/fantay/memory/dialogs/text-diff';

const joined = (spans: readonly DiffSpan[]) => spans.map((span) => span.text).join('');
const marked = (spans: readonly DiffSpan[]) => spans.filter((span) => span.changed).map((span) => span.text);

describe('diffWords', () => {
  it('marks whole Chinese words, not scattered characters', () => {
    expect(diffWords('首页主色用青绿 #0FB5AE', '首页主色用蓝色 #2F67C4')).toEqual([
      { op: 'equal', text: '首页主色用' },
      { op: 'delete', text: '青绿' },
      { op: 'insert', text: '蓝色' },
      { op: 'equal', text: ' #' },
      { op: 'delete', text: '0FB5AE' },
      { op: 'insert', text: '2F67C4' },
    ]);
  });

  it('refines a short Han replacement that shares a character', () => {
    expect(diffWords('回复用英文，结论先行', '回复用中文，结论先行')).toEqual([
      { op: 'equal', text: '回复用' },
      { op: 'delete', text: '英' },
      { op: 'insert', text: '中' },
      { op: 'equal', text: '文，结论先行' },
    ]);
  });

  it('diffs English by words and keeps the newer text exactly', () => {
    const after = 'The slow brown dog jumps';
    const parts = diffWords('The quick brown fox', after);
    expect(parts.filter((part) => part.op !== 'equal').map((part) => [part.op, part.text.trim()])).toEqual([
      ['delete', 'quick'],
      ['insert', 'slow'],
      ['delete', 'fox'],
      ['insert', 'dog jumps'],
    ]);
    expect(parts.filter((part) => part.op !== 'delete').map((part) => part.text).join('')).toBe(after);
  });

  it('handles empty and identical texts', () => {
    expect(diffWords('', '')).toEqual([]);
    expect(diffWords('同一句', '同一句')).toEqual([{ op: 'equal', text: '同一句' }]);
    expect(diffWords('', '新的')).toEqual([{ op: 'insert', text: '新的' }]);
    expect(diffWords('旧的', '')).toEqual([{ op: 'delete', text: '旧的' }]);
  });

  it('gives up on a pathological pair and shows one replacement', () => {
    const a = Array.from({ length: 6000 }, (_, index) => `a${index}`).join(' ');
    const b = Array.from({ length: 6000 }, (_, index) => `b${index}`).join(' ');
    const started = performance.now();
    const parts = diffWords(a, b);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(parts.filter((part) => part.op === 'delete').map((part) => part.text).join('')).toBe(a);
    expect(parts.filter((part) => part.op === 'insert').map((part) => part.text).join('')).toBe(b);
  });
});

describe('sideBySide', () => {
  it('marks on each side what the other lacks', () => {
    const diff = sideBySide('首页主色用青绿 #0FB5AE', '首页主色用蓝色 #2F67C4');
    expect(marked(diff.before)).toEqual(['青绿', '0FB5AE']);
    expect(marked(diff.after)).toEqual(['蓝色', '2F67C4']);
    expect(diff.identical).toBe(false);
  });

  it('shows each side as written, line breaks and spacing included', () => {
    const before = '先发草稿\n再定稿  确认';
    const after = '先发草稿 再定稿 确认，周五前';
    const diff = sideBySide(before, after);
    expect(joined(diff.before)).toBe(before);
    expect(joined(diff.after)).toBe(after);
    expect(marked(diff.after).join('')).toContain('周五前');
  });

  it('says when the two texts are the same', () => {
    const diff = sideBySide('回复用中文', '回复用中文');
    expect(diff.identical).toBe(true);
    expect(marked(diff.before)).toEqual([]);
    expect(marked(diff.after)).toEqual([]);
  });
});
