// SPDX-License-Identifier: AGPL-3.0-only
// What a product card says about a file, decided without React or the DOM so the card and its tests
// share it: which layout a turn's products take, how a file is named and labelled, which facts are
// truthfully known, and the first lines a text document shows on its cover.
// Presentation only. Which files a turn produced is decided upstream (from tool calls, reconciled
// with the daemon's list); nothing here adds or removes a card.
import type { MotionArtifactPreview } from '@open-design/contracts';

import { formatDuration } from '../../../runtime/chat/format';
import { artifactExtension, artifactFileFamily } from '../file-family';

/** The four card kinds the chat already distinguishes; `doc` is everything without a picture. */
export type ArtifactProductKind = 'html' | 'image' | 'video' | 'doc';

/** One product of a turn. Structurally the chat's `ArtifactCardItem`, restated to avoid an import cycle. */
export interface ArtifactProduct {
  /** Project-relative path; also the key handed to open, share and export. */
  name: string;
  kind: ArtifactProductKind;
  /** The run is still writing this file: no preview, no actions, not clickable. */
  pending?: boolean;
  /** The turn is still running, so sharing waits even if this file is finished. */
  sharePending?: boolean;
  /** This turn's frozen picture: a page's first screen, a video's poster. */
  coverUrl?: string;
  /** This turn's immutable copy of an image; the card shows and exports it. */
  snapshotUrl?: string;
  /** Current file revision, for a live page preview. */
  revision?: string | number;
  motionPreview?: MotionArtifactPreview;
}

/** At most this many rows show before the "N more" control. */
export const MAX_VISIBLE_PRODUCTS = 6;

/** How a turn's products are laid out. */
export type CardsLayout = 'cover' | 'rows';

/**
 * One finished product is presented on a cover. While the turn is still running everything is a
 * row: a second file may follow, and a cover that collapses into a row moves the reader.
 */
export function cardsLayout(items: readonly ArtifactProduct[]): CardsLayout {
  const only = items.length === 1 ? items[0] : undefined;
  if (!only) return 'rows';
  return only.pending === true || only.sharePending === true ? 'rows' : 'cover';
}

/** The rows on show and how many are held back. */
export function visibleProducts<T>(items: readonly T[], expanded: boolean): { visible: readonly T[]; hidden: number } {
  if (expanded || items.length <= MAX_VISIBLE_PRODUCTS) return { visible: items, hidden: 0 };
  return { visible: items.slice(0, MAX_VISIBLE_PRODUCTS), hidden: items.length - MAX_VISIBLE_PRODUCTS };
}

/** `reports/2026/复盘.md` → base `复盘.md`, stem `复盘`, extension `.md`. */
export function productName(name: string): { base: string; stem: string; extension: string } {
  const base = name.split(/[\\/]/).filter(Boolean).pop() ?? name;
  const extension = artifactExtension(base);
  if (!extension || base.length <= extension.length + 1) return { base, stem: base, extension: '' };
  return { base, stem: base.slice(0, base.length - extension.length - 1), extension: `.${extension}` };
}

/** What the file is to a person. Each value has a translation under `artifact.cards.kind.*`. */
export type ProductLabel =
  | 'page'
  | 'image'
  | 'video'
  | 'document'
  | 'sheet'
  | 'slides'
  | 'code'
  | 'data'
  | 'text'
  | 'audio'
  | 'model'
  | 'archive'
  | 'font'
  | 'file';

const PAGE_EXTENSIONS: ReadonlySet<string> = new Set(['html', 'htm', 'xhtml']);
const MARKDOWN_EXTENSIONS: ReadonlySet<string> = new Set(['md', 'mdx', 'markdown', 'mdown', 'mkd', 'mkdn']);

export function productLabel(name: string, kind: ArtifactProductKind): ProductLabel {
  if (kind === 'html') return 'page';
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  const extension = artifactExtension(name);
  if (PAGE_EXTENSIONS.has(extension)) return 'page';
  // Markdown is a document to its reader, whatever the viewer that draws it.
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'document';
  const family = artifactFileFamily(name).family;
  return family === 'other' ? 'file' : family;
}

