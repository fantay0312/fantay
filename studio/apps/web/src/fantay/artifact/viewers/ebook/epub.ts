// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/extendedDocumentPreview.ts (`openEpub`) @ c5e6b24f
// (MIT): finding the package document through `META-INF/container.xml`, reading the manifest and the
// spine, and resolving chapter paths inside the archive.
// Changed here: the archive is read with fflate under size limits instead of JSZip; chapters are
// handed out one at a time as their own markup instead of all being flattened into one HTML string;
// the title, author and language are read; the table of contents comes from the EPUB 3 navigation
// document or the EPUB 2 NCX; copy-protected books are reported as such; failures are `ReadError`
// codes.
//
// The book is untrusted. Nothing in it is executed here or anywhere: this module only hands out
// text and bytes, and the viewer sanitises every chapter before showing it in a script-less frame.
// No DOM: it runs in a worker and in tests.
import { openArchive, type BoundedArchive } from '../document/archive';
import { ReadError, archivePath, decodeXmlEntities, findAll, findFirst, parseXml, textOf, type XmlNode } from '../document/xml';

export const MAX_EPUB_BYTES = 200 * 1024 * 1024;
const MAX_PACKAGE_BYTES = 8 * 1024 * 1024;
const MAX_CHAPTER_BYTES = 6 * 1024 * 1024;
const MAX_RESOURCE_BYTES = 16 * 1024 * 1024;
const MAX_CHAPTERS = 3000;
const MAX_TOC_ENTRIES = 6000;
const MAX_TOC_DEPTH = 8;
/** Chapters without a title in the contents are opened to look for one, up to this many. */
const MAX_TITLE_PROBES = 150;

const PACKAGE_PREFIXES: Readonly<Record<string, string>> = {
  'http://www.idpf.org/2007/opf': '',
  'http://purl.org/dc/elements/1.1/': 'dc',
  'urn:oasis:names:tc:opendocument:xmlns:container': '',
  'http://www.w3.org/1999/xhtml': '',
  'http://www.idpf.org/2007/ops': 'epub',
  'http://www.daisy.org/z3986/2005/ncx/': '',
};

/** Encryption that only hides embedded fonts; the text itself is readable. */
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

export interface BookChapter {
  /** Archive path of the chapter's document. */
  path: string;
  /** From the contents, or from the chapter's own heading; null when neither names it. */
  title: string | null;
}

export interface BookTocEntry {
  label: string;
  /** Index into `chapters`. */
  chapter: number;
  /** The `#fragment` inside the chapter, without the hash; '' for the chapter's start. */
  fragment: string;
  depth: number;
}

export interface BookInfo {
  title: string | null;
  author: string | null;
  language: string | null;
  chapters: BookChapter[];
  toc: BookTocEntry[];
}

export interface BookChapterContent {
  path: string;
  markup: string;
}

export interface BookResource {
  path: string;
  bytes: Uint8Array;
  mediaType: string;
}

export interface Book {
  info: BookInfo;
  /** The chapter's XHTML as written. Throws `ReadError`. */
  chapter(index: number): BookChapterContent;
  /** A picture or stylesheet of the book; null when absent or too large. */
  resource(path: string): BookResource | null;
}

const MEDIA_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  css: 'text/css',
};

function isProtected(archive: BoundedArchive): boolean {
  if (archive.resolve('META-INF/rights.xml') || archive.resolve('META-INF/sinf.xml')) return true;
  const encryption = archive.readText('META-INF/encryption.xml', MAX_PACKAGE_BYTES);
  if (encryption === null) return false;
  for (const match of encryption.matchAll(/<(?:[\w-]+:)?EncryptionMethod\b[^>]*\bAlgorithm\s*=\s*["']([^"']*)["']/g)) {
    if (!FONT_OBFUSCATION.has(match[1] ?? '')) return true;
  }
  return false;
}

function cleanLabel(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 200);
}

function splitTarget(base: string, href: string): { path: string; fragment: string } | null {
  const path = archivePath(base, href);
  if (path === null || path === '') return null;
  const hash = href.indexOf('#');
  let fragment = hash >= 0 ? href.slice(hash + 1) : '';
  try {
    fragment = decodeURIComponent(fragment);
  } catch {
    // Keep the fragment as written.
  }
  return { path, fragment };
}

interface RawTocEntry {
  label: string;
  path: string;
  fragment: string;
  depth: number;
}

