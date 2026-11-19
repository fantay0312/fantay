// SPDX-License-Identifier: AGPL-3.0-only
// Terminal escape codes in saved logs. A log captured from a terminal carries colour and cursor
// sequences that read as noise in a file. They are taken out of the text, and the colour they asked
// for is kept beside it as spans, so the viewer can tint the same characters with the product's own
// tones. Only select-graphic-rendition (SGR) codes carry meaning here; every other sequence (cursor
// moves, window titles, hyperlinks) is removed. Pure: no React, no DOM.

/** The product has five status tones; sixteen terminal colours fold into them. */
export type AnsiTone = 'red' | 'green' | 'yellow' | 'blue' | 'faint';

export interface AnsiSpan {
  /** Offsets into the cleaned text. */
  from: number;
  to: number;
  tone: AnsiTone | null;
  bold: boolean;
}

export interface AnsiText {
  /** The text without any escape sequence. */
  text: string;
  /** Styled runs in document order, never overlapping. Empty when the text has no colour. */
  spans: AnsiSpan[];
}

const ESCAPE = '\u001b';

// CSI (`ESC [ … final`), OSC (`ESC ] … BEL` or `ESC ] … ESC \`), and two-character escapes.
const SEQUENCE = /\u001b(?:\[([0-?]*)[ -/]*([@-~])|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\^_])/g;

export function hasAnsi(text: string): boolean {
  return text.includes(ESCAPE);
}

/** The text without escape sequences, when the colours are not wanted. */
export function stripAnsi(text: string): string {
  return hasAnsi(text) ? text.replace(SEQUENCE, '') : text;
}

const BASE_TONES: readonly (AnsiTone | null)[] = [
  'faint', // black
  'red',
  'green',
  'yellow',
  'blue',
  'red', // magenta reads closest to the danger tone
  'blue', // cyan
  null, // white: the default ink
];

function toneOfRgb(red: number, green: number, blue: number): AnsiTone | null {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (max - min < 40) return max < 170 ? 'faint' : null;
  if (red === max) return green - blue > (max - min) * 0.55 ? 'yellow' : 'red';
  if (green === max) return blue > red + (max - min) * 0.6 ? 'blue' : 'green';
  return 'blue';
}

function toneOfPalette(index: number): AnsiTone | null {
  if (index < 8) return BASE_TONES[index] ?? null;
  if (index < 16) return index === 8 ? 'faint' : (BASE_TONES[index - 8] ?? null);
  if (index < 232) {
    const cube = index - 16;
    const level = (value: number): number => (value === 0 ? 0 : 55 + value * 40);
    return toneOfRgb(level(Math.floor(cube / 36)), level(Math.floor(cube / 6) % 6), level(cube % 6));
  }
  return index < 246 ? 'faint' : null;
}

interface Style {
  tone: AnsiTone | null;
  bold: boolean;
  dim: boolean;
}

function applySgr(style: Style, parameters: string): void {
  const codes = parameters === '' ? [0] : parameters.split(/[;:]/).map((part) => (part === '' ? 0 : Number(part)));
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index] ?? 0;
    if (code === 0) {
      style.tone = null;
      style.bold = false;
      style.dim = false;
    } else if (code === 1) style.bold = true;
    else if (code === 2) style.dim = true;
    else if (code === 22) {
      style.bold = false;
      style.dim = false;
    } else if (code >= 30 && code <= 37) style.tone = BASE_TONES[code - 30] ?? null;
    else if (code === 39) style.tone = null;
    else if (code === 90) style.tone = 'faint';
    else if (code >= 91 && code <= 97) style.tone = BASE_TONES[code - 90] ?? null;
    else if (code === 38 || code === 48) {
      // Extended colour: `38;5;n` or `38;2;r;g;b`. A background (48) is skipped, never drawn.
      const kind = codes[index + 1];
      if (kind === 5) {
        if (code === 38) style.tone = toneOfPalette(codes[index + 2] ?? 0);
        index += 2;
      } else if (kind === 2) {
        if (code === 38) style.tone = toneOfRgb(codes[index + 2] ?? 0, codes[index + 3] ?? 0, codes[index + 4] ?? 0);
        index += 4;
      }
    }
  }
}

/** Splits terminal output into clean text and the runs that were coloured or bold. */
export function parseAnsi(source: string): AnsiText {
  if (!hasAnsi(source)) return { text: source, spans: [] };
  const parts: string[] = [];
  const spans: AnsiSpan[] = [];
  const style: Style = { tone: null, bold: false, dim: false };
  let length = 0;
  let cursor = 0;

  const push = (chunk: string): void => {
    if (chunk === '') return;
    const tone = style.tone ?? (style.dim ? 'faint' : null);
    if (tone !== null || style.bold) {
      const last = spans[spans.length - 1];
      // Runs with the same look that touch are one run (a sequence that changed nothing visible).
      if (last && last.to === length && last.tone === tone && last.bold === style.bold) last.to = length + chunk.length;
      else spans.push({ from: length, to: length + chunk.length, tone, bold: style.bold });
    }
    parts.push(chunk);
    length += chunk.length;
  };

  SEQUENCE.lastIndex = 0;
  for (let match = SEQUENCE.exec(source); match !== null; match = SEQUENCE.exec(source)) {
    push(source.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    if (match[2] === 'm') applySgr(style, match[1] ?? '');
  }
  push(source.slice(cursor));
  return { text: parts.join(''), spans };
}
