// SPDX-License-Identifier: AGPL-3.0-only
// Word-level difference between two memory texts, for the compare dialog and the version history.
// A thin typed adapter over jsdiff (`diff` on npm): the algorithm and the whitespace handling are the
// library's. Words come from Intl.Segmenter, because Chinese has no spaces and jsdiff's default word regex
// would see a whole sentence as one word. A short Han replacement that shares a character is refined with
// jsdiff's character diff, so 早上 → 晚上 marks only 早 / 晚. Pure; no React, no DOM.
import { diffChars, diffWords as jsDiffWords, type ChangeObject } from 'diff';

export type DiffOp = 'equal' | 'delete' | 'insert';

export interface DiffPart {
  op: DiffOp;
  text: string;
}

export interface DiffSpan {
  text: string;
  changed: boolean;
}

export interface SideBySideDiff {
  /** The older text: changed spans are the words the newer text does not have. */
  before: DiffSpan[];
  /** The newer text: changed spans are the words the older text does not have. */
  after: DiffSpan[];
  identical: boolean;
}

/**
 * This runs on the UI thread. Two unrelated 16k-character memories cost Myers O(N·D); past either bound
 * jsdiff gives up and the whole text is shown as one replacement (real memories are a sentence or two).
 */
const DIFF_BOUNDS = { maxEditLength: 4_000, timeout: 150 } as const;
/** A Han replacement up to this many characters per side is refined to characters. */
const REFINE_MAX = 24;

const HAN_ONLY = /^\p{Script=Han}+$/u;

let cachedSegmenter: Intl.Segmenter | null | undefined;

function wordSegmenter(): Intl.Segmenter | null {
  if (cachedSegmenter !== undefined) return cachedSegmenter;
  try {
    cachedSegmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter('zh', { granularity: 'word' }) : null;
  } catch {
    cachedSegmenter = null;
  }
  return cachedSegmenter;
}

function push(parts: DiffPart[], op: DiffOp, text: string): void {
  if (!text) return;
  const last = parts[parts.length - 1];
  if (last && last.op === op) last.text += text;
  else parts.push({ op, text });
}

function opOf(change: ChangeObject<string>): DiffOp {
  return change.added ? 'insert' : change.removed ? 'delete' : 'equal';
}

/** Splits a short Han replacement into characters when the two sides share one. */
function refined(deleted: string, inserted: string): DiffPart[] | null {
  if (!HAN_ONLY.test(deleted) || !HAN_ONLY.test(inserted)) return null;
  if (deleted.length > REFINE_MAX || inserted.length > REFINE_MAX) return null;
  const changes = diffChars(deleted, inserted);
  if (!changes.some((change) => !change.added && !change.removed)) return null;
  return changes.map((change) => ({ op: opOf(change), text: change.value }));
}

/**
 * The changes that turn `before` into `after`. Each run of changes is one deletion followed by one
 * insertion. Equal and inserted text is exactly `after`'s; jsdiff compares words without their
 * surrounding whitespace, so equal text carries the newer spacing.
 */
export function diffWords(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ op: 'equal', text: before }] : [];
  const segmenter = wordSegmenter();
  const changes =
    before === '' || after === ''
      ? undefined
      : jsDiffWords(before, after, { ...DIFF_BOUNDS, ...(segmenter ? { intlSegmenter: segmenter } : {}) });
  const parts: DiffPart[] = [];
  if (!changes) {
    push(parts, 'delete', before);
    push(parts, 'insert', after);
    return parts;
  }
  let deleted = '';
  let inserted = '';
  const flush = () => {
    const pieces = refined(deleted, inserted);
    if (pieces) {
      for (const piece of pieces) push(parts, piece.op, piece.text);
    } else {
      push(parts, 'delete', deleted);
      push(parts, 'insert', inserted);
    }
    deleted = '';
    inserted = '';
  };
  // jsdiff does not promise the order of the two halves of a replacement, so each run is buffered.
  for (const change of changes) {
    if (change.removed) deleted += change.value;
    else if (change.added) inserted += change.value;
    else {
      flush();
      push(parts, 'equal', change.value);
    }
  }
  flush();
  return parts;
}

/** `own` with the words `other` lacks marked; the text of every span is exactly `own`'s. */
function spansOf(other: string, own: string): DiffSpan[] {
  const spans: DiffSpan[] = [];
  for (const part of diffWords(other, own)) {
    if (part.op === 'delete') continue;
    const changed = part.op === 'insert';
    const last = spans[spans.length - 1];
    if (last && last.changed === changed) last.text += part.text;
    else spans.push({ text: part.text, changed });
  }
  return spans;
}

/** Both texts with their own changed spans marked, for two columns side by side. Each side is diffed
 *  against the other so that its own spacing and line breaks are shown as written. */
export function sideBySide(before: string, after: string): SideBySideDiff {
  return { before: spansOf(after, before), after: spansOf(before, after), identical: before === after };
}
