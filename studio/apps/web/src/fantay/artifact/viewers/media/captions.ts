// SPDX-License-Identifier: AGPL-3.0-only
// Subtitles for a film: a `.vtt` or `.srt` file next to it with the same name is shown over the
// picture. The file is read as text and drawn by the viewer, never handed to the browser as markup:
// styling tags are dropped and only the words are kept. Pure: no React, no DOM.

export interface Cue {
  /** Seconds. */
  start: number;
  end: number;
  /** Plain text; lines are separated by "\n". */
  text: string;
}

const MAX_CUES = 20_000;
const MAX_CUE_CHARS = 600;

/** "00:01:02.500", "01:02,500" (SRT uses a comma), with or without hours. */
const TIMING = /^\s*(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})\s+-->\s+(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;

function seconds(hours: string | undefined, minutes: string, secs: string, fraction: string): number {
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(secs) + Number(fraction.padEnd(3, '0')) / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', nbsp: ' ', quot: '"', lrm: '', rlm: '' };

function plainText(lines: string[]): string {
  return lines
    .map((line) =>
      line
        // Voice, class, italic and timestamp tags: the words stay, the markup goes.
        .replace(/<[^>]*>/g, '')
        // SSA-style overrides that some SRT files carry.
        .replace(/\{\\[^}]*\}/g, '')
        .replace(/&(amp|lt|gt|nbsp|quot|lrm|rlm);/g, (_, name: string) => ENTITIES[name] ?? '')
        .trim(),
    )
    .filter((line) => line !== '')
    .join('\n')
    .slice(0, MAX_CUE_CHARS);
}

/** Reads WebVTT or SubRip. Blocks without a timing line (headers, notes, styles) are skipped. */
export function parseCaptions(source: string): Cue[] {
  const cues: Cue[] = [];
  const blocks = source.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    if (cues.length >= MAX_CUES) break;
    const lines = block.split('\n');
    const at = lines.findIndex((line) => line.includes('-->'));
    if (at < 0) continue;
    const match = TIMING.exec(lines[at] ?? '');
    if (!match) continue;
    const start = seconds(match[1], match[2] ?? '0', match[3] ?? '0', match[4] ?? '0');
    const end = seconds(match[5], match[6] ?? '0', match[7] ?? '0', match[8] ?? '0');
    const text = plainText(lines.slice(at + 1));
    if (text === '' || !(end > start)) continue;
    cues.push({ start, end, text });
  }
  return cues.sort((a, b) => a.start - b.start);
}

/** The words on screen at `time`: every cue that covers it, in order. Empty when none does. */
export function captionAt(cues: readonly Cue[], time: number): string {
  let text = '';
  for (const cue of cues) {
    if (cue.start > time) break;
    if (time < cue.end) text = text === '' ? cue.text : `${text}\n${cue.text}`;
  }
  return text;
}

/** The subtitle files that belong to a film: same folder, same name, `.vtt` before `.srt`. */
export function captionFileNames(videoName: string): string[] {
  const slash = videoName.lastIndexOf('/');
  const dot = videoName.lastIndexOf('.');
  const stem = dot > slash + 1 ? videoName.slice(0, dot) : videoName;
  return [`${stem}.vtt`, `${stem}.srt`];
}
