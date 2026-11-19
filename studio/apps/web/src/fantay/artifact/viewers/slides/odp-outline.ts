// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts @ c5e6b24f (MIT): the
// bounded XML reader (`parseXml`, `find`, `text`: no DTD, depth and node caps, namespace prefixes
// normalised) and the walk over an OpenDocument presentation's `draw:page` elements.
// Changed here: the archive is read with fflate instead of JSZip and only the two parts needed are
// inflated; the result is a text outline (title, paragraphs with list levels, tables, notes, hidden
// slides, page size) instead of HTML; entities are decoded without the `entities` package.
//
// An OpenDocument presentation (.odp) is not drawn here: no maintained renderer exists. Its text is
// read so the file still opens to something a person can use.
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { unzipSync } from 'fflate';

import { outlineSlide, type SlideTextItem } from './deck-outline';
import type { DeckFailure, DeckInfo, DeckSlide, OutlineParagraph } from './protocol';

const MAX_XML_BYTES = 8 * 1024 * 1024;
const MAX_NODES = 200_000;
const MAX_DEPTH = 100;
const MAX_SLIDES = 2000;
const MAX_PARAGRAPH_CHARS = 4000;
const MAX_SLIDE_PARAGRAPHS = 300;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 16;
const MAX_NOTES_CHARS = 8000;
const MAX_DECK_CHARS = 600_000;

export class OdpError extends Error {
  constructor(readonly failure: DeckFailure) {
    super(failure);
  }
}

// `text` and `attrs` hold decoded values: escaped text is decoded once, CDATA stays literal.
interface XmlNode {
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
  text: string;
}
type OrderedXml = { [key: string]: OrderedXml[] | Record<string, string> | string };

const NAMESPACE_PREFIXES: Record<string, string> = {
  'urn:oasis:names:tc:opendocument:xmlns:office:1.0': 'office',
  'urn:oasis:names:tc:opendocument:xmlns:table:1.0': 'table',
  'urn:oasis:names:tc:opendocument:xmlns:text:1.0': 'text',
  'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0': 'draw',
  'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0': 'presentation',
  'urn:oasis:names:tc:opendocument:xmlns:style:1.0': 'style',
  'urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0': 'svg',
  'urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0': 'fo',
};

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** XML's five named entities and numeric references. A DTD is refused, so no others can be defined. */
export function decodeXmlEntities(value: string): string {
  if (!value.includes('&')) return value;
  return value.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const code = body[1] === 'x' ? Number.parseInt(body.slice(2), 16) : Number.parseInt(body.slice(1), 10);
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return NAMED_ENTITIES[body] ?? whole;
  });
}

function parseXml(source: string): XmlNode {
  if (source.length > MAX_XML_BYTES || /<!\s*(DOCTYPE|ENTITY)/i.test(source) || XMLValidator.validate(source) !== true) {
    throw new OdpError('invalid');
  }
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    attributeNamePrefix: '',
    processEntities: false,
    trimValues: false,
    parseTagValue: false,
    cdataPropName: '#cdata',
  });
  const ordered = parser.parse(source) as OrderedXml[];
  let count = 0;
  const convert = (items: OrderedXml[], depth: number, inherited: Record<string, string>): XmlNode[] => {
    if (depth > MAX_DEPTH) throw new OdpError('too-large');
    return items.map((item) => {
      count += 1;
      if (count > MAX_NODES) throw new OdpError('too-large');
      const name = Object.keys(item).find((key) => key !== ':@') ?? '#text';
      const value = item[name];
      if (name === '#cdata') {
        const literal = Array.isArray(value) ? value.map((part) => (typeof part['#text'] === 'string' ? part['#text'] : '')).join('') : '';
        return { name: '#text', attrs: {}, children: [], text: literal };
      }
      const attrs = Object.fromEntries(
        Object.entries((item[':@'] ?? {}) as Record<string, string>).map(([key, raw]) => [key, decodeXmlEntities(String(raw))]),
      );
      const namespaces = Object.create(inherited) as Record<string, string>;
      for (const [key, uri] of Object.entries(attrs)) {
        if (key === 'xmlns') namespaces[''] = uri;
        else if (key.startsWith('xmlns:')) namespaces[key.slice(6)] = uri;
      }
      // Whatever prefix the file chose, a name comes out under the prefix the specification uses.
      const expanded = (raw: string, attribute = false): string => {
        if (raw.startsWith('#')) return raw;
        const colon = raw.indexOf(':');
        if (colon < 0 && attribute) return raw;
        const uri = namespaces[colon < 0 ? '' : raw.slice(0, colon)];
        if (!uri) return raw;
        const prefix = Object.hasOwn(NAMESPACE_PREFIXES, uri) ? NAMESPACE_PREFIXES[uri] : undefined;
        const local = raw.slice(colon + 1);
        return prefix === undefined ? `{${uri}}${local}` : `${prefix}:${local}`;
      };
      return {
        name: expanded(name),
        attrs: Object.fromEntries(Object.entries(attrs).map(([key, raw]) => [expanded(key, true), raw])),
        children: Array.isArray(value) ? convert(value, depth + 1, namespaces) : [],
        text: typeof value === 'string' ? decodeXmlEntities(value) : '',
      };
    });
  };
  return { name: 'root', attrs: {}, children: convert(ordered, 0, Object.create(null) as Record<string, string>), text: '' };
}

