// SPDX-License-Identifier: AGPL-3.0-only
// What the RTF and OpenDocument readers produce, and how it becomes markup for the reading page.
// Both formats describe looks ("24 point, bold"), not structure ("a heading"), so structure is
// worked out here once: the size most of the text is set in is the body size, a short paragraph set
// clearly larger is a heading, and anything else keeps its size relative to the body. The readers
// only collect runs. Pure: no DOM, so it runs in the worker and in tests.
import { ReadError, escapeHtml } from './xml';

export type Align = 'left' | 'center' | 'right' | 'justify';

/** A stretch of text with one look. `html` is escaped text, already wrapped in `<strong>` and friends. */
export interface Run {
  html: string;
  /** Characters of visible text, for weighing sizes. */
  chars: number;
  /** Point size, when the document states one. */
  size: number | null;
  bold: boolean;
}

export interface ParagraphBlock {
  type: 'paragraph';
  runs: Run[];
  align: Align | null;
  /** A heading level the document states outright (OpenDocument `text:h`). */
  heading: number | null;
}

export interface TableBlock {
  type: 'table';
  /** Rows of cells; a cell is a list of paragraphs. */
  rows: TableCell[][];
}

export interface TableCell {
  paragraphs: ParagraphBlock[];
  colSpan: number;
  rowSpan: number;
}

export interface ListBlock {
  type: 'list';
  ordered: boolean;
  items: Block[][];
}

export interface ImageBlock {
  type: 'image';
  /** A `data:` address that already passed the size checks. */
  src: string;
}

export interface PageBreakBlock {
  type: 'page';
}

export type Block = ParagraphBlock | TableBlock | ListBlock | ImageBlock | PageBreakBlock;

export interface ReadingDocument {
  /** Markup for the reading page. Not yet sanitised: the viewer does that before showing it. */
  html: string;
  /** Explicit page breaks + 1, or null when the format has no pages of its own. */
  pages: number | null;
}

/** The rendered markup may not grow past this. */
export const MAX_MARKUP_CHARS = 8 * 1024 * 1024;
const DEFAULT_BODY_POINTS = 12;
/** A heading is short. */
const MAX_HEADING_CHARS = 160;

function walkParagraphs(blocks: readonly Block[], visit: (paragraph: ParagraphBlock) => void): void {
  for (const block of blocks) {
    if (block.type === 'paragraph') visit(block);
    else if (block.type === 'table') for (const row of block.rows) for (const cell of row) cell.paragraphs.forEach(visit);
    else if (block.type === 'list') for (const item of block.items) walkParagraphs(item, visit);
  }
}

/** The point size most of the text is set in. */
export function bodySize(blocks: readonly Block[]): number {
  const weight = new Map<number, number>();
  walkParagraphs(blocks, (paragraph) => {
    for (const run of paragraph.runs) {
      if (run.size !== null && run.chars > 0) weight.set(run.size, (weight.get(run.size) ?? 0) + run.chars);
    }
  });
  let best = DEFAULT_BODY_POINTS;
  let bestWeight = 0;
  for (const [size, chars] of weight) {
    if (chars > bestWeight) {
      best = size;
      bestWeight = chars;
    }
  }
  return best;
}

/** The heading level a paragraph reads as, or 0 for body text. */
export function headingLevel(paragraph: ParagraphBlock, body: number): number {
  if (paragraph.heading !== null) return Math.min(6, Math.max(1, paragraph.heading));
  const visible = paragraph.runs.filter((run) => run.chars > 0);
  const chars = visible.reduce((sum, run) => sum + run.chars, 0);
  if (chars === 0 || chars > MAX_HEADING_CHARS) return 0;
  // Every visible run has to be large: one big word in a sentence is emphasis, not a heading.
  let smallest = Infinity;
  for (const run of visible) smallest = Math.min(smallest, run.size ?? body);
  const ratio = smallest / body;
  if (ratio >= 1.7) return 1;
  if (ratio >= 1.3) return 2;
  if (ratio >= 1.12 && visible.every((run) => run.bold)) return 3;
  return 0;
}

function renderRuns(runs: readonly Run[], body: number, relativeSizes: boolean): string {
  let html = '';
  for (const run of runs) {
    const ratio = run.size === null ? 1 : run.size / body;
    if (relativeSizes && run.chars > 0 && Math.abs(ratio - 1) > 0.06) {
      const em = Math.min(2.4, Math.max(0.75, ratio));
      html += `<span style="font-size:${em.toFixed(3)}em">${run.html}</span>`;
    } else {
      html += run.html;
    }
  }
  return html;
}

/** `<strong>` around a whole heading says nothing: the heading is already set heavier. */
function unwrapBold(html: string): string {
  return html.replaceAll(/<\/?strong>/g, '');
}

function renderParagraph(paragraph: ParagraphBlock, body: number): string {
  const level = headingLevel(paragraph, body);
  const style = paragraph.align && paragraph.align !== 'left' ? ` style="text-align:${paragraph.align}"` : '';
  if (level > 0) return `<h${level}${style}>${unwrapBold(renderRuns(paragraph.runs, body, false))}</h${level}>`;
  const inner = renderRuns(paragraph.runs, body, true);
  // An empty paragraph is spacing the reading page already provides.
  if (inner === '') return '';
  return `<p${style}>${inner}</p>`;
}

function renderBlock(block: Block, body: number, budget: { left: number }): string {
  let html = '';
  if (block.type === 'paragraph') {
    html = renderParagraph(block, body);
  } else if (block.type === 'page') {
    html = '<hr>';
  } else if (block.type === 'image') {
    html = `<p><img src="${escapeHtml(block.src)}" alt=""></p>`;
  } else if (block.type === 'list') {
    const tag = block.ordered ? 'ol' : 'ul';
    let items = '';
    for (const item of block.items) {
      let inner = '';
      // A list item of one paragraph is just its text.
      if (item.length === 1 && item[0]?.type === 'paragraph') inner = renderRuns(item[0].runs, body, true);
      else for (const child of item) inner += renderBlock(child, body, budget);
      items += `<li>${inner}</li>`;
    }
    html = `<${tag}>${items}</${tag}>`;
  } else {
    let rows = '';
    for (const row of block.rows) {
      let cells = '';
      for (const cell of row) {
        const parts = cell.paragraphs.map((paragraph) => renderRuns(paragraph.runs, body, true)).filter((part) => part !== '');
        const span = (cell.colSpan > 1 ? ` colspan="${cell.colSpan}"` : '') + (cell.rowSpan > 1 ? ` rowspan="${cell.rowSpan}"` : '');
        const align = cell.paragraphs.find((paragraph) => paragraph.align && paragraph.align !== 'left')?.align;
        cells += `<td${span}${align ? ` style="text-align:${align}"` : ''}>${parts.join('<br>')}</td>`;
      }
      rows += `<tr>${cells}</tr>`;
    }
    html = `<table><tbody>${rows}</tbody></table>`;
  }
  budget.left -= html.length;
  if (budget.left < 0) throw new ReadError('too-large');
  return html;
}

/** Blocks → markup for the reading page. Throws `ReadError('too-large')` past the markup limit. */
export function renderBlocks(blocks: readonly Block[]): string {
  const body = bodySize(blocks);
  const budget = { left: MAX_MARKUP_CHARS };
  let html = '';
  for (const block of blocks) html += renderBlock(block, body, budget);
  // Page breaks at the very start or end, or doubled, divide nothing.
  return html.replaceAll(/(?:<hr>)+/g, '<hr>').replace(/^<hr>/, '').replace(/<hr>$/, '');
}
