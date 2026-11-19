// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts (`openDocument`,
// `odfHtml`, `repeat`) @ c5e6b24f (MIT): walking an OpenDocument text body into headings,
// paragraphs, lists, tables and embedded pictures, with repeated rows and cells capped.
// Changed here: the archive is read with fflate under size limits instead of JSZip; the document's
// styles are resolved (size, bold, italic, underline, alignment, page breaks, numbered lists) so the
// reading page can tell a heading from body text; links, heading levels, merged cells and the page
// count from `meta.xml` are kept; an encrypted file is reported as such; output is the shared block
// model and failures are `ReadError` codes.
//
// The file is untrusted: no script, object or form part is read, pictures are checked before they
// are passed on, and every count and size is capped. No DOM: worker and tests.
import { openArchive, type BoundedArchive } from './archive';
import { renderBlocks, type Align, type Block, type ParagraphBlock, type ReadingDocument, type Run, type TableCell } from './blocks';
import { imageDataAddress } from './images';
import { ReadError, archivePath, escapeHtml, findAll, findFirst, parseXml, type XmlNode } from './xml';

export const MAX_ODT_BYTES = 64 * 1024 * 1024;
const MAX_PART_BYTES = 8 * 1024 * 1024;
const MAX_PICTURE_BYTES = 6 * 1024 * 1024;
const MAX_PICTURES_TOTAL = 24 * 1024 * 1024;
const MAX_TABLE_ROWS = 2000;
const MAX_TABLE_COLUMNS = 64;
const MAX_BLOCKS = 100_000;

const ODF_PREFIXES: Readonly<Record<string, string>> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
  'urn:oasis:names:tc:opendocument:xmlns:meta:1.0': 'meta',
  'urn:oasis:names:tc:opendocument:xmlns:manifest:1.0': 'manifest',
  'http://www.w3.org/1999/xlink': 'xlink',
};

/** Parts of the body that are not reading text. */
const SKIPPED = new Set([
  'office:annotation',
  'office:annotation-end',
  'office:forms',
  'office:scripts',
  'text:tracked-changes',
  'text:sequence-decls',
  'text:variable-decls',
  'text:user-field-decls',
  'text:note-body',
  'draw:object',
  'draw:object-ole',
  'draw:plugin',
  'draw:applet',
  'draw:floating-frame',
]);

interface Look {
  size: number | null;
  bold: boolean | null;
  italic: boolean | null;
  underline: boolean | null;
  strike: boolean | null;
  script: -1 | 0 | 1 | null;
  align: Align | null;
  pageBreakBefore: boolean;
}

const NO_LOOK: Look = { size: null, bold: null, italic: null, underline: null, strike: null, script: null, align: null, pageBreakBefore: false };

interface StyleEntry {
  parent: string | null;
  own: Look;
}

function repeat(value: string | undefined, max: number): number {
  const count = Number(value ?? 1);
  if (!Number.isSafeInteger(count) || count < 1) throw new ReadError('invalid');
  return Math.min(count, max);
}

function points(value: string | undefined): number | null {
  const match = /^(\d+(?:\.\d+)?)(pt|px|in|cm|mm)$/.exec(value?.trim() ?? '');
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2];
  const size = unit === 'pt' ? amount : unit === 'px' ? amount * 0.75 : unit === 'in' ? amount * 72 : unit === 'cm' ? amount * 28.3465 : amount * 2.83465;
  return size >= 2 && size <= 400 ? Math.round(size * 2) / 2 : null;
}