/** EPUB 3: `<nav epub:type="toc"><ol><li><a href>…</a><ol>…</ol></li></ol></nav>`. */
function readNavigation(root: XmlNode, base: string): RawTocEntry[] {
  const navs = findAll(root, 'nav');
  const nav = navs.find((candidate) => (candidate.attrs['epub:type'] ?? '').split(/\s+/).includes('toc')) ?? navs[0];
  if (!nav) return [];
  const entries: RawTocEntry[] = [];
  const walk = (list: XmlNode, depth: number): void => {
    if (depth >= MAX_TOC_DEPTH) return;
    for (const item of list.children) {
      if (item.name !== 'li' || entries.length >= MAX_TOC_ENTRIES) continue;
      const link = item.children.find((child) => child.name === 'a');
      const label = cleanLabel(textOf(link ?? item.children.find((child) => child.name === 'span') ?? { name: '', attrs: {}, children: [], text: '' }));
      const target = link ? splitTarget(base, link.attrs.href ?? '') : null;
      if (target && label) entries.push({ label, ...target, depth });
      for (const child of item.children) if (child.name === 'ol') walk(child, depth + 1);
    }
  };
  for (const child of nav.children) if (child.name === 'ol') walk(child, 0);
  return entries;
}

/** EPUB 2: `<navMap><navPoint><navLabel><text>…</text></navLabel><content src/>…</navPoint></navMap>`. */
function readNcx(root: XmlNode, base: string): RawTocEntry[] {
  const map = findFirst(root, 'navMap');
  if (!map) return [];
  const entries: RawTocEntry[] = [];
  const walk = (parent: XmlNode, depth: number): void => {
    if (depth >= MAX_TOC_DEPTH) return;
    for (const point of parent.children) {
      if (point.name !== 'navPoint' || entries.length >= MAX_TOC_ENTRIES) continue;
      const labelNode = point.children.find((child) => child.name === 'navLabel');
      const content = point.children.find((child) => child.name === 'content');
      const label = cleanLabel(labelNode ? textOf(labelNode) : '');
      const target = content ? splitTarget(base, content.attrs.src ?? '') : null;
      if (target && label) entries.push({ label, ...target, depth });
      walk(point, depth + 1);
    }
  };
  walk(map, 0);
  return entries;
}

/** A chapter's own name: its first heading, else its `<title>` when that is not just the book's. */
export function chapterHeading(markup: string, bookTitle: string | null): string | null {
  const strip = (html: string): string => cleanLabel(decodeXmlEntities(html.replace(/<[^>]*>/g, ' ')));
  const heading = /<h[1-3]\b[^>]*>([\s\S]{1,600}?)<\/h[1-3]>/i.exec(markup);
  const fromHeading = heading ? strip(heading[1] ?? '') : '';
  if (fromHeading) return fromHeading;
  const title = /<title\b[^>]*>([^<]{1,300})<\/title>/i.exec(markup);
  const fromTitle = title ? strip(title[1] ?? '') : '';
  return fromTitle && fromTitle !== bookTitle ? fromTitle : null;
}

/** The contents entry the reader is in: the first one of the current chapter, else the last one before it. */
export function currentTocEntry(entries: readonly BookTocEntry[], chapter: number): number {
  let before = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index] as BookTocEntry;
    if (entry.chapter === chapter) return index;
    if (entry.chapter < chapter) before = index;
  }
  return before;
}