/** Which kind of preview the card draws. */
export type ProductFace = 'page' | 'image' | 'video' | 'document';

/**
 * The chat only calls a handful of extensions an image or a video. Anything else the browser can
 * decode by itself (BMP, ICO, M4V) still shows its own picture; the rest get the document cover.
 */
export function productFace(name: string, kind: ArtifactProductKind): ProductFace {
  if (kind === 'html') return 'page';
  if (kind === 'image') return 'image';
  if (kind === 'video') return 'video';
  const family = artifactFileFamily(name);
  if (family.viewer === 'image' && (family.format === 'native' || family.format === 'svg')) return 'image';
  if (family.viewer === 'video' && family.format === 'native') return 'video';
  return 'document';
}

/** Width over height of a cover's picture box. */
const COVER_RATIO = 16 / 10;

/**
 * How a picture or a clip sits in the cover. One whose shape is close to the box fills it: thin
 * bars above and below read as a mistake, and what is lost is a few percent at the edges. Any
 * other shape (a portrait poster, a wide banner) is shown whole.
 */
export function coverMediaFit(measure: ProductMeasure | undefined): 'contain' | 'cover' {
  if (!measure?.width || !measure.height) return 'contain';
  return Math.abs(measure.width / measure.height / COVER_RATIO - 1) <= 0.15 ? 'cover' : 'contain';
}

/** Vector and icon pictures are shown whole in a small tile; photographs fill it. */
export function tileImageFit(name: string): 'contain' | 'cover' {
  const extension = artifactExtension(name);
  return extension === 'svg' || extension === 'ico' || extension === 'cur' ? 'contain' : 'cover';
}

export interface ProductMeasure {
  /** Pixel size of the picture, read from the loaded preview. */
  width?: number;
  height?: number;
  /** Seconds, read from the loaded video. */
  duration?: number;
}

/**
 * The quiet second line, after the type label: only what is known to be true of what the card
 * shows. A picture says its pixel size, a clip its length, everything else its size on disk. A
 * frozen snapshot is not the file on disk, so it never borrows the file's size.
 */
export function productFacts(input: {
  face: ProductFace;
  measure?: ProductMeasure;
  /** Size on disk of the project's current file, already formatted; empty when it is not known. */
  size?: string;
  /** True when the card shows a frozen copy, not the current file. */
  snapshot?: boolean;
}): string[] {
  const { face, measure, size = '', snapshot = false } = input;
  const facts: string[] = [];
  const hasPixels = (face === 'image' || face === 'video') && !!measure?.width && !!measure.height;
  if (face === 'video' && measure?.duration !== undefined && Number.isFinite(measure.duration) && measure.duration > 0) {
    facts.push(formatDuration(measure.duration));
  } else if (hasPixels) {
    facts.push(`${measure?.width} × ${measure?.height}`);
  }
  if (size && !snapshot && !(face === 'image' && hasPixels)) facts.push(size);
  return facts;
}

// ── the text on a document cover ────────────────────────────────────────────────────────────────

/** Text files larger than this are not read for a cover. */
export const EXCERPT_MAX_BYTES = 256 * 1024;
const EXCERPT_SCAN_CHARS = 6000;
const EXCERPT_MAX_LINES = 9;
const EXCERPT_LINE_CHARS = 96;

/** How a file's first lines are set on its cover; null when it has no text to show. */
export type ExcerptStyle = 'markdown' | 'prose' | 'mono';

export function excerptStyle(name: string): ExcerptStyle | null {
  const extension = artifactExtension(name);
  if (MARKDOWN_EXTENSIONS.has(extension)) return 'markdown';
  const family = artifactFileFamily(name);
  if (family.viewer === 'text') return family.format === 'plain' || family.format === 'subtitle' ? 'prose' : 'mono';
  if (family.viewer === 'sheet' && (family.format === 'csv' || family.format === 'tsv')) return 'mono';
  if (family.viewer === 'diagram') return 'mono';
  return null;
}

