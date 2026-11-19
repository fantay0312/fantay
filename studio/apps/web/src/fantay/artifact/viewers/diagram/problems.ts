// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from cindy packages/maker-shared/src/mermaidAutofix.ts @ 88941ba7 (Apache-2.0): the list of
// ways AI-written Mermaid breaks (`//` comments, unicode arrows, brackets in an unquoted label) and its
// arrow characters. Changed here: nothing is rewritten; each case becomes a plain sentence for the
// reader, full-width punctuation is added, and the cases are found from pele's error, not by regex repair.
// Why a diagram did not draw, in words a reader can act on. pele reports a code, a line, a column
// and a parser message ("Expecting 'COLON', got 'UNICODE_TEXT'"); the message is the parser's, in
// English and in token names, so it is never shown. Instead the line, the place in it and what
// the parser expected become one plain sentence; the file stays exactly as it is.
import type { Dict } from '../../../../i18n/types';

export interface DiagramHint {
  key: keyof Dict;
  params?: Record<string, string>;
}

export type DiagramProblem =
  /** Nothing but white space. */
  | { kind: 'empty' }
  /** Only comments, directives or front matter. */
  | { kind: 'no-content' }
  /** The first line names no kind pele knows. `first` is that line, shortened. */
  | { kind: 'unknown-type'; first: string }
  /** A kind pele recognises but cannot draw (or whose code failed to load). */
  | { kind: 'unsupported'; type: string }
  | { kind: 'syntax' | 'semantic'; type: string | null; line: number | null; column: number | null; lineText: string | null; hint: DiagramHint }
  | { kind: 'too-large'; reason: 'source' | 'edges' | 'output' | 'depth' | 'other'; limit: number | null }
  /** Anything else: a fault in the renderer, not in the file. */
  | { kind: 'failed' };

/** The fields of pele's `PeleError` this module reads (duck-typed so tests need no pele). */
interface PeleErrorLike {
  code: string;
  type?: string | null;
  mermaidType?: string | null;
  line?: number;
  column?: number;
  message: string;
}

function isPeleError(value: unknown): value is PeleErrorLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { code?: unknown }).code === 'string' &&
    typeof (value as { message?: unknown }).message === 'string' &&
    ['syntax', 'semantic', 'limit', 'unsupported-diagram'].includes((value as { code: string }).code)
  );
}

const FRONT_MATTER = /^﻿?\s*---[ \t]*\r?\n[\s\S]*?\r?\n[ \t]*---[ \t]*(?:\r?\n|$)/;
const DIRECTIVE = /%%\{[\s\S]*?\}%%/g;

/** The lines that carry the diagram itself: front matter, `%%{…}%%` directives, comments and blank lines removed. */
function meaningfulLines(source: string): string[] {
  return source
    .replace(FRONT_MATTER, '')
    .replace(DIRECTIVE, '')
    .split(/\r\n|\r|\n/)
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('%%'));
}

/** A problem that can be told before pele is even loaded: an empty file, a file of comments. */
export function precheckDiagram(source: string): DiagramProblem | null {
  if (source.replace(/^﻿/, '').trim() === '') return { kind: 'empty' };
  if (meaningfulLines(source).length === 0) return { kind: 'no-content' };
  return null;
}

/** Line `line` (1-based) of the source, or null. */
export function sourceLine(source: string, line: number | null | undefined): string | null {
  if (!line || line < 1) return null;
  const lines = source.split(/\r\n|\r|\n/);
  return lines[line - 1] ?? null;
}

