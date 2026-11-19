// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/pdfLayout.ts @ c5e6b24f (MIT): a pure layout
// module for a column of pages (page tops as running sums, the window of pages worth mounting, the
// page in view, restoring a saved spot after the layout changed). Changed here: every page keeps its
// own width and height (mixed sizes), 100% is real size (96 CSS px per inch) and "whole page" is a
// second fit, page boxes are whole pixels so the arithmetic equals what the browser lays out, the
// window is found by binary search, the page in view is pdf.js's "most visible" rule (a page that was
// jumped to stays current while it is fully in view), and a saved spot is a fraction of a page so it
// survives zoom and width changes.
//
// Pure: no React, no DOM. Everything the viewer computes about geometry goes through here.

/** A PDF point is 1/72 inch; a CSS pixel is 1/96 inch. At zoom 1 a page is its printed size. */
export const PDF_CSS_UNITS = 96 / 72;
export const PDF_MIN_ZOOM = 0.25;
export const PDF_MAX_ZOOM = 4;
/** A fitted zoom may go below the smallest step (a poster), never to nothing. */
const PDF_MIN_FIT = 0.05;

/** `width` fits the widest page to the panel; `page` shows a whole page; a number is that zoom. */
export type PdfZoom = 'width' | 'page' | number;

/** One page at scale 1, in PDF points, with its rotation applied. */
export interface PdfPageSize {
  width: number;
  height: number;
}

export interface PdfViewport {
  width: number;
  height: number;
}

/** The shared sheet ground's rhythm, read from its computed style. */
export interface PdfMetrics {
  /** Space between the ground's edge and the pages. */
  pad: number;
  /** Space between two pages. */
  gap: number;
}

export interface PdfLayout {
  /** Whole CSS pixels, one entry per page. */
  widths: number[];
  heights: number[];
  /** Top edge of each page inside the scrolling ground. */
  tops: number[];
  /** Height of the whole ground, padding included. */
  height: number;
  /** The widest page. */
  width: number;
  pad: number;
  gap: number;
}

