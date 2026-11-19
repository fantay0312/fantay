// SPDX-License-Identifier: AGPL-3.0-only
// Finding the formulas in Markdown text, before Markdown gets to them (it would eat them: `x_i` and
// `y_i` become one italic run, `\\` loses a slash). One scanner for notebooks, Markdown documents
// and chat messages; pure text in, text out.
//
// What counts as a formula:
//  - `$$…$$` (may span lines) and `$…$` on one line, by pandoc's rule: the opening dollar is
//    followed by a character, the closing one follows a character and is not followed by a word
//    character. "$5 and $10" is money and "$PATH:$HOME" is a shell line; both stay text;
//  - with `backslash`: `\[…\]` and `\(…\)`, the form language models write. In Markdown a
//    backslash before a bracket is also how a literal bracket is written ("\[optional\]",
//    "\(see below\)"), so these count only when what is inside reads as mathematics.
// Code (fences and code spans) is never looked into.

/** Splits Markdown into code (fences and code spans, left alone) and everything else. */
const CODE_RUN = /(^|\n)(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n\2[^\n]*(?=\n|$)|$)|(`+)[^`][\s\S]*?\3/g;

const DISPLAY_DOLLAR = /\$\$([\s\S]+?)\$\$/g;
const INLINE_DOLLAR = /(?<![\\$\w])\$(?!\s)([^$\n`]+?)(?<![\s\\])\$(?![\w$])/g;
const DISPLAY_BRACKET = /(?<!\\)\\\[([\s\S]+?)(?<!\\)\\\]/g;
const INLINE_PAREN = /(?<!\\)\\\(([^\n]+?)(?<!\\)\\\)/g;

/** A TeX command, a script, a relation or an operator: things prose between escaped brackets does not have. */
const MATH_SIGNS = /\\[A-Za-z]+|[\^_=+<>|{}*/]|\d\s*[A-Za-z]|[A-Za-z]\s*\d|[∑∫∞≤≥≠±×÷√∂∇∈∉⊂⊆∪∩→←↔αβγδεθλμπσφω]/;
/** A lone symbol or number (`n`, `x1`, `42`, `n!`), or a call (`f(x)`, `O(n)`). */
const SHORT_TERM = /^(?:[A-Za-z]{1,2}\d{0,2}'*!?|-?\d+(?:\.\d+)?|[A-Za-z]{1,3}\([^()\n]{1,12}\))$/;

/** True when the text between `\(…\)` or `\[…\]` is a formula and not words in escaped brackets. */
export function readsAsMath(body: string): boolean {
  const text = body.trim();
  if (text === '') return false;
  return MATH_SIGNS.test(text) || SHORT_TERM.test(text);
}

export interface FindMathOptions {
  /** Also `\[…\]` and `\(…\)`, when what is inside reads as mathematics. */
  backslash?: boolean;
}

/** Whether the text can hold a formula at all (a cheap test before scanning). */
export function mayHoldMath(markdown: string, options: FindMathOptions = {}): boolean {
  return markdown.includes('$') || (options.backslash === true && (markdown.includes('\\(') || markdown.includes('\\[')));
}

/** True when nothing but spaces shares the lines the match starts and ends on. */
function standsAlone(text: string, start: number, length: number): boolean {
  const before = text.slice(text.lastIndexOf('\n', start - 1) + 1, start);
  const end = start + length;
  const next = text.indexOf('\n', end);
  const after = text.slice(end, next === -1 ? text.length : next);
  return before.trim() === '' && after.trim() === '';
}

/**
 * Finds the formulas in Markdown and lets the caller say what stands in for each: it is given the
 * TeX and the text as written (delimiters included), and for a display formula whether it stands
 * on lines of its own (inside a sentence, a list item or a table cell it does not, and putting
 * blank lines around it there would break that block apart). Code (fences and code spans) is left
 * alone.
 */
export function replaceMath(
  markdown: string,
  display: (tex: string, written: string, alone: boolean) => string,
  inline: (tex: string, written: string) => string,
  options: FindMathOptions = {},
): string {
  if (!mayHoldMath(markdown, options)) return markdown;
  const replace = (text: string): string => {
    let out = text.replace(DISPLAY_DOLLAR, (match, body: string, offset: number, whole: string) => display(body.trim(), match, standsAlone(whole, offset, match.length)));
    if (options.backslash) {
      out = out.replace(DISPLAY_BRACKET, (match, body: string, offset: number, whole: string) =>
        readsAsMath(body) ? display(body.trim(), match, standsAlone(whole, offset, match.length)) : match,
      );
    }
    out = out.replace(INLINE_DOLLAR, (match, body: string) => inline(body, match));
    if (options.backslash) {
      out = out.replace(INLINE_PAREN, (match, body: string) => (readsAsMath(body) ? inline(body.trim(), match) : match));
    }
    return out;
  };
  let out = '';
  let cursor = 0;
  CODE_RUN.lastIndex = 0;
  for (let match = CODE_RUN.exec(markdown); match !== null; match = CODE_RUN.exec(markdown)) {
    out += replace(markdown.slice(cursor, match.index)) + match[0];
    cursor = match.index + match[0].length;
  }
  return out + replace(markdown.slice(cursor));
}

// ── marks ────────────────────────────────────────────────────────────────────────────────────────

/**
 * A formula's number between two invisible separators. The separator cannot be typed by accident
 * and takes no room, so a mark that is ever shown reads as its number and nothing else. A mark
 * stands where the formula was while Markdown is parsed; the formula is put back afterwards.
 */
const MARK = '⁣';
const MARKS = new RegExp(`${MARK}(\\d+)${MARK}`, 'g');
const ONE_MARK = new RegExp(`^\\s*${MARK}(\\d+)${MARK}\\s*$`);

export function mathMark(index: number): string {
  return `${MARK}${index}${MARK}`;
}

/** The number of the formula when `text` is one mark and nothing else, or null. */
export function soleMathMark(text: string): number | null {
  const match = ONE_MARK.exec(text);
  return match ? Number(match[1]) : null;
}

/** Text cut at its marks: strings and formula numbers, in order. */
export function splitMathMarks(text: string): Array<string | number> {
  if (!text.includes(MARK)) return [text];
  const parts: Array<string | number> = [];
  let cursor = 0;
  MARKS.lastIndex = 0;
  for (let match = MARKS.exec(text); match !== null; match = MARKS.exec(text)) {
    if (match.index > cursor) parts.push(text.slice(cursor, match.index));
    parts.push(Number(match[1]));
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return parts;
}

/** Marks removed (for text that must not carry them, such as a copied string). */
export function stripMathMarks(text: string, source: (index: number) => string): string {
  if (!text.includes(MARK)) return text;
  return text.replace(MARKS, (_match, index: string) => source(Number(index)));
}