/** Every descendant with that name, in document order; `skip` prunes a subtree. */
function find(node: XmlNode, name: string, skip?: string): XmlNode[] {
  return node.children.flatMap((child) => (child.name === skip ? [] : child.name === name ? [child] : find(child, name, skip)));
}

function repeat(value: string | undefined, max: number): number {
  const count = Number(value ?? 1);
  return Number.isSafeInteger(count) && count >= 1 ? Math.min(count, max) : 1;
}

function text(node: XmlNode): string {
  if (node.name === 'office:annotation') return '';
  if (node.name === 'text:s') return ' '.repeat(repeat(node.attrs['text:c'], 100));
  if (node.name === 'text:tab') return '\t';
  if (node.name === 'text:line-break') return '\n';
  return node.name === '#text' ? node.text : node.children.map(text).join('');
}

/** "28cm", "11in", "720pt" → CSS pixels; 0 when the unit is unknown. */
export function lengthToPx(value: string | undefined): number {
  const match = /^\s*(-?[0-9]*\.?[0-9]+)\s*(cm|mm|in|pt|px|pc)\s*$/.exec(value ?? '');
  if (!match) return 0;
  const amount = Number(match[1]);
  const perUnit: Record<string, number> = { cm: 96 / 2.54, mm: 96 / 25.4, in: 96, pt: 96 / 72, px: 1, pc: 16 };
  return amount * (perUnit[match[2] ?? ''] ?? 0);
}

/** Paragraphs under a node, each with the depth of the list it sits in. */
function paragraphs(node: XmlNode, depth = 0, out: OutlineParagraph[] = []): OutlineParagraph[] {
  for (const child of node.children) {
    if (out.length >= MAX_SLIDE_PARAGRAPHS) break;
    if (child.name === 'presentation:notes' || child.name === 'office:annotation' || child.name === 'table:table') continue;
    if (child.name === 'text:p' || child.name === 'text:h') {
      const value = text(child).trim();
      if (value) out.push({ text: value.slice(0, MAX_PARAGRAPH_CHARS), level: Math.max(0, depth - 1) });
    } else {
      paragraphs(child, child.name === 'text:list' ? depth + 1 : depth, out);
    }
  }
  return out;
}

function tableRows(table: XmlNode): string[][] {
  const rows: string[][] = [];
  for (const row of find(table, 'table:table-row')) {
    if (rows.length >= MAX_TABLE_ROWS) break;
    const cells: string[] = [];
    for (const cell of row.children) {
      if (cell.name !== 'table:table-cell' && cell.name !== 'table:covered-table-cell') continue;
      const value = find(cell, 'text:p', 'office:annotation').map(text).join('\n').trim().slice(0, 400);
      const count = repeat(cell.attrs['table:number-columns-repeated'], MAX_TABLE_COLUMNS);
      for (let index = 0; index < count && cells.length < MAX_TABLE_COLUMNS; index += 1) cells.push(value);
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length > 0) rows.push(cells);
  }
  return rows;
}

const FURNITURE = new Set(['date-time', 'footer', 'header', 'page-number', 'notes', 'handout']);

interface PageContext {
  width: number;
  height: number;
  /** Font size in points by text or paragraph style name. */
  sizes: ReadonlyMap<string, number>;
}

function fontSize(node: XmlNode, context: PageContext): number {
  const own = context.sizes.get(node.attrs['text:style-name'] ?? '') ?? context.sizes.get(node.attrs['draw:text-style-name'] ?? '');
  if (own) return own;
  for (const child of node.children) {
    const size = fontSize(child, context);
    if (size) return size;
  }
  return 0;
}

