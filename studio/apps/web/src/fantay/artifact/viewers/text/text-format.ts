// SPDX-License-Identifier: AGPL-3.0-only
// Small decisions the text viewer makes from a file's size and format. Pure: no React, no DOM.
import { LARGE_TEXT_BYTES, MAX_TEXT_BYTES } from '../../../workspace/code/text-preview';

/**
 * How much of a file is read:
 *  - `full`: the whole file, highlighted;
 *  - `plain`: the whole file without highlighting (parsing megabytes buys nobody anything);
 *  - `head`: only the first part, because the whole file would sit in memory several times over.
 * The limits are the 代码 surface's, so a file reads the same in both places.
 */
export type TextTier = 'full' | 'plain' | 'head';

export function textTier(size: number): TextTier {
  if (size > MAX_TEXT_BYTES) return 'head';
  return size > LARGE_TEXT_BYTES ? 'plain' : 'full';
}

/** What the daemon's text preview returns at most; the head of a file too large to load. */
export const TEXT_HEAD_BYTES = 512 * 1024;

/**
 * Prose wraps, code does not: a sentence cut off at the edge is unreadable, a wrapped line of code
 * loses its shape. Mail is prose with a header; logs, data and diagram sources keep their lines.
 */
export function wrapsByDefault(viewer: string, format: string): boolean {
  return viewer === 'email' || format === 'plain' || format === 'subtitle';
}

/** Lines as an editor counts them: a final line break does not start another line. */
export function countLines(text: string): number {
  if (text === '') return 0;
  let lines = 1;
  for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) lines += 1;
  return text.endsWith('\n') ? lines - 1 : lines;
}

/**
 * The head of a file ends wherever the byte limit fell, usually in the middle of a line and
 * sometimes in the middle of a character. The broken last line is dropped, so what is shown is
 * whole lines of the real file.
 */
export function trimToWholeLines(head: string): string {
  const lastBreak = head.lastIndexOf('\n');
  return lastBreak === -1 ? head : head.slice(0, lastBreak + 1);
}

/** Extensions the editor's language table does not know, mapped to one it does. */
const CODE_ALIASES: Readonly<Record<string, string>> = {
  zsh: 'sh',
  fish: 'sh',
  pyi: 'py',
  sc: 'scala',
  svelte: 'html',
  astro: 'html',
  glsl: 'c',
  vert: 'c',
  frag: 'c',
  wgsl: 'rs',
};

const KNOWN_BY_FORMAT: Readonly<Record<string, { known: readonly string[]; fallback: string }>> = {
  json: { known: ['json', 'map'], fallback: 'json' },
  jsonl: { known: [], fallback: 'json' },
  xml: { known: ['xml', 'xsl', 'xsd'], fallback: 'xml' },
  ini: { known: ['ini', 'properties'], fallback: 'properties' },
};

/**
 * The name the editor should pick the language from. The editor decides by extension, and knows
 * `.json` but not `.geojson`, `.xml` but not `.plist`. Where the format is known and the extension is
 * not, a familiar extension is appended; the file's own name is returned whenever it is enough.
 */
export function languageNameFor(fileName: string, format: string, extension: string): string {
  if (format === 'json' && (extension === 'jsonc' || extension === 'json5')) return `${fileName}.js`;
  // `.text` would be read as LaTeX.
  if (format === 'plain' && extension === 'text') return `${fileName}.txt`;
  const rule = KNOWN_BY_FORMAT[format];
  if (rule) return rule.known.includes(extension) ? fileName : `${fileName}.${rule.fallback}`;
  const alias = format === 'code' ? CODE_ALIASES[extension] : undefined;
  return alias ? `${fileName}.${alias}` : fileName;
}
