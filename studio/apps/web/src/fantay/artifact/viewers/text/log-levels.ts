// SPDX-License-Identifier: AGPL-3.0-only
// A log without colour codes still has levels, and the eye wants to find the warnings and errors
// among thousands of INFO lines. The level word of each line is marked with the same tones a
// coloured log gets: errors red and bold, warnings yellow, debug and trace faint. INFO stays plain
// ink, because the ordinary line is the ground the others stand out from. Pure: no React, no DOM.
import type { AnsiSpan, AnsiTone } from './ansi';

// The level is the first level word near the start of a line, after a timestamp or a bracket. INFO
// and NOTICE are matched too, so that an ordinary line ends the search: a level word later in its
// message ("INFO retrying after ERROR") is part of the message.
const LEVEL = /^(.{0,48}?)\b(FATAL|CRITICAL|CRIT|ERROR|ERR|SEVERE|WARNING|WARN|INFO|NOTICE|DEBUG|TRACE|VERBOSE)\b/gm;

const TONES: Readonly<Record<string, { tone: AnsiTone; bold: boolean }>> = {
  FATAL: { tone: 'red', bold: true },
  CRITICAL: { tone: 'red', bold: true },
  CRIT: { tone: 'red', bold: true },
  ERROR: { tone: 'red', bold: true },
  ERR: { tone: 'red', bold: true },
  SEVERE: { tone: 'red', bold: true },
  WARNING: { tone: 'yellow', bold: false },
  WARN: { tone: 'yellow', bold: false },
  DEBUG: { tone: 'faint', bold: false },
  TRACE: { tone: 'faint', bold: false },
  VERBOSE: { tone: 'faint', bold: false },
};

/** Above this size the pass is skipped: marking a level is a nicety, not worth a pause. */
const MAX_CHARS = 12 * 1024 * 1024;

/** The level word of each line as a tinted run, in document order. */
export function logLevelSpans(text: string): AnsiSpan[] {
  if (text.length > MAX_CHARS) return [];
  const spans: AnsiSpan[] = [];
  LEVEL.lastIndex = 0;
  for (let match = LEVEL.exec(text); match !== null; match = LEVEL.exec(text)) {
    const word = match[2] ?? '';
    const look = TONES[word];
    if (!look) continue;
    const from = match.index + (match[1]?.length ?? 0);
    spans.push({ from, to: from + word.length, tone: look.tone, bold: look.bold });
  }
  return spans;
}
