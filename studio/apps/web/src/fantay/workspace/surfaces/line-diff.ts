// SPDX-License-Identifier: AGPL-3.0-only
// Line-level diff shared by the 代码 surface's changes view and the turn-change counters.
// A thin adapter over jsdiff (`diff` on npm): the algorithm is the library's, this file only turns its
// change objects into numbered lines and bounds the cost. Pure; no React, no DOM.
import { diffLines as jsDiffLines } from 'diff';

export type DiffLineType = 'context' | 'add' | 'remove';

export interface DiffLine {
  type: DiffLineType;
  text: string;
  /** 1-based line number in before; null on added lines. */
  oldLine: number | null;
  /** 1-based line number in after; null on removed lines. */
  newLine: number | null;
}

/**
 * Bounds on one diff. This runs on the UI thread, and two unrelated files of a few thousand lines cost
 * Myers O(D²). jsdiff returns undefined once either bound is passed; 2 000 edits measured ~150 ms on
 * two fully different 6 000-line texts, and the timeout covers slower machines.
 */
const DIFF_BOUNDS = { maxEditLength: 2_000, timeout: 300 } as const;

/**
 * The lines of a text. A trailing newline ends the last line rather than starting an empty one, which
 * is how jsdiff tokenizes, so counts made here agree with counts made from a diff.
 */
function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** Line-level diff, removed lines before added lines inside one change block. */
export function diffLines(before: string, after: string): DiffLine[] {
  // An empty side needs no algorithm, and skipping it keeps a large new file clear of the edit bound.
  const changes =
    before === '' || after === ''
      ? undefined
      : jsDiffLines(before, after, {
          ...DIFF_BOUNDS,
          // A CRLF/LF flip or a missing final newline is not a change a reader cares about.
          stripTrailingCr: true,
          ignoreNewlineAtEof: true,
        });

  const out: DiffLine[] = [];
  let oldLine = 0;
  let newLine = 0;
  let removed: string[] = [];
  let added: string[] = [];
  // jsdiff does not promise the order of the two halves of a replacement, so each block is buffered
  // and written out removed-first.
  const flushBlock = () => {
    for (const text of removed) out.push({ type: 'remove', text, oldLine: (oldLine += 1), newLine: null });
    for (const text of added) out.push({ type: 'add', text, oldLine: null, newLine: (newLine += 1) });
    removed = [];
    added = [];
  };

  if (!changes) {
    // Empty side, or jsdiff gave up: the whole of before goes, the whole of after comes.
    removed = splitLines(before);
    added = splitLines(after);
    flushBlock();
    return out;
  }

  for (const change of changes) {
    const lines = splitLines(change.value);
    // Appended one by one: spreading a file-sized array into push() can exceed the argument limit.
    if (change.removed) {
      for (const text of lines) removed.push(text);
    } else if (change.added) {
      for (const text of lines) added.push(text);
    } else {
      flushBlock();
      for (const text of lines) {
        out.push({ type: 'context', text, oldLine: (oldLine += 1), newLine: (newLine += 1) });
      }
    }
  }
  flushBlock();
  return out;
}

/** Changed-line counts; before === null means every line of after counts as added. */
export function countChangedLines(
  before: string | null,
  after: string,
): { added: number; removed: number } {
  if (before === null) return { added: splitLines(after).length, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const line of diffLines(before, after)) {
    if (line.type === 'add') added += 1;
    else if (line.type === 'remove') removed += 1;
  }
  return { added, removed };
}