function lookOf(style: XmlNode): Look {
  const look: Look = { ...NO_LOOK };
  for (const child of style.children) {
    if (child.name === 'style:text-properties') {
      const attrs = child.attrs;
      look.size = points(attrs['fo:font-size']) ?? look.size;
      if (attrs['fo:font-weight']) look.bold = attrs['fo:font-weight'] === 'bold' || Number(attrs['fo:font-weight']) >= 600;
      if (attrs['fo:font-style']) look.italic = attrs['fo:font-style'] === 'italic' || attrs['fo:font-style'] === 'oblique';
      if (attrs['style:text-underline-style']) look.underline = attrs['style:text-underline-style'] !== 'none';
      if (attrs['style:text-line-through-style']) look.strike = attrs['style:text-line-through-style'] !== 'none';
      const position = attrs['style:text-position'];
      if (position) look.script = position.startsWith('super') ? 1 : position.startsWith('sub') ? -1 : 0;
    } else if (child.name === 'style:paragraph-properties') {
      const align = child.attrs['fo:text-align'];
      if (align === 'center') look.align = 'center';
      else if (align === 'end' || align === 'right') look.align = 'right';
      else if (align === 'justify') look.align = 'justify';
      else if (align === 'start' || align === 'left') look.align = 'left';
      if (child.attrs['fo:break-before'] === 'page') look.pageBreakBefore = true;
    }
  }
  return look;
}

function merge(base: Look, over: Look): Look {
  return {
    size: over.size ?? base.size,
    bold: over.bold ?? base.bold,
    italic: over.italic ?? base.italic,
    underline: over.underline ?? base.underline,
    strike: over.strike ?? base.strike,
    script: over.script ?? base.script,
    align: over.align ?? base.align,
    // A page break belongs to the paragraph that states it, not to its children.
    pageBreakBefore: over.pageBreakBefore,
  };
}

class Styles {
  private readonly entries = new Map<string, StyleEntry>();
  private readonly resolved = new Map<string, Look>();
  private readonly orderedLists = new Set<string>();
  private defaults: Look = NO_LOOK;

  add(root: XmlNode): void {
    for (const style of findAll(root, 'style:default-style')) {
      if (style.attrs['style:family'] === 'paragraph') this.defaults = merge(this.defaults, lookOf(style));
    }
    for (const style of findAll(root, 'style:style')) {
      const name = style.attrs['style:name'];
      if (!name || this.entries.size > 20_000) continue;
      this.entries.set(name, { parent: style.attrs['style:parent-style-name'] ?? null, own: lookOf(style) });
    }
    for (const list of findAll(root, 'text:list-style')) {
      const name = list.attrs['style:name'];
      const first = list.children.find((child) => child.attrs['text:level'] === '1') ?? list.children[0];
      if (name && first?.name === 'text:list-level-style-number') this.orderedLists.add(name);
    }
  }

  /** What a named style states, through its parents. Says nothing about the document's defaults. */
  private own(name: string | undefined): Look {
    if (!name) return NO_LOOK;
    const known = this.resolved.get(name);
    if (known) return known;
    const chain: Look[] = [];
    let current: string | null = name;
    for (let depth = 0; current && depth < 12; depth += 1) {
      const entry = this.entries.get(current);
      if (!entry) break;
      chain.push(entry.own);
      current = entry.parent;
    }
    let look = NO_LOOK;
    for (const own of chain.reverse()) look = merge(look, own);
    this.resolved.set(name, look);
    return look;
  }

  /** A paragraph's look: the document's defaults, then its style. */
  paragraph(name: string | undefined): Look {
    return merge(this.defaults, this.own(name));
  }

  /** A span's look inside a paragraph: only what the span's style changes. */
  span(base: Look, name: string | undefined): Look {
    return { ...merge(base, this.own(name)), pageBreakBefore: false };
  }

  isOrdered(listStyle: string | undefined): boolean {
    return listStyle !== undefined && this.orderedLists.has(listStyle);
  }
}

function wrap(html: string, look: Look): string {
  let out = html;
  if (look.script) out = look.script > 0 ? `<sup>${out}</sup>` : `<sub>${out}</sub>`;
  if (look.strike) out = `<s>${out}</s>`;
  if (look.underline) out = `<u>${out}</u>`;
  if (look.italic) out = `<em>${out}</em>`;
  if (look.bold) out = `<strong>${out}</strong>`;
  return out;
}

class Reader {
  private pictureBytes = 0;
  private blockCount = 0;

  constructor(
    private readonly archive: BoundedArchive,
    private readonly styles: Styles,
  ) {}

