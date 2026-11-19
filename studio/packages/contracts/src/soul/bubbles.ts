// SPDX-License-Identifier: Apache-2.0
// Display-only bubble splitting and paced reveal timing for IM-style replies. The stored message stays whole.

const FENCE_LINE = /^ {0,3}(?:```|~~~)/;
const LIST_LINE = /^[ \t]*(?:[-*]|\d{1,9}\.)[ \t]/;

function isTableSeparator(line: string): boolean {
  return /^[\s|:-]+$/.test(line) && line.includes("-") && line.includes("|");
}

/** Text that must stay one bubble: a code fence, a markdown table, or two or more list lines. */
function keepWhole(lines: readonly string[]): boolean {
  let listLines = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (FENCE_LINE.test(line)) return true;
    if (line.trimStart().startsWith("|") && isTableSeparator(lines[index + 1] ?? "")) return true;
    if (LIST_LINE.test(line)) listLines += 1;
    if (listLines >= 2) return true;
  }
  return false;
}

/** Splits on blank lines; merges the adjacent pair with the smallest combined length while more than `max` remain. */
export function splitBubbles(text: string, max = 4): string[] {
  const limit = Number.isFinite(max) ? Math.max(1, Math.floor(max)) : 4;
  const normalised = text.replace(/\r\n?/g, "\n");
  if (keepWhole(normalised.split("\n"))) {
    const whole = normalised.trim();
    return whole ? [whole] : [];
  }
  const parts = normalised.split(/\n[ \t]*\n/).map(part => part.trim()).filter(part => part.length > 0);
  while (parts.length > limit) {
    let best = 0;
    let bestLength = Number.POSITIVE_INFINITY;
    for (let index = 0; index + 1 < parts.length; index += 1) {
      const length = (parts[index] ?? "").length + (parts[index + 1] ?? "").length;
      if (length < bestLength) {
        best = index;
        bestLength = length;
      }
    }
    parts.splice(best, 2, `${parts[best] ?? ""}\n\n${parts[best + 1] ?? ""}`);
  }
  return parts;
}

const REVEAL_MIN_MS = 600;
const REVEAL_MAX_MS = 2200;
const REVEAL_CAP_MS = 5000;

/** Offset in ms of each bubble from the first: 0, then clamp(500 + 30 × code points, 600, 2200) per bubble, capped at 5000. */
export function revealPlan(bubbles: readonly string[]): number[] {
  const offsets: number[] = [];
  let offset = 0;
  bubbles.forEach((bubble, index) => {
    if (index > 0) {
      const gap = Math.min(REVEAL_MAX_MS, Math.max(REVEAL_MIN_MS, 500 + 30 * [...bubble].length));
      offset = Math.min(REVEAL_CAP_MS, offset + gap);
    }
    offsets.push(offset);
  });
  return offsets;
}
