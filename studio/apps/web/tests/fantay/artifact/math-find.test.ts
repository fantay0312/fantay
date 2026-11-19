// SPDX-License-Identifier: AGPL-3.0-only
// What counts as a formula in Markdown text, before Markdown gets to it. The rules have to be right
// in both directions: a formula is found whichever way it is delimited, and money, shell text and
// escaped brackets are left exactly as written.
import { describe, expect, it } from 'vitest';

import { mathMark, readsAsMath, replaceMath, soleMathMark, splitMathMarks, stripMathMarks } from '../../../src/fantay/artifact/math/find-math';

/** Replaces formulas by `<D:tex>` / `<I:tex>` so a test can read what was found. */
function found(markdown: string, backslash = true): string {
  return replaceMath(
    markdown,
    (tex, _written, alone) => `<D${alone ? '!' : ''}:${tex}>`,
    (tex) => `<I:${tex}>`,
    { backslash },
  );
}

describe('replaceMath', () => {
  it('finds dollar formulas, inline and display', () => {
    expect(found('面积是 $\\pi r^2$。')).toBe('面积是 <I:\\pi r^2>。');
    expect(found('$$\nE = mc^2\n$$')).toBe('<D!:E = mc^2>');
    expect(found('so $a$ and $b$ differ')).toBe('so <I:a> and <I:b> differ');
  });

  it('leaves money and shell text alone', () => {
    expect(found('一杯咖啡 $5，一包豆子 $12')).toBe('一杯咖啡 $5，一包豆子 $12');
    expect(found('It costs $5 and $10.')).toBe('It costs $5 and $10.');
    expect(found('between $5/$10 a month')).toBe('between $5/$10 a month');
    expect(found('set $PATH:$HOME first')).toBe('set $PATH:$HOME first');
    expect(found('escaped \\$5 and \\$6')).toBe('escaped \\$5 and \\$6');
  });

  it('finds the bracket forms a language model writes, when they read as mathematics', () => {
    expect(found('收敛速度 \\(O(1/\\sqrt{n})\\) 很慢')).toBe('收敛速度 <I:O(1/\\sqrt{n})> 很慢');
    expect(found('where \\(n\\) is the count')).toBe('where <I:n> is the count');
    expect(found('\\[\n\\Pr(A) = \\frac{1}{2}\n\\]')).toBe('<D!:\\Pr(A) = \\frac{1}{2}>');
  });

  it('keeps escaped brackets that hold words', () => {
    expect(found('转义括号 \\(见下文\\) 和 \\[可选\\]')).toBe('转义括号 \\(见下文\\) 和 \\[可选\\]');
    expect(found('a link\\-like \\[optional\\] part \\(see below\\)')).toBe('a link\\-like \\[optional\\] part \\(see below\\)');
  });

  it('looks for the bracket forms only when asked', () => {
    expect(found('\\(x^2\\) and $y$', false)).toBe('\\(x^2\\) and <I:y>');
  });

  it('never looks inside code', () => {
    expect(found('use `$x$` here, and $y$')).toBe('use `$x$` here, and <I:y>');
    expect(found('```python\nprint("$a$")\n```\n\n$b$')).toBe('```python\nprint("$a$")\n```\n\n<I:b>');
    // A fence that is still being written has no closing line: everything after it is code.
    expect(found('text $a$\n```mermaid\nA["$$x$$"]')).toBe('text <I:a>\n```mermaid\nA["$$x$$"]');
  });

  it('says whether a display formula stands on lines of its own', () => {
    expect(found('| $$x$$ | 1 |')).toBe('| <D:x> | 1 |');
    expect(found('so that $$x = 1$$ holds')).toBe('so that <D:x = 1> holds');
    expect(found('line\n$$x = 1$$\nline')).toBe('line\n<D!:x = 1>\nline');
  });

  it('hands the text as written to the caller', () => {
    const written: string[] = [];
    replaceMath('a \\(x^2\\) b $$y$$', (_tex, text) => (written.push(text), ''), (_tex, text) => (written.push(text), ''), { backslash: true });
    expect(written).toEqual(['$$y$$', '\\(x^2\\)']);
  });
});

describe('readsAsMath', () => {
  it('accepts symbols, commands and short terms', () => {
    for (const text of ['x', 'n!', 'x1', '42', 'f(x)', 'O(n)', 'a + b', 'x_i', '\\alpha', 'x^2', '2n', 'a = b']) {
      expect(readsAsMath(text), text).toBe(true);
    }
  });

  it('rejects words', () => {
    for (const text of ['', 'optional', 'see below', '见下文', 'not a link', 'TODO']) {
      expect(readsAsMath(text), text).toBe(false);
    }
  });
});

describe('marks', () => {
  it('splits text at its marks and reads a lone mark', () => {
    const text = `a ${mathMark(0)} b ${mathMark(12)}`;
    expect(splitMathMarks(text)).toEqual(['a ', 0, ' b ', 12]);
    expect(splitMathMarks('plain')).toEqual(['plain']);
    expect(soleMathMark(` ${mathMark(7)}\n`)).toBe(7);
    expect(soleMathMark(`x${mathMark(7)}`)).toBeNull();
    expect(stripMathMarks(text, (index) => `[${index}]`)).toBe('a [0] b [12]');
  });
});
