// SPDX-License-Identifier: AGPL-3.0-only
// The "before" text of the 代码 surface's changes view: rebuilt by undoing the turn's hunks, or refused
// (null) whenever undoing would be a guess.
import { describe, expect, it } from 'vitest';

import {
  minimalTextChange,
  normalizeNewlines,
  reconstructOriginalText,
} from '../../../../src/fantay/workspace/code/original-text';
import type { TurnFileChange, TurnFileHunk } from '../../../../src/fantay/workspace/surfaces/surface-types';

function change(status: TurnFileChange['status'], hunks: TurnFileHunk[]): TurnFileChange {
  return { path: 'src/app.ts', status, hunks, added: 0, removed: 0 };
}

describe('reconstructOriginalText', () => {
  it('undoes one edit', () => {
    const current = 'const a = 1;\nconst b = 3;\n';
    const original = reconstructOriginalText(
      current,
      change('modified', [{ before: 'const b = 2;', after: 'const b = 3;' }]),
    );
    expect(original).toBe('const a = 1;\nconst b = 2;\n');
  });

  it('undoes several edits newest first, so a later edit of an earlier result still resolves', () => {
    // v0 → v1 renames x to y; v1 → v2 changes the value on the already renamed line.
    const hunks: TurnFileHunk[] = [
      { before: 'let x = 1;', after: 'let y = 1;' },
      { before: 'let y = 1;', after: 'let y = 2;' },
    ];
    expect(reconstructOriginalText('let y = 2;\nlog(y);\n', change('modified', hunks))).toBe('let x = 1;\nlog(y);\n');
  });

  it('gives a created file an empty original, whatever its hunks are', () => {
    expect(reconstructOriginalText('hello\n', change('created', [{ before: null, after: 'hello\n' }]))).toBe('');
    expect(
      reconstructOriginalText(
        'hello world\n',
        change('created', [
          { before: null, after: 'hello\n' },
          { before: 'hello', after: 'hello world' },
        ]),
      ),
    ).toBe('');
  });

  it('refuses a whole-file write over an existing file: its earlier content was never recorded', () => {
    expect(reconstructOriginalText('new\n', change('modified', [{ before: null, after: 'new\n' }]))).toBeNull();
    expect(
      reconstructOriginalText(
        'new!\n',
        change('modified', [
          { before: null, after: 'new\n' },
          { before: 'new', after: 'new!' },
        ]),
      ),
    ).toBeNull();
  });

  it('refuses an edit whose result appears more than once', () => {
    const current = 'item\nitem\n';
    expect(reconstructOriginalText(current, change('modified', [{ before: 'thing', after: 'item' }]))).toBeNull();
  });

  it('refuses an edit whose result is no longer in the file', () => {
    expect(reconstructOriginalText('other\n', change('modified', [{ before: 'a', after: 'b' }]))).toBeNull();
  });

  it('refuses a pure deletion, whose empty result matches everywhere', () => {
    expect(reconstructOriginalText('keep\n', change('modified', [{ before: 'gone\n', after: '' }]))).toBeNull();
  });

  it('refuses a deleted file', () => {
    expect(reconstructOriginalText('', change('deleted', []))).toBeNull();
  });

  it('returns the text itself when the turn recorded no hunks', () => {
    expect(reconstructOriginalText('same\n', change('modified', []))).toBe('same\n');
  });

  it('matches across CRLF and LF, and answers in LF', () => {
    const current = 'one\r\ntwo\r\nthree\r\n';
    const original = reconstructOriginalText(
      current,
      change('modified', [{ before: 'TWO\nthree', after: 'two\nthree' }]),
    );
    expect(original).toBe('one\nTWO\nthree\n');
  });
});

describe('normalizeNewlines', () => {
  it('turns CRLF and lone CR into LF and leaves LF text untouched', () => {
    expect(normalizeNewlines('a\r\nb\rc\n')).toBe('a\nb\nc\n');
    const lf = 'a\nb\n';
    expect(normalizeNewlines(lf)).toBe(lf);
  });
});

describe('minimalTextChange', () => {
  function apply(before: string, after: string): string {
    const edit = minimalTextChange(before, after);
    if (!edit) return before;
    return before.slice(0, edit.from) + edit.insert + before.slice(edit.to);
  }

  it('is null for equal texts', () => {
    expect(minimalTextChange('same', 'same')).toBeNull();
  });

  it('touches only the part that differs', () => {
    expect(minimalTextChange('line 1\nline 2\nline 3\n', 'line 1\nline two\nline 3\n')).toEqual({
      from: 12,
      to: 13,
      insert: 'two',
    });
  });

  it('handles an insertion, a deletion and an append', () => {
    expect(minimalTextChange('ac', 'abc')).toEqual({ from: 1, to: 1, insert: 'b' });
    expect(minimalTextChange('abc', 'ac')).toEqual({ from: 1, to: 2, insert: '' });
    expect(minimalTextChange('abc', 'abcdef')).toEqual({ from: 3, to: 3, insert: 'def' });
  });

  it('never lets the shared head and tail overlap on repeated text', () => {
    for (const [before, after] of [
      ['aaa', 'aa'],
      ['aa', 'aaa'],
      ['abab', 'ab'],
      ['', 'x'],
      ['x', ''],
      ['a\na\n', 'a\na\na\n'],
    ] as const) {
      const edit = minimalTextChange(before, after);
      expect(edit).not.toBeNull();
      expect(edit!.from).toBeLessThanOrEqual(edit!.to);
      expect(apply(before, after)).toBe(after);
    }
  });
});