const ARROW_CHARS = /[→⟶➔➜⇒⟹⇨➡]/;
/** Full-width punctuation Chinese input methods produce where Mermaid wants the ASCII sign. */
const FULL_WIDTH: Readonly<Record<string, string>> = {
  '：': ':', '；': ';', '（': '(', '）': ')', '，': ',', '【': '[', '】': ']', '｛': '{', '｝': '}',
  '｜': '|', '－': '-', '＞': '>', '＜': '<', '“': '"', '”': '"', '＂': '"', '＝': '=',
};
/** Tokens that close something, with the sign the reader would type. */
const CLOSERS: Readonly<Record<string, string>> = {
  PE: ')', SQE: ']', DIAMOND_STOP: '}', STRUCT_STOP: '}', BLOCK_STOP: '}', CLOSE_BRACE: '}', PIPE: '|', ENTITY_STOP: '}',
};
/** Tokens that open or close a node shape in a flowchart: met inside a label, they mean "quote it". */
const SHAPE_TOKENS = new Set(['PS', 'PE', 'SQS', 'SQE', 'DIAMOND_START', 'DIAMOND_STOP', 'PIPE', 'STADIUMSTART', 'STADIUMEND', 'SUBROUTINESTART', 'SUBROUTINEEND', 'CYLINDERSTART', 'CYLINDEREND', 'DOUBLECIRCLESTART', 'DOUBLECIRCLEEND', 'TRAPSTART', 'TRAPEND', 'INVTRAPSTART', 'INVTRAPEND']);
const LINE_END_TOKENS = new Set(['SEMI', 'NEWLINE', 'EOF', 'SPACE', 'NL', 'EOF_IN_STRUCT']);
const NAME_TOKENS = /^(?:NODE_STRING|ALPHA|ID|ACTOR|ENTITY_NAME|NAME|STR|IDENTIFIER|NUM|UNICODE_TEXT|TEXT|MD_STR)$/;

function charAt(text: string | null, column: number | null): string {
  if (text === null || column === null || column < 1) return '';
  return text.charAt(column - 1);
}

/** The words for a syntax error, from pele's message and the line it points at. */
export function syntaxHint(message: string, type: string | null, lineText: string | null, column: number | null): DiagramHint {
  const text = lineText ?? '';
  const here = charAt(lineText, column);
  const before = charAt(lineText, column === null ? null : column - 1);

  if (/^\s*\/\//.test(text)) return { key: 'artifact.diagram.hint.comment' };
  if (/front matter is not valid yaml/i.test(message)) return { key: 'artifact.diagram.hint.frontMatter' };

  const arrow = ARROW_CHARS.test(here) ? here : ARROW_CHARS.exec(text)?.[0];
  if (arrow && (ARROW_CHARS.test(here) || /^Lexical error/.test(message))) return { key: 'artifact.diagram.hint.arrow', params: { char: arrow } };

  for (const sign of [here, before]) {
    const ascii = sign ? FULL_WIDTH[sign] : undefined;
    if (ascii) return { key: 'artifact.diagram.hint.fullWidth', params: { char: sign, ascii } };
  }

  const expecting = /Expecting (.+?), got '([^']*)'/.exec(message);
  const expected = Array.from((expecting?.[1] ?? '').matchAll(/'([^']+)'/g), (match) => match[1] ?? '').filter(Boolean);
  const got = expecting?.[2] ?? '';

  // A colon was due and the line has the full-width one somewhere else.
  if ((expected.includes('COLON') || expected.includes('TXT')) && text.includes('：')) {
    return { key: 'artifact.diagram.hint.fullWidth', params: { char: '：', ascii: ':' } };
  }
  if (type === 'flowchart' && SHAPE_TOKENS.has(got)) return { key: 'artifact.diagram.hint.quoteLabel' };

  const closer = expected.map((token) => CLOSERS[token]).find(Boolean);
  if (closer && (LINE_END_TOKENS.has(got) || got === '')) return { key: 'artifact.diagram.hint.unclosed', params: { char: closer } };
  if (got === 'EOF' || got === 'EOF_IN_STRUCT') return { key: 'artifact.diagram.hint.unexpectedEnd' };
  if (expected.length > 0 && expected.every((token) => LINE_END_TOKENS.has(token))) return { key: 'artifact.diagram.hint.lineEnd' };
  if (expected.includes('COLON')) return { key: 'artifact.diagram.hint.colon' };
  if (type === 'sequence' && expected.includes('TXT')) return { key: 'artifact.diagram.hint.message' };
  if (expected.some((token) => /LINK|ARROW/.test(token)) && !expected.some((token) => NAME_TOKENS.test(token))) {
    return { key: 'artifact.diagram.hint.expectArrow' };
  }
  if (expected.some((token) => NAME_TOKENS.test(token))) return { key: 'artifact.diagram.hint.expectName' };
  if (/Expecting a number/i.test(message)) return { key: 'artifact.diagram.hint.expectNumber' };
  // A Chinese name where the grammar takes only plain identifiers (git branches, chart labels).
  if (/^Lexical error/.test(message) && /[^\x00-\x7F]/.test(here) && /\p{L}/u.test(here)) return { key: 'artifact.diagram.hint.quoteText' };
  if (/^Lexical error/.test(message) && here.trim() !== '') return { key: 'artifact.diagram.hint.unknownChar', params: { char: here } };
  return { key: 'artifact.diagram.hint.generic' };
}

