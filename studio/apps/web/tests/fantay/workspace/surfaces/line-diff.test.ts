import { describe, expect, it } from 'vitest';

import { countChangedLines, diffLines } from '../../../../src/fantay/workspace/surfaces/line-diff';

/** `-2 b`, `+2 B`, ` 1|1 a`: one line of a diff as a compact string, so a whole diff reads at a glance. */
function render(before: string, after: string): string[] {
  return diffLines(before, after).map((line) => {
    if (line.type === 'add') return `+${line.newLine} ${line.text}`;
    if (line.type === 'remove') return `-${line.oldLine} ${line.text}`;
    return ` ${line.oldLine}|${line.newLine} ${line.text}`;
  });
}

describe('diffLines', () => {
  it('numbers context, removed and added lines against their own side', () => {
    expect(diffLines('a\nb\nc\n', 'a\nB\nc\n')).toEqual([
      { type: 'context', text: 'a', oldLine: 1, newLine: 1 },
      { type: 'remove', text: 'b', oldLine: 2, newLine: null },
      { type: 'add', text: 'B', oldLine: null, newLine: 2 },
      { type: 'context', text: 'c', oldLine: 3, newLine: 3 },
    ]);
  });

  it('puts every removed line of a change block before its added lines', () => {
    expect(render('keep\none\ntwo\nend', 'keep\nONE\nTWO\nTHREE\nend')).toEqual([
      ' 1|1 keep',
      '-2 one',
      '-3 two',
      '+2 ONE',
      '+3 TWO',
      '+4 THREE',
      ' 4|5 end',
    ]);
  });

  it('keeps separate change blocks separate', () => {
    expect(render('a\nb\nc\nd\n', 'a\nx\nc\ny\n')).toEqual([' 1|1 a', '-2 b', '+2 x', ' 3|3 c', '-4 d', '+4 y']);
  });

  it('does not report a final newline or a CRLF/LF flip as a change', () => {
    expect(render('a\nb', 'a\nb\n')).toEqual([' 1|1 a', ' 2|2 b']);
    expect(render('a\r\nb\r\n', 'a\nb\nc\n')).toEqual([' 1|1 a', ' 2|2 b', '+3 c']);
  });

  it('keeps blank lines as lines', () => {
    expect(render('x\n\n', 'x\n')).toEqual([' 1|1 x', '-2 ']);
  });

  it('reads an empty side as all added or all removed', () => {
    expect(render('', 'a\nb\n')).toEqual(['+1 a', '+2 b']);
    expect(render('a\nb', '')).toEqual(['-1 a', '-2 b']);
    expect(diffLines('', '')).toEqual([]);
  });

  it('falls back to all removed then all added when the diff is too costly', () => {
    // 6 000 edits apart, well past the bound, with one shared line a real diff would keep as context.
    const side = (prefix: string) => [
      ...Array.from({ length: 1500 }, (_, index) => `${prefix}${index}`),
      'shared',
      ...Array.from({ length: 1500 }, (_, index) => `${prefix}${index + 1500}`),
    ];
    const lines = diffLines(side('old').join('\n'), side('new').join('\n'));

    expect(lines).toHaveLength(6002);
    expect(lines.some((line) => line.type === 'context')).toBe(false);
    expect(lines.slice(0, 3001).every((line) => line.type === 'remove')).toBe(true);
    expect(lines.slice(3001).every((line) => line.type === 'add')).toBe(true);
    expect(lines[3000]).toEqual({ type: 'remove', text: 'old2999', oldLine: 3001, newLine: null });
    expect(lines[6001]).toEqual({ type: 'add', text: 'new2999', oldLine: null, newLine: 3001 });
  });
});

describe('countChangedLines', () => {
  it('counts every line of a whole-file write as added', () => {
    expect(countChangedLines(null, 'a\nb\nc')).toEqual({ added: 3, removed: 0 });
    expect(countChangedLines(null, 'a\nb\nc\n')).toEqual({ added: 3, removed: 0 });
    expect(countChangedLines(null, '')).toEqual({ added: 0, removed: 0 });
  });

  it('counts only the lines an edit changed', () => {
    expect(countChangedLines('a\nb\nc', 'a\nB\nc\nd')).toEqual({ added: 2, removed: 1 });
    expect(countChangedLines('same\ntext', 'same\ntext')).toEqual({ added: 0, removed: 0 });
    expect(countChangedLines('gone', '')).toEqual({ added: 0, removed: 1 });
  });
});
