/* SPDX-License-Identifier: Apache-2.0 */
/** Test helpers for reading compiled CSS without a full parser (the compiled entry is ~2 MB). */

export interface CssBlock {
  /** Index of the `@layer` / `@scope` keyword. */
  start: number;
  /** Index just after the matching closing brace. */
  end: number;
  /** Text between the braces. */
  body: string;
}

/** Index of the brace that closes the block opened at `open` (skips strings and comments). */
export function matchingBrace(css: string, open: number): number {
  let depth = 0;
  for (let index = open; index < css.length; index += 1) {
    const char = css[index];
    if (char === '\\') {
      // Escaped character in an identifier, e.g. Tailwind's `.content-\[\'x\'\]` selectors.
      index += 1;
      continue;
    }
    if (char === '/' && css[index + 1] === '*') {
      const close = css.indexOf('*/', index + 2);
      if (close === -1) return -1;
      index = close + 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index += 1;
      while (index < css.length && css[index] !== char) {
        if (css[index] === '\\') index += 1;
        index += 1;
      }
      continue;
    }
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Every `@layer <name> { … }` block (not statements), in source order. */
export function layerBlocks(css: string, name: string): CssBlock[] {
  const blocks: CssBlock[] = [];
  const pattern = new RegExp(`@layer\\s+${name.replace(/[-]/g, '\\-')}\\s*\\{`, 'g');
  for (const match of css.matchAll(pattern)) {
    const start = match.index ?? 0;
    const open = start + match[0].length - 1;
    const close = matchingBrace(css, open);
    if (close === -1) continue;
    blocks.push({ start, end: close + 1, body: css.slice(open + 1, close) });
  }
  return blocks;
}

/** Layer statements and blocks in order: `name;` / `a,b,c;` for statements, `name{` for blocks. */
export function layerTokens(css: string): string[] {
  return [...css.matchAll(/@layer\s+([\w-]+(?:\s*,\s*[\w-]+)*)\s*([;{])/g)].map(
    (match) => `${(match[1] ?? '').replace(/\s+/g, '')}${match[2]}`,
  );
}

/** True when `index` falls inside one of `blocks`. */
export function isInside(blocks: CssBlock[], index: number): boolean {
  return index >= 0 && blocks.some((block) => index > block.start && index < block.end);
}