/** The words for a diagram that parsed but cannot be drawn. */
export function semanticHint(message: string): DiagramHint {
  if (/circular links/i.test(message)) return { key: 'artifact.diagram.hint.sankeyCycle' };
  if (/negative values are not allowed/i.test(message)) return { key: 'artifact.diagram.hint.negativeValue' };
  if (/needs a duration or an end date|has too many fields/i.test(message)) return { key: 'artifact.diagram.hint.ganttTask' };
  if (/invalid date|valid date/i.test(message)) return { key: 'artifact.diagram.hint.invalidDate' };
  if (/only one root/i.test(message)) return { key: 'artifact.diagram.hint.oneRoot' };
  if (/no such shape/i.test(message)) return { key: 'artifact.diagram.hint.unknownShape' };
  if (/unknown shape|unknown set|out of bounds|must reference an existing/i.test(message)) return { key: 'artifact.diagram.hint.unknownReference' };
  return { key: 'artifact.diagram.hint.inconsistent' };
}

function tooLarge(message: string): DiagramProblem {
  const number = (pattern: RegExp): number | null => {
    const match = pattern.exec(message);
    return match ? Number(match[1]) : null;
  };
  if (/source is longer than/i.test(message)) return { kind: 'too-large', reason: 'source', limit: number(/limit of (\d+)/) };
  if (/edge limit/i.test(message)) return { kind: 'too-large', reason: 'edges', limit: number(/limit is (\d+)/) };
  if (/output is longer than/i.test(message)) return { kind: 'too-large', reason: 'output', limit: null };
  if (/nested too deeply/i.test(message)) return { kind: 'too-large', reason: 'depth', limit: null };
  return { kind: 'too-large', reason: 'other', limit: null };
}

/** The first meaningful line, shortened, for "第一行是「…」". */
function firstLine(source: string): string {
  const line = meaningfulLines(source)[0] ?? '';
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

/** Turns whatever `render` threw into a problem the viewer can show. */
export function describeDiagramError(error: unknown, source: string): DiagramProblem {
  if (!isPeleError(error)) return { kind: 'failed' };
  const type = error.type ?? null;
  if (error.code === 'unsupported-diagram') {
    return type ? { kind: 'unsupported', type: error.mermaidType ?? type } : { kind: 'unknown-type', first: firstLine(source) };
  }
  if (error.code === 'limit') return tooLarge(error.message);
  const line = error.line && error.line > 0 ? error.line : null;
  const column = line !== null && error.column && error.column > 0 ? error.column : null;
  const lineText = sourceLine(source, line);
  if (error.code === 'semantic') return { kind: 'semantic', type, line, column, lineText, hint: semanticHint(error.message) };
  return { kind: 'syntax', type, line, column, lineText, hint: syntaxHint(error.message, type, lineText, column) };
}

export interface LineExcerpt {
  text: string;
  /** Where the caret goes in `text` (0-based), or null when there is no column. */
  caret: number | null;
}

/**
 * At most `width` characters of a line around the column, with "…" where it was cut, so a long line
 * still shows the place the parser stopped. Tabs become two spaces so the caret lines up.
 */
export function lineExcerpt(lineText: string, column: number | null, width = 56): LineExcerpt {
  const text = lineText.replace(/\t/g, '  ').replace(/\s+$/, '');
  const at = column === null ? null : Math.max(0, Math.min(text.length, column - 1 + (lineText.slice(0, column - 1).match(/\t/g)?.length ?? 0)));
  // Leading indentation carries no information; keep at most two spaces of it.
  const indent = Math.max(0, (/^ */.exec(text)?.[0].length ?? 0) - 2);
  let start = Math.min(indent, at ?? indent);
  let end = text.length;
  if (end - start > width) {
    const centre = at ?? start;
    start = Math.max(start, Math.min(centre - Math.floor(width / 2), end - width));
    end = Math.min(end, start + width);
  }
  const head = start > indent ? '…' : '';
  const tail = end < text.length ? '…' : '';
  return { text: head + text.slice(start, end) + tail, caret: at === null ? null : head.length + at - start };
}
