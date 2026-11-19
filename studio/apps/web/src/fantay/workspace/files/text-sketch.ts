// SPDX-License-Identifier: AGPL-3.0-only
// Structural drawings of text files: the first kilobytes of a file turned into the few blocks a
// card can show (headings, lines, table cells, the outline of a web page). The card draws them as
// real text at a few pixels, so a file looks like itself without a renderer or a frame per card.
// Pure: strings in, plain data out; no DOM, so tests can read exactly what a card will draw.

export type SketchBlock =
  | { kind: 'heading'; text: string; level: 1 | 2 | 3 }
  | { kind: 'text'; text: string }
  | { kind: 'item'; text: string }
  | { kind: 'quote'; text: string }
  /** A line that keeps its spacing (code inside a document). */
  | { kind: 'code'; text: string }
  | { kind: 'rule' }
  /** A picture or an embed: drawn as a quiet block. */
  | { kind: 'image' }
  | { kind: 'button'; text: string };

const MAX_BLOCK_TEXT = 180;

function clip(text: string, max = MAX_BLOCK_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The text cut the daemon made can end mid-character; the broken tail is dropped. */
function trimCut(text: string): string {
  return text.replace(/�+$/u, '');
}

/**
 * True when the "text" is not text: a NUL byte, or so many undecodable bytes that it is another
 * encoding or a binary file with a text extension. Such a file gets a type tile, never garbage.
 */
export function looksBinary(text: string): boolean {
  const sample = trimCut(text).slice(0, 2048);
  if (sample.length === 0) return false;
  let broken = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code === 0) return true;
    if (code === 0xfffd || (code < 9 && code > 0) || (code > 13 && code < 32 && code !== 27)) broken += 1;
  }
  return broken / sample.length > 0.04;
}

/** The first lines of a text or code file, as they are: tabs widened, trailing space dropped. */
export function sketchLines(source: string, maxLines = 30, maxChars = 2000): string[] {
  const lines = trimCut(source).slice(0, maxChars).replace(/\r\n?/g, '\n').split('\n');
  // Leading blank lines would leave the page empty at the top.
  while (lines.length > 0 && lines[0]?.trim() === '') lines.shift();
  return lines.slice(0, maxLines).map((line) => line.replace(/\t/g, '  ').replace(/\s+$/u, ''));
}

function stripInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](\S[^*_]*\S|\S)[*_](?=\s|$|[.,;:!?，。；：！？])/g, '$1$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Markdown as the blocks of a small page. Front matter is skipped; inline marks are removed. */
export function sketchMarkdown(source: string, maxBlocks = 20): SketchBlock[] {
  const lines = trimCut(source).replace(/\r\n?/g, '\n').split('\n');
  const blocks: SketchBlock[] = [];
  let index = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.indexOf('---', 1);
    // Unclosed front matter means the cut fell inside it: nothing below is content yet.
    index = end === -1 ? lines.length : end + 1;
  }
  let paragraph = '';
  let fenced = false;
  const flush = (): void => {
    const text = stripInline(paragraph);
    if (text) blocks.push({ kind: 'text', text: clip(text) });
    paragraph = '';
  };

  for (; index < lines.length && blocks.length < maxBlocks; index += 1) {
    const raw = lines[index] ?? '';
    const line = raw.trim();
    if (/^(```|~~~)/.test(line)) {
      flush();
      fenced = !fenced;
      continue;
    }
    if (fenced) {
      blocks.push({ kind: 'code', text: clip(raw.replace(/\t/g, '  ').replace(/\s+$/u, ''), 80) });
      continue;
    }
    if (line === '') {
      flush();
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      flush();
      const text = stripInline(heading[2] ?? '');
      if (text) blocks.push({ kind: 'heading', text: clip(text, 80), level: Math.min(3, (heading[1] ?? '#').length) as 1 | 2 | 3 });
      continue;
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flush();
      blocks.push({ kind: 'rule' });
      continue;
    }
    if (/^!\[[^\]]*\]\([^)]*\)$/.test(line)) {
      flush();
      blocks.push({ kind: 'image' });
      continue;
    }
    const item = /^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (item) {
      flush();
      const text = stripInline(item[1] ?? '');
      if (text) blocks.push({ kind: 'item', text: clip(text, 120) });
      continue;
    }
    if (line.startsWith('>')) {
      flush();
      const text = stripInline(line.replace(/^>+\s?/, ''));
      if (text) blocks.push({ kind: 'quote', text: clip(text, 120) });
      continue;
    }
    // A table row reads as its cells.
    paragraph += `${paragraph ? ' ' : ''}${line.startsWith('|') ? line.replace(/\|/g, ' ').replace(/[-:]{3,}/g, '') : line}`;
  }
  flush();
  return blocks.slice(0, maxBlocks);
}

function sniffDelimiter(line: string): string {
  let best = ',';
  let bestCount = 0;
  for (const candidate of [',', ';', '\t', '|']) {
    const count = line.split(candidate).length - 1;
    if (count > bestCount) {
      best = candidate;
      bestCount = count;
    }
  }
  return best;
}

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quoted) {
      if (char === '"' && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === '') quoted = true;
    else if (char === delimiter) {
      cells.push(cell.trim());
      cell = '';
    } else cell += char;
  }
  cells.push(cell.trim());
  return cells;
}

/** The top-left corner of a delimited table. `delimiter` is sniffed from the first line when omitted. */
export function sketchTable(source: string, delimiter?: string, maxRows = 10, maxColumns = 5): string[][] {
  const lines = trimCut(source)
    .replace(/^﻿/u, '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => line.trim() !== '');
  if (lines.length === 0) return [];
  const separator = delimiter ?? sniffDelimiter(lines[0] ?? '');
  return lines
    .slice(0, maxRows)
    .map((line) => splitRow(line, separator).slice(0, maxColumns).map((cell) => clip(cell, 28)));
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', copy: '©', mdash: '—', ndash: '–', hellip: '…' };

function decodeEntities(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (match, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' || body[1] === 'X' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[body.toLowerCase()] ?? match;
  });
}

/** Removes `<tag …>…</tag>`; an opening tag the cut left unclosed takes the rest of the source. */
function dropElement(source: string, tag: string): string {
  return source.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?(?:</${tag}\\s*>|$)`, 'gi'), ' ');
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'main', 'header', 'footer', 'nav', 'aside', 'ul', 'ol', 'table', 'tr', 'td', 'th',
  'form', 'figure', 'figcaption', 'br', 'hr', 'label', 'details', 'summary', 'dl', 'dt', 'dd', 'pre', 'body', 'html',
]);
const PICTURE_TAGS = new Set(['img', 'picture', 'video', 'canvas', 'iframe', 'svg']);

