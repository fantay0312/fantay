// SPDX-License-Identifier: AGPL-3.0-only
// Text helpers of the 代码 surface's changes view. Pure; no React, no DOM.
import type { TurnFileChange } from '../surfaces/surface-types';

/** CodeMirror counts every line break as one character, so the text it is given uses "\n" only. */
export function normalizeNewlines(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
    count += 1;
    // Two are as ambiguous as twenty.
    if (count > 1) break;
  }
  return count;
}

/**
 * The file as it was before the turn, rebuilt from the file as it is now by undoing the turn's hunks
 * newest first. Returns null when that cannot be done without guessing:
 *  - a hunk's result is missing from the text, or appears more than once (a `replace_all` edit, or a
 *    later hand edit);
 *  - a whole-file write replaced an existing file, whose earlier content was never recorded.
 * A file the turn created had no "before", so its original is the empty string.
 */
export function reconstructOriginalText(current: string, change: TurnFileChange): string | null {
  if (change.status === 'deleted') return null;
  if (change.status === 'created') return '';
  let text = normalizeNewlines(current);
  for (let index = change.hunks.length - 1; index >= 0; index -= 1) {
    const hunk = change.hunks[index];
    if (!hunk || hunk.before === null) return null;
    const after = normalizeNewlines(hunk.after);
    // An empty result (a pure deletion) matches everywhere.
    if (after === '' || countOccurrences(text, after) !== 1) return null;
    const at = text.indexOf(after);
    text = text.slice(0, at) + normalizeNewlines(hunk.before) + text.slice(at + after.length);
  }
  return text;
}

export interface TextChange {
  from: number;
  to: number;
  insert: string;
}

/**
 * The one replacement that turns `before` into `after`, trimmed to what differs: the shared head and
 * tail stay untouched, so an editor keeps its scroll position and selection around the edit.
 * Null when the texts are equal.
 */
export function minimalTextChange(before: string, after: string): TextChange | null {
  if (before === after) return null;
  const limit = Math.min(before.length, after.length);
  let head = 0;
  while (head < limit && before.charCodeAt(head) === after.charCodeAt(head)) head += 1;
  let tail = 0;
  while (
    tail < limit - head &&
    before.charCodeAt(before.length - 1 - tail) === after.charCodeAt(after.length - 1 - tail)
  ) {
    tail += 1;
  }
  return { from: head, to: before.length - tail, insert: after.slice(head, after.length - tail) };
}
