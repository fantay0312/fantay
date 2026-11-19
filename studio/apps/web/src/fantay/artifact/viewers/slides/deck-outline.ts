// SPDX-License-Identifier: AGPL-3.0-only
// Turning the pieces of text found on a slide into an outline a person can read: which piece is the
// title, what order the rest comes in, which pieces belong together, and how the whole deck reads
// as plain text for the clipboard.
// Pure: the worker feeds it what the PowerPoint model gives, tests feed it literals.
import type { DeckSlide, OutlineBlock, OutlineParagraph } from './protocol';

/** One text-bearing thing on a slide, before it is known to be a title or body. */
export interface SlideTextItem {
  block: OutlineBlock;
  /** Top-left corner as a share of the slide (0–1); null when the shape inherits its place. */
  x: number | null;
  y: number | null;
  /** Size as a share of the slide; omitted when unknown. */
  w?: number;
  h?: number;
  /** Font size of its first run in points; 0 when unknown or not text. */
  size: number;
}

/** A shape with no words of its own that other things sit on: a card, a panel, a table-like row. */
export interface SlideContainer {
  x: number;
  y: number;
  w: number;
  h: number;
}

const TITLE_MAX = 160;
/** A title sits in the upper part of a slide; text set large lower down is a figure or a pull quote. */
const TITLE_ZONE = 0.36;
/** A shape covering more of the slide than this is a background, not a card. */
const CONTAINER_MAX_AREA = 0.5;

