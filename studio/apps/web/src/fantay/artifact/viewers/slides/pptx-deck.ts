// SPDX-License-Identifier: AGPL-3.0-only
// One open PowerPoint deck, inside the worker: its slides as SVG documents and its text as an
// outline. The model comes from `@office-kit/pptx`, the drawing from `@office-kit/pptx-preview`.
// The file is untrusted: the archive is opened with caps on entries and expanded size, nothing in
// it is executed (macros and embedded objects are never read), and the SVG that comes out is only
// ever shown through an `<img>`.
import { renderSlideToSvg } from '@office-kit/pptx-preview';

import { outlineSlide, type SlideContainer, type SlideTextItem } from './deck-outline';
import {
  emu,
  getParagraphLevel,
  getParagraphPropertiesEffective,
  getShapeBounds,
  getShapeChartCategories,
  getShapeChartSeriesNames,
  getShapeKind,
  getShapeParagraphCount,
  getShapeParagraphElements,
  getShapePlaceholderType,
  getShapeRunFormatEffective,
  getSlideLayout,
  getSlideLayoutShapes,
  getSlideMasterPartName,
  getSlideMasterShapes,
  getSlideNotes,
  getSlideShapes,
  getSlideSize,
  getSlideTitle,
  getSlides,
  getTableCellText,
  getTableCells,
  getTableSize,
  getTableStyleId,
  hasShapeText,
  isChartShape,
  isShapeHidden,
  isShapePlaceholder,
  isShapeTextBox,
  isSlideHidden,
  isTableShape,
  loadPresentation,
  readPackagePart,
  setParagraphAlignment,
  setShapeBounds,
  setTableStyleId,
  type PresentationData,
  type SlideData,
  type SlideShapeData,
} from './pptx-core';
import type { DeckFailure, DeckInfo, DeckSlide, OutlineParagraph, UnsupportedCount } from './protocol';
import { countUnsupported } from './slide-svg';

const EMU_PER_PX = 9525;
/** PowerPoint's own default slide (10 × 7.5 in) for a file that states no size. */
const DEFAULT_SIZE = { width: 9_144_000, height: 6_858_000 };

/** Archive caps, checked against the directory before anything is inflated. */
const LIMITS = {
  maxEntries: 6000,
  maxTotalUncompressedBytes: 400 * 1024 * 1024,
  maxXmlPartBytes: 32 * 1024 * 1024,
  maxTotalXmlBytes: 160 * 1024 * 1024,
};
const MAX_SLIDES = 2000;

/** Outline caps: a preview carries what a person would read, not a whole data dump. */
const MAX_PARAGRAPH_CHARS = 4000;
const MAX_SLIDE_PARAGRAPHS = 300;
const MAX_TABLE_ROWS = 60;
const MAX_TABLE_COLUMNS = 16;
const MAX_CELL_CHARS = 400;
const MAX_NOTES_CHARS = 8000;
const MAX_DECK_CHARS = 600_000;

/** PowerPoint's built-in "No Style, No Grid" table style. */
const NO_TABLE_STYLE = '{2D5ABB26-0587-4C30-8999-92F81FD0307C}';

/** Placeholders that repeat on every slide and say nothing about it. */
const FURNITURE = new Set(['sldNum', 'dt', 'ftr', 'hdr']);

export class DeckError extends Error {
  constructor(readonly failure: DeckFailure) {
    super(failure);
  }
}

export interface OpenDeck {
  info: DeckInfo;
  /** One slide as an SVG document. Throws when the engine cannot lay the slide out. */
  render(index: number): { svg: string; unsupported: UnsupportedCount[] };
}

type Alignment = 'left' | 'center' | 'right' | 'justify';

const ALIGNMENT_OF_TOKEN: Record<string, Alignment> = { l: 'left', ctr: 'center', r: 'right', just: 'justify' };

/** The level-1 alignment a list style states, e.g. in `<p:otherStyle>`; null when it states none. */
function styleAlignment(xml: string, element: string): Alignment | null {
  const start = xml.indexOf(`<${element}`);
  const end = start < 0 ? -1 : xml.indexOf(`</${element}>`, start);
  if (start < 0 || end < 0) return null;
  const token = /<a:lvl1pPr\b[^>]*?\balgn="([A-Za-z]+)"/.exec(xml.slice(start, end))?.[1];
  return token ? (ALIGNMENT_OF_TOKEN[token] ?? null) : null;
}

function partText(pres: PresentationData, name: string): string {
  const bytes = readPackagePart(pres, name);
  // A style block lives in the first kilobytes of markup; a part this large is not worth scanning.
  if (!bytes || bytes.byteLength > 8 * 1024 * 1024) return '';
  return new TextDecoder().decode(bytes);
}

function paragraphsOf(shape: SlideShapeData): OutlineParagraph[] {
  const paragraphs: OutlineParagraph[] = [];
  const all = getShapeParagraphElements(shape);
  for (let index = 0; index < all.length && paragraphs.length < MAX_SLIDE_PARAGRAPHS; index += 1) {
    const text = (all[index] ?? [])
      .map((element) => (element.kind === 'br' ? '\n' : element.text))
      .join('')
      .replace(/\u000b/g, '\n')
      .trim();
    if (!text) continue;
    paragraphs.push({ text: text.slice(0, MAX_PARAGRAPH_CHARS), level: Math.max(0, getParagraphLevel(shape, index)) });
  }
  return paragraphs;
}