  private picture(href: string | undefined): string | null {
    const path = archivePath('content.xml', href ?? '');
    if (!path) return null;
    const entry = this.archive.entries.get(this.archive.resolve(path) ?? '');
    if (!entry || entry.size > MAX_PICTURE_BYTES || this.pictureBytes + entry.size > MAX_PICTURES_TOTAL) return null;
    const address = imageDataAddress(path, this.archive.read(path, MAX_PICTURE_BYTES));
    if (address) this.pictureBytes += entry.size;
    return address;
  }

  /** The inline content of a paragraph as runs. */
  private inline(node: XmlNode, look: Look, runs: Run[]): void {
    const text = (value: string): void => {
      if (value === '') return;
      runs.push({ html: wrap(escapeHtml(value), look), chars: value.length, size: look.size, bold: look.bold === true });
    };
    const raw = (html: string): void => {
      runs.push({ html, chars: 0, size: look.size, bold: look.bold === true });
    };
    for (const child of node.children) {
      const name = child.name;
      if (SKIPPED.has(name)) continue;
      if (name === '#text') text(child.text);
      else if (name === 'text:s') text(` ${' '.repeat(repeat(child.attrs['text:c'], 100) - 1)}`);
      else if (name === 'text:tab') text(runs.length === 0 ? ' ' : ' ');
      else if (name === 'text:line-break') raw('<br>');
      else if (name === 'text:span') this.inline(child, this.styles.span(look, child.attrs['text:style-name']), runs);
      else if (name === 'text:a') {
        const href = child.attrs['xlink:href'] ?? '';
        if (/^(?:https?:|mailto:)/i.test(href)) {
          const inner: Run[] = [];
          this.inline(child, look, inner);
          const chars = inner.reduce((sum, run) => sum + run.chars, 0);
          runs.push({ html: `<a href="${escapeHtml(href)}">${inner.map((run) => run.html).join('')}</a>`, chars, size: look.size, bold: look.bold === true });
        } else this.inline(child, look, runs);
      } else if (name === 'draw:image') {
        const address = this.picture(child.attrs['xlink:href']);
        if (address) raw(`<img src="${address}" alt="">`);
      } else if (name === 'text:note') {
        const citation = findFirst(child, 'text:note-citation');
        if (citation) raw(`<sup>${escapeHtml(citation.children.map((part) => part.text).join(''))}</sup>`);
      } else this.inline(child, look, runs);
    }
  }

  private paragraph(node: XmlNode): ParagraphBlock & { pageBreakBefore: boolean } {
    const look = this.styles.paragraph(node.attrs['text:style-name']);
    const runs: Run[] = [];
    this.inline(node, look, runs);
    const level = node.name === 'text:h' ? Number(node.attrs['text:outline-level'] ?? 1) : null;
    return {
      type: 'paragraph',
      runs,
      align: look.align,
      heading: level !== null && Number.isFinite(level) ? level : null,
      pageBreakBefore: look.pageBreakBefore,
    };
  }

  private table(node: XmlNode): Block {
    const rows: TableCell[][] = [];
    const visit = (parent: XmlNode): void => {
      for (const child of parent.children) {
        if (child.name === 'table:table-header-rows' || child.name === 'table:table-rows' || child.name === 'table:table-row-group') visit(child);
        else if (child.name === 'table:table-row') {
          const cells: TableCell[] = [];
          for (const cell of child.children) {
            if (cell.name !== 'table:table-cell') continue;
            const paragraphs: ParagraphBlock[] = [];
            for (const part of [...findAll(cell, 'text:p', 'office:annotation'), ...findAll(cell, 'text:h', 'office:annotation')]) {
              paragraphs.push(this.paragraph(part));
            }
            const built: TableCell = {
              paragraphs,
              colSpan: repeat(cell.attrs['table:number-columns-spanned'], MAX_TABLE_COLUMNS),
              rowSpan: repeat(cell.attrs['table:number-rows-spanned'], MAX_TABLE_ROWS),
            };
            const copies = repeat(cell.attrs['table:number-columns-repeated'], MAX_TABLE_COLUMNS);
            for (let index = 0; index < copies && cells.length < MAX_TABLE_COLUMNS; index += 1) cells.push(built);
          }
          const copies = repeat(child.attrs['table:number-rows-repeated'], MAX_TABLE_ROWS);
          for (let index = 0; index < copies && rows.length < MAX_TABLE_ROWS; index += 1) rows.push(cells);
        }
      }
    };
    visit(node);
    return { type: 'table', rows };
  }