function plain(paragraphs: readonly OutlineParagraph[]): string {
  return paragraphs
    .map((paragraph) => paragraph.text.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join(' ');
}

/** Words, not a bare figure: "01" and "12,480" are never a slide's title. */
function hasWords(text: string): boolean {
  return /\p{L}/u.test(text);
}

interface Placed {
  x: number | null;
  y: number | null;
}

function readingOrder(a: Placed, b: Placed): number {
  // Things with no place of their own (inherited placeholders) keep their document order, last.
  if (a.y === null || b.y === null) return a.y === b.y ? 0 : a.y === null ? 1 : -1;
  // Rows first: two boxes whose tops are within 4% of the slide's height are on one row.
  const row = Math.round(a.y / 0.04) - Math.round(b.y / 0.04);
  if (row !== 0) return row;
  return (a.x ?? 0) - (b.x ?? 0);
}

function inOrder<T extends Placed>(things: readonly T[]): T[] {
  return things
    .map((thing, index) => ({ thing, index }))
    .sort((a, b) => readingOrder(a.thing, b.thing) || a.index - b.index)
    .map((entry) => entry.thing);
}

/** The smallest card the item's centre lies on, or -1. */
function containerOf(item: SlideTextItem, containers: readonly SlideContainer[]): number {
  if (item.x === null || item.y === null) return -1;
  const cx = item.x + (item.w ?? 0) / 2;
  const cy = item.y + (item.h ?? 0) / 2;
  let best = -1;
  let bestArea = Infinity;
  containers.forEach((container, index) => {
    const area = container.w * container.h;
    if (area <= 0 || area > CONTAINER_MAX_AREA || area >= bestArea) return;
    if (cx < container.x || cx > container.x + container.w || cy < container.y || cy > container.y + container.h) return;
    best = index;
    bestArea = area;
  });
  return best;
}

/**
 * The body of a slide in reading order. Text that sits on the same card is read together, top to
 * bottom, as one block (a figure with its label and its change, a risk with its remedy), and the
 * cards themselves are read in rows. Everything else is read in rows, left to right.
 */
function arrange(items: readonly SlideTextItem[], containers: readonly SlideContainer[]): OutlineBlock[] {
  interface Unit extends Placed {
    items: SlideTextItem[];
    grouped: boolean;
  }
  const units: Unit[] = [];
  const byContainer = new Map<number, Unit>();
  for (const item of items) {
    const index = containerOf(item, containers);
    const container = containers[index];
    if (!container) {
      units.push({ x: item.x, y: item.y, items: [item], grouped: false });
      continue;
    }
    let unit = byContainer.get(index);
    if (!unit) {
      unit = { x: container.x, y: container.y, items: [], grouped: true };
      byContainer.set(index, unit);
      units.push(unit);
    }
    unit.items.push(item);
  }

  const blocks: OutlineBlock[] = [];
  for (const unit of inOrder(units)) {
    let run: OutlineParagraph[] | null = null;
    for (const item of inOrder(unit.items)) {
      if (unit.grouped && item.block.kind === 'text') {
        // Consecutive text on one card becomes one block.
        if (!run) {
          run = [];
          blocks.push({ kind: 'text', paragraphs: run });
        }
        run.push(...item.block.paragraphs);
        continue;
      }
      run = null;
      blocks.push(item.block);
    }
  }
  return blocks;
}

/**
 * Splits a slide's text into a title and the rest. `placeholderTitle` is the title placeholder's
 * text when the slide has one; decks written by generators usually have none, so the title is then
 * the largest wording in the upper part of the slide, or failing that the largest wording anywhere.
 */
export function outlineSlide(
  items: readonly SlideTextItem[],
  placeholderTitle: string | null,
  containers: readonly SlideContainer[] = [],
): Pick<DeckSlide, 'title' | 'blocks'> {
  const explicit = placeholderTitle?.replace(/\s+/g, ' ').trim() ?? '';
  if (explicit) return { title: explicit.slice(0, TITLE_MAX), blocks: arrange(items, containers) };

  const ordered = inOrder(items);
  const candidates = ordered.filter(
    (item) => item.block.kind === 'text' && hasWords(plain(item.block.paragraphs)) && plain(item.block.paragraphs).length <= TITLE_MAX,
  );
  const largest = (pool: readonly SlideTextItem[]): SlideTextItem | undefined =>
    // `ordered` is top to bottom, so the first of the largest is also the highest on the slide.
    pool.reduce<SlideTextItem | undefined>((best, item) => (best && best.size >= item.size ? best : item), undefined);
  const upper = candidates.filter((item) => item.y !== null && item.y <= TITLE_ZONE);
  const title = largest(upper) ?? largest(candidates);
  if (!title || title.block.kind !== 'text') return { title: '', blocks: arrange(items, containers) };

  return {
    title: plain(title.block.paragraphs),
    blocks: arrange(
      items.filter((item) => item !== title),
      containers,
    ),
  };
}

export interface OutlineTextLabels {
  /** "Notes" */
  notes: string;
  /** "Chart" */
  chart: string;
  /** Used when a slide has no title. */
  untitled: string;
}

/**
 * The deck as plain text for the clipboard: a numbered title per slide, body text indented by its
 * list level, table rows with tabs between cells (so they paste into a sheet or a table), notes last.
 */
export function outlineToText(slides: readonly DeckSlide[], labels: OutlineTextLabels): string {
  const parts: string[] = [];
  slides.forEach((slide, index) => {
    const lines: string[] = [`${index + 1}. ${slide.title || labels.untitled}`];
    for (const block of slide.blocks) {
      if (block.kind === 'text') {
        for (const paragraph of block.paragraphs) {
          const indent = '  '.repeat(Math.max(0, Math.min(8, paragraph.level)));
          for (const line of paragraph.text.split('\n')) if (line.trim()) lines.push(indent + line.trim());
        }
      } else if (block.kind === 'table') {
        for (const row of block.rows) lines.push(row.map((cell) => cell.replace(/\s+/g, ' ').trim()).join('\t'));
      } else {
        const names = [...block.series, ...block.categories].filter(Boolean);
        lines.push(names.length > 0 ? `${labels.chart}: ${names.join(', ')}` : labels.chart);
      }
    }
    if (slide.notes.trim()) lines.push(`${labels.notes}: ${slide.notes.trim()}`);
    parts.push(lines.join('\n'));
  });
  return parts.join('\n\n');
}