export interface PageSketch {
  /** The document title, or its first heading. '' when the source names neither. */
  title: string;
  blocks: SketchBlock[];
}

/**
 * The outline of a web page from its source: the title, then headings, text, list items, buttons
 * and pictures in document order. Nothing is run or loaded; scripts and styles are thrown away.
 * A page that builds itself with script has no outline, and only its title comes back.
 */
export function sketchPage(source: string, maxBlocks = 16): PageSketch {
  let html = trimCut(source).replace(/<!--[\s\S]*?(?:-->|$)/g, ' ');
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html);
  let title = titleMatch ? decodeEntities(titleMatch[1] ?? '').replace(/\s+/g, ' ').trim() : '';
  for (const tag of ['script', 'style', 'template', 'noscript', 'head']) html = dropElement(html, tag);
  // Inline drawings read as one picture.
  html = html.replace(/<svg\b[^>]*>[\s\S]*?(?:<\/svg\s*>|$)/gi, '<svg>');
  // A tag the cut left open at the very end is not text.
  html = html.replace(/<[^>]*$/, '');

  const blocks: SketchBlock[] = [];
  let mode: 'text' | 'heading' | 'item' | 'button' | 'quote' = 'text';
  let level: 1 | 2 | 3 = 1;
  let buffer = '';
  const flush = (): void => {
    const text = decodeEntities(buffer).replace(/\s+/g, ' ').trim();
    buffer = '';
    if (!text) return;
    if (mode === 'heading') blocks.push({ kind: 'heading', text: clip(text, 80), level });
    else if (mode === 'item') blocks.push({ kind: 'item', text: clip(text, 120) });
    else if (mode === 'button') blocks.push({ kind: 'button', text: clip(text, 28) });
    else if (mode === 'quote') blocks.push({ kind: 'quote', text: clip(text, 120) });
    else blocks.push({ kind: 'text', text: clip(text) });
  };

  const token = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|([^<]+)/g;
  let match: RegExpExecArray | null;
  while ((match = token.exec(html)) !== null && blocks.length < maxBlocks) {
    if (match[3] !== undefined) {
      buffer += match[3];
      continue;
    }
    const closing = match[1] === '/';
    const tag = (match[2] ?? '').toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      flush();
      mode = closing ? 'text' : 'heading';
      level = Math.min(3, Number(heading[1])) as 1 | 2 | 3;
    } else if (tag === 'li') {
      flush();
      mode = closing ? 'text' : 'item';
    } else if (tag === 'button') {
      flush();
      mode = closing ? 'text' : 'button';
    } else if (tag === 'blockquote') {
      flush();
      mode = closing ? 'text' : 'quote';
    } else if (PICTURE_TAGS.has(tag)) {
      if (!closing) {
        flush();
        // Two pictures in a row draw as one block.
        if (blocks[blocks.length - 1]?.kind !== 'image') blocks.push({ kind: 'image' });
      }
    } else if (tag === 'hr') {
      flush();
      blocks.push({ kind: 'rule' });
    } else if (BLOCK_TAGS.has(tag)) {
      flush();
      if (mode !== 'text' && closing) mode = 'text';
    }
  }
  if (blocks.length < maxBlocks) flush();

  if (!title) {
    const first = blocks.find((block) => block.kind === 'heading');
    if (first && first.kind === 'heading') title = first.text;
  }
  // The title is drawn once: a page whose first heading repeats it does not say it twice.
  const lead = blocks[0];
  const rest = lead && lead.kind === 'heading' && lead.text === title ? blocks.slice(1) : blocks;
  return { title, blocks: rest.slice(0, maxBlocks) };
}