function readPage(page: XmlNode, context: PageContext, spend: (chars: number) => boolean): { title: string | null; items: SlideTextItem[]; notes: string } {
  let title: string | null = null;
  const items: SlideTextItem[] = [];
  const visit = (node: XmlNode): void => {
    for (const shape of node.children) {
      if (shape.name === 'presentation:notes' || shape.name === 'office:annotation' || shape.name === '#text') continue;
      if (shape.name === 'draw:g') {
        visit(shape);
        continue;
      }
      const role = shape.attrs['presentation:class'] ?? '';
      if (FURNITURE.has(role)) continue;
      const x = context.width > 0 ? lengthToPx(shape.attrs['svg:x']) / context.width : null;
      const y = context.height > 0 ? lengthToPx(shape.attrs['svg:y']) / context.height : null;
      for (const table of find(shape, 'table:table')) {
        const rows = tableRows(table);
        if (rows.length > 0 && spend(rows.reduce((sum, row) => sum + row.join('').length, 0))) items.push({ block: { kind: 'table', rows }, x, y, size: 0 });
      }
      const body = paragraphs(shape);
      if (body.length === 0) continue;
      if (role === 'title' && title === null) {
        title = body.map((paragraph) => paragraph.text).join(' ');
        continue;
      }
      if (spend(body.reduce((sum, paragraph) => sum + paragraph.text.length, 0))) {
        items.push({ block: { kind: 'text', paragraphs: body }, x, y, size: fontSize(shape, context) });
      }
    }
  };
  visit(page);
  const notes = find(page, 'presentation:notes')
    .flatMap((node) => paragraphs(node))
    .map((paragraph) => paragraph.text)
    .join('\n')
    .slice(0, MAX_NOTES_CHARS);
  return { title, items, notes };
}

function unzipParts(bytes: ArrayBuffer): { content: string; styles: string } {
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        if (file.name !== 'content.xml' && file.name !== 'styles.xml') return false;
        // The declared size is checked before anything is inflated.
        if (file.originalSize > MAX_XML_BYTES) throw new OdpError('too-large');
        return true;
      },
    });
  } catch (error) {
    throw error instanceof OdpError ? error : new OdpError('invalid');
  }
  const content = files['content.xml'];
  // An encrypted document keeps the part but its bytes are not XML; `parseXml` refuses it.
  if (!content) throw new OdpError('invalid');
  const decoder = new TextDecoder('utf-8', { fatal: false });
  const styles = files['styles.xml'];
  return { content: decoder.decode(content), styles: styles ? decoder.decode(styles) : '' };
}

function styleSizes(roots: readonly XmlNode[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const root of roots) {
    for (const style of find(root, 'style:style')) {
      const name = style.attrs['style:name'];
      const size = find(style, 'style:text-properties')[0]?.attrs['fo:font-size'];
      const points = lengthToPx(size) * 0.75;
      if (name && points > 0) sizes.set(name, points);
    }
  }
  return sizes;
}

/** Reads an .odp's text. Throws `OdpError` when it is not a readable OpenDocument presentation. */
export function openOdp(bytes: ArrayBuffer): DeckInfo {
  const parts = unzipParts(bytes);
  const content = parseXml(parts.content);
  let styles: XmlNode | null = null;
  try {
    styles = parts.styles ? parseXml(parts.styles) : null;
  } catch {
    // The page size and font sizes are a nicety; the outline does not depend on them.
    styles = null;
  }

  const pages = find(content, 'draw:page');
  if (pages.length === 0) throw new OdpError(find(content, 'office:presentation').length > 0 ? 'empty' : 'invalid');
  if (pages.length > MAX_SLIDES) throw new OdpError('too-large');

  // Page size: the layout the first master page names (in styles.xml, or inline in a flat file).
  const roots = styles ? [content, styles] : [content];
  const layouts = roots.flatMap((root) => find(root, 'style:page-layout'));
  const masterLayout = roots.flatMap((root) => find(root, 'style:master-page'))[0]?.attrs['style:page-layout-name'];
  const layout = layouts.find((entry) => entry.attrs['style:name'] === masterLayout) ?? layouts[0];
  const properties = layout ? find(layout, 'style:page-layout-properties')[0] : undefined;
  const width = lengthToPx(properties?.attrs['fo:page-width']);
  const height = lengthToPx(properties?.attrs['fo:page-height']);

  // A slide is hidden through its drawing-page style.
  const hiddenStyles = new Set(
    find(content, 'style:style')
      .filter((style) => find(style, 'style:drawing-page-properties').some((entry) => entry.attrs['presentation:visibility'] === 'hidden'))
      .map((style) => style.attrs['style:name'] ?? ''),
  );

  const context: PageContext = { width, height, sizes: styleSizes(roots) };
  let budget = MAX_DECK_CHARS;
  let outlineCut = false;
  const spend = (chars: number): boolean => {
    if (budget <= 0) {
      outlineCut = true;
      return false;
    }
    budget -= chars;
    return true;
  };

  const slides: DeckSlide[] = pages.map((page) => {
    const { title, items, notes } = readPage(page, context, spend);
    return { ...outlineSlide(items, title), hidden: hiddenStyles.has(page.attrs['draw:style-name'] ?? ''), notes };
  });

  return { width, height, drawable: false, slides, outlineCut };
}