/**
 * True when a document's cover will carry its first lines: the file is text, is in the project
 * list, and is small enough to read. The cover's height follows this, not the arrival of the text.
 */
export function coverReadsText(name: string, size: number | undefined): boolean {
  return size !== undefined && size > 0 && size <= EXCERPT_MAX_BYTES && excerptStyle(name) !== null;
}

export interface ExcerptLine {
  text: string;
  /** A heading inside the document: set a little firmer than the lines around it. */
  heading?: boolean;
}

export interface CoverExcerpt {
  /** The document's own first heading, when it opens with one. */
  title: string | null;
  lines: ExcerptLine[];
}

function clip(line: string): string {
  return line.length > EXCERPT_LINE_CHARS ? `${line.slice(0, EXCERPT_LINE_CHARS - 1).trimEnd()}…` : line;
}

/** Markdown marks removed, the words kept. */
function plainMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/(\*\*|__|~~)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1$2')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

function markdownExcerpt(source: string): CoverExcerpt {
  let lines = source.split('\n');
  // Front matter is metadata, not the document.
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((line, index) => index > 0 && index < 80 && line.trim() === '---');
    if (end > 0) lines = lines.slice(end + 1);
  }
  let title: string | null = null;
  const out: ExcerptLine[] = [];
  for (const raw of lines) {
    if (out.length >= EXCERPT_MAX_LINES) break;
    const line = raw.trim();
    if (!line) continue;
    if (/^(```|~~~)/.test(line)) continue;
    if (/^([-*_])(\s*\1){2,}$/.test(line)) continue;
    if (/^\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?$/.test(line)) continue;
    if (/^<!--/.test(line)) continue;

    const heading = /^#{1,6}\s+(.*?)\s*#*$/.exec(line);
    if (heading) {
      const text = plainMarkdown(heading[1] ?? '');
      if (!text) continue;
      if (title === null && out.length === 0) title = clip(text);
      else out.push({ text: clip(text), heading: true });
      continue;
    }
    let text = line.replace(/^(>\s?)+/, '');
    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(text);
    const bullet = /^[-*+]\s+(.*)$/.exec(text);
    if (task) text = `${task[1] === ' ' ? '☐' : '☑'} ${plainMarkdown(task[2] ?? '')}`;
    else if (bullet) text = `· ${plainMarkdown(bullet[1] ?? '')}`;
    else if (text.startsWith('|')) {
      text = text
        .split('|')
        .map((cell) => plainMarkdown(cell))
        .filter(Boolean)
        .join('  ·  ');
    } else text = plainMarkdown(text);
    if (text) out.push({ text: clip(text) });
  }
  return { title, lines: out };
}

/**
 * The first lines of a text file, for its cover. Markdown gives up its marks and offers its first
 * heading as the title; prose keeps its lines; code and data keep their indentation.
 */
export function coverExcerpt(text: string, style: ExcerptStyle): CoverExcerpt {
  const source = text.replace(/^﻿/, '').slice(0, EXCERPT_SCAN_CHARS).replace(/\r\n?/g, '\n');
  if (style === 'markdown') return markdownExcerpt(source);

  const out: ExcerptLine[] = [];
  let blank = false;
  for (const raw of source.split('\n')) {
    if (out.length >= EXCERPT_MAX_LINES) break;
    const line = (style === 'mono' ? raw.replace(/\t/g, '  ').trimEnd() : raw.trim());
    if (!line.trim()) {
      // Leading blank lines are dropped; a run of them inside the text counts once.
      blank = out.length > 0;
      continue;
    }
    if (blank && style === 'mono' && out.length < EXCERPT_MAX_LINES - 1) out.push({ text: '' });
    blank = false;
    out.push({ text: clip(line) });
  }
  return { title: null, lines: out };
}