/** Where the reader is: a page, and how far down that page the top of the window sits. */
export interface PdfAnchor {
  /** 0-based. */
  page: number;
  /**
   * From 0 up: a fraction of the page's height. Below 0: the window starts in the space above the
   * page, and the value is a fraction of that space (-1 = its far edge), which does not grow with
   * the zoom the way a page does.
   */
  offset: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** The zoom that fits the widest page to the window's width, or a whole page into the window. */
export function pdfFitZoom(sizes: readonly PdfPageSize[], viewport: PdfViewport, mode: 'width' | 'page', pad: number): number {
  let widest = 0;
  let tallest = 0;
  for (const size of sizes) {
    if (size.width > widest) widest = size.width;
    if (size.height > tallest) tallest = size.height;
  }
  if (widest <= 0 || tallest <= 0) return 1;
  const byWidth = Math.max(1, viewport.width - pad * 2) / (widest * PDF_CSS_UNITS);
  const zoom = mode === 'width' ? byWidth : Math.min(byWidth, Math.max(1, viewport.height - pad * 2) / (tallest * PDF_CSS_UNITS));
  return clamp(zoom, PDF_MIN_FIT, PDF_MAX_ZOOM);
}

/** The zoom actually drawn for a setting. */
export function pdfResolveZoom(zoom: PdfZoom, sizes: readonly PdfPageSize[], viewport: PdfViewport, pad: number): number {
  if (zoom === 'width' || zoom === 'page') return pdfFitZoom(sizes, viewport, zoom, pad);
  return clamp(zoom, PDF_MIN_ZOOM, PDF_MAX_ZOOM);
}

/** Lays the pages out as one column: whole-pixel boxes, `gap` between them, `pad` around them. */
export function pdfLayout(sizes: readonly PdfPageSize[], zoom: number, metrics: PdfMetrics): PdfLayout {
  const scale = zoom * PDF_CSS_UNITS;
  const widths: number[] = [];
  const heights: number[] = [];
  const tops: number[] = [];
  let top = metrics.pad;
  let widest = 0;
  for (const size of sizes) {
    const width = Math.max(1, Math.round(size.width * scale));
    const height = Math.max(1, Math.round(size.height * scale));
    widths.push(width);
    heights.push(height);
    tops.push(top);
    top += height + metrics.gap;
    if (width > widest) widest = width;
  }
  const height = sizes.length > 0 ? top - metrics.gap + metrics.pad : metrics.pad * 2;
  return { widths, heights, tops, height, width: widest, pad: metrics.pad, gap: metrics.gap };
}

/** Index of the first page whose bottom edge is below `y`; the page count when there is none. */
function firstPageEndingAfter(layout: PdfLayout, y: number): number {
  let low = 0;
  let high = layout.tops.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((layout.tops[middle] ?? 0) + (layout.heights[middle] ?? 0) > y) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** Index of the last page whose top edge is above `y`; -1 when there is none. */
function lastPageStartingBefore(layout: PdfLayout, y: number): number {
  let low = 0;
  let high = layout.tops.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((layout.tops[middle] ?? 0) < y) low = middle + 1;
    else high = middle;
  }
  return low - 1;
}

export interface PdfWindowOptions {
  /** Extra space kept mounted above and below the window, in window heights. */
  above?: number;
  below?: number;
  /** Upper bound on mounted pages, whatever the zoom. */
  limit?: number;
}

/**
 * The pages worth mounting: those in the window plus a margin, so a page is drawn before it scrolls
 * in. Inclusive indexes; `last < first` means none.
 */
export function pdfPageWindow(
  layout: PdfLayout,
  scrollTop: number,
  viewportHeight: number,
  { above = 0.75, below = 1.25, limit = 48 }: PdfWindowOptions = {},
): { first: number; last: number } {
  const count = layout.tops.length;
  if (count === 0) return { first: 0, last: -1 };
  const first = Math.min(count - 1, firstPageEndingAfter(layout, scrollTop - viewportHeight * above));
  const last = Math.max(first, lastPageStartingBefore(layout, scrollTop + viewportHeight * (1 + below)));
  if (last - first + 1 <= limit) return { first, last };
  // Too many small pages for one window: keep the ones nearest to what is on screen.
  const visible = clamp(firstPageEndingAfter(layout, scrollTop), first, last);
  const start = clamp(visible - Math.floor(limit / 4), first, last - limit + 1);
  return { first: start, last: start + limit - 1 };
}

/**
 * The page the pager shows. The most visible page wins, the earlier one on a tie, and a page that
 * is entirely in view keeps the title once it has it, so jumping to a short page at the end of the
 * document shows that page's number even though it cannot reach the top of the window.
 */
export function pdfCurrentPage(layout: PdfLayout, scrollTop: number, viewportHeight: number, previous = 0): number {
  const count = layout.tops.length;
  if (count === 0) return 0;
  const bottom = scrollTop + Math.max(1, viewportHeight);
  const first = Math.min(count - 1, firstPageEndingAfter(layout, scrollTop));
  const last = Math.max(first, lastPageStartingBefore(layout, bottom));
  let best = first;
  let bestShare = -1;
  for (let index = first; index <= last; index += 1) {
    const top = layout.tops[index] ?? 0;
    const height = layout.heights[index] ?? 1;
    const share = Math.max(0, Math.min(top + height, bottom) - Math.max(top, scrollTop)) / height;
    if (index === previous && share >= 0.999) return previous;
    if (share > bestShare + 1e-6) {
      best = index;
      bestShare = share;
    }
  }
  return best;
}

/** The space above a page: the ground's padding for the first one, the gap for the others. */
function leadOf(layout: PdfLayout, page: number): number {
  return Math.max(1, page === 0 ? layout.pad : layout.gap);
}

/** The reader's place for a scroll position: the first page that reaches below `y`. */
export function pdfAnchorAt(layout: PdfLayout, y: number): PdfAnchor {
  const count = layout.tops.length;
  if (count === 0) return { page: 0, offset: 0 };
  const page = Math.min(count - 1, firstPageEndingAfter(layout, y));
  const top = layout.tops[page] ?? 0;
  if (y < top) return { page, offset: Math.max(-1, (y - top) / leadOf(layout, page)) };
  return { page, offset: (y - top) / (layout.heights[page] ?? 1) };
}

/**
 * The scroll position for a saved place in the current layout. A document that lost pages falls
 * back to its last page; a place past the end of a page stays on that page.
 */
export function pdfAnchorTop(layout: PdfLayout, anchor: PdfAnchor): number {
  const count = layout.tops.length;
  if (count === 0) return 0;
  const page = clamp(Math.round(anchor.page), 0, count - 1);
  const height = layout.heights[page] ?? 1;
  const lead = leadOf(layout, page);
  let offset = -lead;
  if (page === anchor.page) offset = anchor.offset < 0 ? Math.max(-1, anchor.offset) * lead : Math.min(anchor.offset * height, height - 1);
  return Math.max(0, (layout.tops[page] ?? 0) + offset);
}

/** Where a jump to a page lands: the page's top edge with the space above it showing. */
export function pdfPageScrollTop(layout: PdfLayout, page: number): number {
  const count = layout.tops.length;
  if (count === 0) return 0;
  const index = clamp(Math.round(page), 0, count - 1);
  return Math.max(0, (layout.tops[index] ?? 0) - (index === 0 ? layout.pad : layout.gap));
}

/** Left edge of a page: centred while it fits the window, flush with the padding once it is wider. */
export function pdfPageLeft(layout: PdfLayout, page: number, viewportWidth: number): number {
  const width = layout.widths[page] ?? layout.width;
  return Math.max(layout.pad, (viewportWidth - width) / 2);
}

/**
 * How far a page is from the middle of the window, in pixels: 0 for the page under the middle. The
 * drawing queue uses it to paint what the reader looks at before the pages around it.
 */
export function pdfPageDistance(layout: PdfLayout, page: number, scrollTop: number, viewportHeight: number): number {
  const top = layout.tops[page] ?? 0;
  const bottom = top + (layout.heights[page] ?? 0);
  const middle = scrollTop + viewportHeight / 2;
  if (middle < top) return top - middle;
  if (middle > bottom) return middle - bottom;
  return 0;
}

/**
 * Backing-store pixels per CSS pixel for a page: the screen's ratio, lowered when the bitmap would
 * pass `maxPixels` (a page at 400% on a Retina screen), so memory stays bounded and the page is a
 * little soft instead of failing to draw.
 */
export function pdfOutputScale(width: number, height: number, pixelRatio: number, maxPixels: number): number {
  const ratio = Number.isFinite(pixelRatio) && pixelRatio > 0 ? pixelRatio : 1;
  const area = Math.max(1, width * height);
  return Math.min(ratio, Math.sqrt(maxPixels / area));
}
