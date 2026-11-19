// SPDX-License-Identifier: Apache-2.0
// Token estimate shared by budgets, traces and the editor counters.

function isCjk(codePoint: number): boolean {
  return (codePoint >= 0x2e80 && codePoint <= 0x9fff)
    || (codePoint >= 0xac00 && codePoint <= 0xd7af)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xff00 && codePoint <= 0xffef)
    || codePoint >= 0x20000;
}

/** One token per CJK code point plus one per four other code points; 0 for '', at least 1 otherwise. */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let cjk = 0;
  let other = 0;
  for (const char of text) {
    if (isCjk(char.codePointAt(0) ?? 0)) cjk += 1;
    else other += 1;
  }
  return Math.max(1, cjk + Math.ceil(other / 4));
}