/** Attempts a read the model may refuse for an odd shape; such a shape just says nothing. */
function attempt<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export async function openPptx(bytes: ArrayBuffer): Promise<OpenDeck> {
  let pres: PresentationData;
  try {
    pres = await loadPresentation(new Uint8Array(bytes), { limits: LIMITS });
  } catch {
    // Damaged, encrypted (an encrypted deck is not a ZIP at all), over a cap, or not a deck.
    throw new DeckError('invalid');
  }
  let slides: ReadonlyArray<SlideData>;
  try {
    slides = getSlides(pres);
  } catch {
    throw new DeckError('invalid');
  }
  if (slides.length === 0) throw new DeckError('empty');
  if (slides.length > MAX_SLIDES) throw new DeckError('too-large');

  const size = attempt(() => getSlideSize(pres), null) ?? DEFAULT_SIZE;
  const slideWidth = size.width > 0 ? size.width : DEFAULT_SIZE.width;
  const slideHeight = size.height > 0 ? size.height : DEFAULT_SIZE.height;

  // ── outline ───────────────────────────────────────────────────────────────────────────────────
  let budget = MAX_DECK_CHARS;
  let outlineCut = false;
  const spend = (text: string): void => {
    budget -= text.length;
  };

  const readSlide = (slide: SlideData): DeckSlide => {
    const hidden = attempt(() => isSlideHidden(slide), false);
    const notes = (attempt(() => getSlideNotes(slide), null) ?? '').trim().slice(0, MAX_NOTES_CHARS);
    const placeholderTitle = attempt(() => getSlideTitle(slide), null);
    if (budget <= 0) {
      outlineCut = true;
      return { title: (placeholderTitle ?? '').trim(), hidden, notes: '', blocks: [] };
    }
    const items: SlideTextItem[] = [];
    const containers: SlideContainer[] = [];
    for (const shape of attempt(() => getSlideShapes(slide), [])) {
      if (budget <= 0) {
        outlineCut = true;
        break;
      }
      const kind = attempt(() => getShapeKind(shape), null);
      if (kind === null || kind === 'group' || kind === 'picture' || kind === 'connector') continue;
      if (attempt(() => isShapeHidden(shape), false)) continue;
      const bounds = attempt(() => getShapeBounds(shape), null);
      const x = bounds ? bounds.x / slideWidth : null;
      const y = bounds ? bounds.y / slideHeight : null;
      const extent = bounds ? { w: bounds.w / slideWidth, h: bounds.h / slideHeight } : {};

      if (kind === 'graphicFrame') {
        if (attempt(() => isTableShape(shape), false)) {
          const rows = attempt(() => getTableCells(shape), [])
            .slice(0, MAX_TABLE_ROWS)
            .map((row) => row.slice(0, MAX_TABLE_COLUMNS).map((cell) => attempt(() => getTableCellText(cell), '').trim().slice(0, MAX_CELL_CHARS)));
          if (rows.some((row) => row.some(Boolean))) {
            rows.forEach((row) => row.forEach(spend));
            items.push({ block: { kind: 'table', rows }, x, y, ...extent, size: 0 });
          }
        } else if (attempt(() => isChartShape(shape), false)) {
          const series = [...(attempt(() => getShapeChartSeriesNames(shape), null) ?? [])].slice(0, 12).map((name) => name.slice(0, 80));
          const categories = [...(attempt(() => getShapeChartCategories(shape), null) ?? [])].slice(0, 24).map((name) => String(name).slice(0, 80));
          items.push({ block: { kind: 'chart', series, categories }, x, y, ...extent, size: 0 });
        }
        continue;
      }

      const placeholder = attempt(() => getShapePlaceholderType(shape), null);
      if (placeholder !== null && FURNITURE.has(placeholder)) continue;
      // The title placeholder is the slide's title, not part of its body.
      if (placeholderTitle?.trim() && (placeholder === 'title' || placeholder === 'ctrTitle')) continue;
      if (!attempt(() => hasShapeText(shape), false)) {
        // A shape with no words may be the card other text sits on.
        if (bounds && bounds.w > 0 && bounds.h > 0 && containers.length < 400) {
          containers.push({ x: bounds.x / slideWidth, y: bounds.y / slideHeight, w: bounds.w / slideWidth, h: bounds.h / slideHeight });
        }
        continue;
      }
      const paragraphs = attempt(() => paragraphsOf(shape), []);
      if (paragraphs.length === 0) continue;
      paragraphs.forEach((paragraph) => spend(paragraph.text));
      const fontSize = attempt(() => getShapeRunFormatEffective(pres, shape, 0, 0).size, undefined) ?? 0;
      items.push({ block: { kind: 'text', paragraphs }, x, y, ...extent, size: fontSize });
    }
    return { ...outlineSlide(items, placeholderTitle, containers), hidden, notes };
  };

  const info: DeckInfo = {
    width: slideWidth / EMU_PER_PX,
    height: slideHeight / EMU_PER_PX,
    drawable: true,
    slides: slides.map(readSlide),
    outlineCut,
  };

  // ── drawing ───────────────────────────────────────────────────────────────────────────────────
  // Four places where the engine reads a deck differently from PowerPoint are corrected in the
  // in-memory model just before a slide is first drawn. The file is never changed. Decks written
  // by generators (PptxGenJS, which agents use) hit them on almost every slide.
  //
  //  1. Alignment. The engine centres the text of any shape that is not a text box when the
  //     paragraph names no alignment. PowerPoint lets such a paragraph inherit from the master's
  //     `otherStyle` (or the presentation's default text style), which is "left" in nearly every
  //     deck. The inherited value is written onto those paragraphs.
  //  2. Table size. The engine squeezes or stretches a table's rows into the frame's stated size.
  //     PowerPoint takes the row heights and column widths as written and lets the frame follow.
  //     The frame is given the size its rows and columns add up to.
  //  3. Table style. A table that names no style gets the deck's default style from the engine
  //     (blue banded rows). PowerPoint uses that default for tables it inserts, not for drawing
  //     one that names none: such a table has only the fills and borders its cells state. It is
  //     given the built-in "No Style, No Grid".
  //  4. Flat lines. The engine skips a shape whose width or height is zero; a horizontal or
  //     vertical line is exactly that. It is given the smallest extent there is (1 EMU).
  const settled = new WeakSet<object>();
  const masterAlignment = new Map<string, Alignment>();
  let deckAlignment: Alignment | undefined;

  const inheritedAlignment = (slide: SlideData): Alignment => {
    const master = attempt(() => getSlideMasterPartName(slide), null);
    if (master) {
      const known = masterAlignment.get(master);
      if (known) return known;
      const fromMaster = styleAlignment(partText(pres, master), 'p:otherStyle');
      if (fromMaster) {
        masterAlignment.set(master, fromMaster);
        return fromMaster;
      }
    }
    deckAlignment ??= styleAlignment(partText(pres, '/ppt/presentation.xml'), 'p:defaultTextStyle') ?? 'left';
    if (master) masterAlignment.set(master, deckAlignment);
    return deckAlignment;
  };

  const settleShape = (shape: SlideShapeData, alignment: Alignment): void => {
    const kind = getShapeKind(shape);
    if (kind === 'graphicFrame') {
      if (!isTableShape(shape)) return;
      const bounds = getShapeBounds(shape);
      const size = getTableSize(shape);
      if (!bounds || !(size.width > 0 && size.height > 0)) return;
      if (Math.abs(bounds.w - size.width) > EMU_PER_PX || Math.abs(bounds.h - size.height) > EMU_PER_PX) {
        setShapeBounds(shape, { x: bounds.x, y: bounds.y, w: size.width, h: size.height });
      }
      if (getTableStyleId(shape) === null) setTableStyleId(shape, NO_TABLE_STYLE);
      return;
    }
    if (kind !== 'shape') return;
    const bounds = getShapeBounds(shape);
    if (bounds && (bounds.w === 0) !== (bounds.h === 0)) {
      setShapeBounds(shape, { x: bounds.x, y: bounds.y, w: emu(Math.max(1, bounds.w)), h: emu(Math.max(1, bounds.h)) });
    }
    if (alignment === 'center' || isShapePlaceholder(shape) || isShapeTextBox(shape) || !hasShapeText(shape)) return;
    const count = getShapeParagraphCount(shape);
    for (let index = 0; index < count; index += 1) {
      const effective = getParagraphPropertiesEffective(pres, shape, index);
      if (effective.align === null) setParagraphAlignment(shape, index, effective.rtl ? 'right' : alignment);
    }
  };

  const settleShapes = (shapes: ReadonlyArray<SlideShapeData>, alignment: Alignment): void => {
    // A shape the model cannot read is left as the engine finds it.
    for (const shape of shapes) attempt(() => settleShape(shape, alignment), undefined);
  };

  const settleSlide = (slide: SlideData): void => {
    if (settled.has(slide)) return;
    settled.add(slide);
    const alignment = inheritedAlignment(slide);
    settleShapes(attempt(() => getSlideShapes(slide), []), alignment);
    const layout = attempt(() => getSlideLayout(slide), null);
    if (!layout || settled.has(layout)) return;
    settled.add(layout);
    settleShapes(attempt(() => getSlideLayoutShapes(pres, layout), []), alignment);
    settleShapes(attempt(() => getSlideMasterShapes(pres, layout), []), alignment);
  };

  return {
    info,
    render(index) {
      const slide = slides[index];
      if (!slide) throw new DeckError('invalid');
      settleSlide(slide);
      // Text is laid out by the browser (`<foreignObject>`), so words wrap with the fonts this
      // machine has and Chinese falls back to the system's own face.
      const svg = renderSlideToSvg(pres, slide);
      return { svg, unsupported: countUnsupported(svg) };
    },
  };
}