export function openBook(bytes: Uint8Array): Book {
  if (bytes.byteLength > MAX_EPUB_BYTES) throw new ReadError('too-large');
  const archive = openArchive(bytes, { maxEntries: 30_000, maxTotalBytes: 2 * 1024 * 1024 * 1024 });
  if (isProtected(archive)) throw new ReadError('protected');

  const containerText = archive.readText('META-INF/container.xml', MAX_PACKAGE_BYTES);
  if (containerText === null) throw new ReadError('invalid');
  const rootfile = findAll(parseXml(containerText, PACKAGE_PREFIXES), 'rootfile')[0]?.attrs['full-path'];
  const packagePath = rootfile ? archive.resolve(rootfile) : null;
  if (!packagePath) throw new ReadError('invalid');
  const packageText = archive.readText(packagePath, MAX_PACKAGE_BYTES);
  if (packageText === null) throw new ReadError('too-large');
  const root = parseXml(packageText, PACKAGE_PREFIXES);

  // ── metadata ────────────────────────────────────────────────────────────────────────────────
  const metadata = findFirst(root, 'metadata');
  const meta = (name: string): string[] =>
    (metadata ? findAll(metadata, name) : []).map((node) => cleanLabel(textOf(node))).filter((value) => value !== '');
  const title = meta('dc:title')[0] ?? null;
  const authors = meta('dc:creator').slice(0, 3);
  const language = meta('dc:language')[0] ?? null;

  // ── manifest and spine ──────────────────────────────────────────────────────────────────────
  interface ManifestItem {
    path: string;
    mediaType: string;
    properties: string[];
  }
  const manifest = new Map<string, ManifestItem>();
  const mediaTypeByPath = new Map<string, string>();
  for (const item of findAll(root, 'item')) {
    const id = item.attrs.id;
    const path = archivePath(packagePath, item.attrs.href ?? '');
    if (!id || !path) continue;
    const resolved = archive.resolve(path) ?? path;
    const entry = { path: resolved, mediaType: item.attrs['media-type'] ?? '', properties: (item.attrs.properties ?? '').split(/\s+/).filter(Boolean) };
    manifest.set(id, entry);
    mediaTypeByPath.set(resolved, entry.mediaType);
  }

  const spine = findFirst(root, 'spine');
  const chapters: BookChapter[] = [];
  const chapterByPath = new Map<string, number>();
  for (const itemref of spine ? findAll(spine, 'itemref') : []) {
    if (chapters.length >= MAX_CHAPTERS) break;
    const item = manifest.get(itemref.attrs.idref ?? '');
    if (!item || !archive.entries.has(item.path)) continue;
    const isMarkup = item.mediaType === 'application/xhtml+xml' || item.mediaType === 'text/html' || /\.x?html?$/i.test(item.path);
    if (!isMarkup || chapterByPath.has(item.path)) continue;
    chapterByPath.set(item.path, chapters.length);
    chapters.push({ path: item.path, title: null });
  }
  if (chapters.length === 0) throw new ReadError('empty');

  // ── contents ────────────────────────────────────────────────────────────────────────────────
  let raw: RawTocEntry[] = [];
  const navigation = [...manifest.values()].find((item) => item.properties.includes('nav'));
  if (navigation) {
    try {
      const text = archive.readText(navigation.path, MAX_PACKAGE_BYTES);
      if (text !== null) raw = readNavigation(parseXml(text, PACKAGE_PREFIXES), navigation.path);
    } catch {
      // Fall through to the NCX.
    }
  }
  if (raw.length === 0) {
    const ncx = manifest.get(spine?.attrs.toc ?? '') ?? [...manifest.values()].find((item) => item.mediaType === 'application/x-dtbncx+xml');
    if (ncx) {
      try {
        const text = archive.readText(ncx.path, MAX_PACKAGE_BYTES);
        if (text !== null) raw = readNcx(parseXml(text, PACKAGE_PREFIXES), ncx.path);
      } catch {
        // A book without usable contents still reads chapter by chapter.
      }
    }
  }
  const toc: BookTocEntry[] = [];
  for (const entry of raw) {
    const chapter = chapterByPath.get(archive.resolve(entry.path) ?? entry.path);
    if (chapter === undefined) continue;
    toc.push({ label: entry.label, chapter, fragment: entry.fragment, depth: entry.depth });
    // The first entry that points into a chapter names it.
    const target = chapters[chapter];
    if (target && target.title === null) target.title = entry.label;
  }

  // Chapters the contents do not name: look inside for a heading.
  let probes = 0;
  for (const chapter of chapters) {
    if (chapter.title !== null) continue;
    if (probes >= MAX_TITLE_PROBES) break;
    probes += 1;
    const markup = archive.readText(chapter.path, MAX_CHAPTER_BYTES);
    if (markup !== null) chapter.title = chapterHeading(markup.slice(0, 200_000), title);
  }

  return {
    info: { title, author: authors.length > 0 ? authors.join(', ') : null, language, chapters, toc },
    chapter(index) {
      const chapter = chapters[index];
      if (!chapter) throw new ReadError('invalid');
      const entry = archive.entries.get(chapter.path);
      if (entry && entry.size > MAX_CHAPTER_BYTES) throw new ReadError('too-large');
      const markup = archive.readText(chapter.path, MAX_CHAPTER_BYTES);
      if (markup === null) throw new ReadError('invalid');
      return { path: chapter.path, markup };
    },
    resource(path) {
      const name = archive.resolve(path);
      if (!name) return null;
      const data = archive.read(name, MAX_RESOURCE_BYTES);
      if (!data) return null;
      const mediaType = mediaTypeByPath.get(name) || MEDIA_TYPES[name.split('.').pop()?.toLowerCase() ?? ''] || 'application/octet-stream';
      return { path, bytes: data, mediaType };
    },
  };
}