  private list(node: XmlNode, inheritedOrdered: boolean, depth: number): Block {
    const styleName = node.attrs['text:style-name'];
    const ordered = styleName === undefined ? inheritedOrdered : this.styles.isOrdered(styleName);
    const items: Block[][] = [];
    for (const child of node.children) {
      if (child.name !== 'text:list-item' && child.name !== 'text:list-header') continue;
      const item: Block[] = [];
      this.blocks(child, item, ordered, depth + 1);
      items.push(item);
    }
    return { type: 'list', ordered, items };
  }

  blocks(parent: XmlNode, out: Block[], listOrdered = false, depth = 0): void {
    if (depth > 40) throw new ReadError('too-large');
    for (const child of parent.children) {
      const name = child.name;
      if (SKIPPED.has(name)) continue;
      this.blockCount += 1;
      if (this.blockCount > MAX_BLOCKS) throw new ReadError('too-large');
      if (name === 'text:p' || name === 'text:h') {
        const { pageBreakBefore, ...paragraph } = this.paragraph(child);
        if (pageBreakBefore && out.length > 0) out.push({ type: 'page' });
        out.push(paragraph);
      } else if (name === 'text:list') out.push(this.list(child, listOrdered, depth));
      else if (name === 'table:table') out.push(this.table(child));
      else if (name === 'draw:frame') {
        const image = findFirst(child, 'draw:image');
        const address = image ? this.picture(image.attrs['xlink:href']) : null;
        if (address) out.push({ type: 'image', src: address });
        else this.blocks(child, out, listOrdered, depth + 1);
      } else if (name !== '#text') this.blocks(child, out, listOrdered, depth + 1);
    }
  }
}

function part(archive: BoundedArchive, path: string): XmlNode | null {
  const text = archive.readText(path, MAX_PART_BYTES);
  return text === null ? null : parseXml(text, ODF_PREFIXES);
}

export function readOdt(bytes: Uint8Array): ReadingDocument {
  if (bytes.byteLength > MAX_ODT_BYTES) throw new ReadError('too-large');
  const archive = openArchive(bytes, { maxEntries: 5000, maxTotalBytes: 400 * 1024 * 1024 });

  const manifest = archive.readText('META-INF/manifest.xml', MAX_PART_BYTES);
  if (manifest !== null && /<[\w:]*encryption-data\b/.test(manifest)) throw new ReadError('protected');

  if (!archive.resolve('content.xml')) throw new ReadError('invalid');
  const content = part(archive, 'content.xml');
  // Present but over the limit.
  if (!content) throw new ReadError('too-large');

  const styles = new Styles();
  try {
    const shared = part(archive, 'styles.xml');
    if (shared) styles.add(shared);
  } catch {
    // The document still reads without its named styles.
  }
  styles.add(content);

  const body = findFirst(content, 'office:text');
  if (!body) throw new ReadError('unsupported');
  const blocks: Block[] = [];
  new Reader(archive, styles).blocks(body, blocks);
  const html = renderBlocks(blocks);
  if (html === '') throw new ReadError('empty');

  let pages: number | null = null;
  try {
    const meta = part(archive, 'meta.xml');
    const statistic = meta ? findFirst(meta, 'meta:document-statistic') : null;
    const count = Number(statistic?.attrs['meta:page-count']);
    if (Number.isSafeInteger(count) && count > 0 && count < 100_000) pages = count;
  } catch {
    // The page count is optional.
  }
  return { html, pages };
}
