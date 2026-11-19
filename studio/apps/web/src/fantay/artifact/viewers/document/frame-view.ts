// SPDX-License-Identifier: AGPL-3.0-only
// Where the reader is inside a frame document, in terms that survive a new layout. A pixel offset
// means nothing after a zoom, a narrower panel or a new version of the file, so a place in a paged
// document is "this far into that sheet" and a place in a reading column is "this share of the way
// down". Both are plain data and are kept per file by `use-view-state`.

/** A point of the document: a sheet and the fractions of its width and height. */
export interface SheetAnchor {
  sheet: number;
  x: number;
  y: number;
}

export interface FramePoint {
  x: number;
  y: number;
}

function sheetsOf(frameDocument: Document): Element[] {
  return Array.from(frameDocument.querySelectorAll('.sheet'));
}

/** Top centre of the frame's window: the point a reader's place is measured at. */
export function topCentre(frameDocument: Document): FramePoint {
  return { x: frameDocument.documentElement.clientWidth / 2, y: 0 };
}

/** The document point under `point` (frame window coordinates). Null when there are no sheets. */
export function readSheetAnchor(frameDocument: Document, point: FramePoint = topCentre(frameDocument)): SheetAnchor | null {
  const sheets = sheetsOf(frameDocument);
  if (sheets.length === 0) return null;
  let index = sheets.length - 1;
  for (let candidate = 0; candidate < sheets.length; candidate += 1) {
    if ((sheets[candidate] as Element).getBoundingClientRect().bottom > point.y) {
      index = candidate;
      break;
    }
  }
  const rect = (sheets[index] as Element).getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return { sheet: index, x: (point.x - rect.left) / rect.width, y: (point.y - rect.top) / rect.height };
}

/** Scrolls so the anchored document point is back under `point`. */
export function applySheetAnchor(frameDocument: Document, anchor: SheetAnchor, point: FramePoint = topCentre(frameDocument)): void {
  const sheets = sheetsOf(frameDocument);
  const scroller = frameDocument.scrollingElement;
  const sheet = sheets[Math.min(sheets.length - 1, Math.max(0, anchor.sheet))];
  if (!sheet || !scroller) return;
  const rect = sheet.getBoundingClientRect();
  scroller.scrollTop += rect.top + anchor.y * rect.height - point.y;
  scroller.scrollLeft += rect.left + anchor.x * rect.width - point.x;
}

/** How far down a reading column the window is, 0 to 1. */
export function readScrollShare(frameDocument: Document): number {
  const scroller = frameDocument.scrollingElement;
  if (!scroller) return 0;
  const range = scroller.scrollHeight - scroller.clientHeight;
  return range > 0 ? Math.min(1, Math.max(0, scroller.scrollTop / range)) : 0;
}

export function applyScrollShare(frameDocument: Document, share: number): void {
  const scroller = frameDocument.scrollingElement;
  if (!scroller) return;
  scroller.scrollTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight) * Math.min(1, Math.max(0, share));
}

/** The zoom at which a page of `pageWidth` fills the window's width, never above 100%. */
export function fitWidthZoom(pageWidth: number, windowWidth: number, margin: number, min = 0.1): number {
  if (!(pageWidth > 0) || !(windowWidth > 0)) return 1;
  return Math.min(1, Math.max(min, (windowWidth - margin * 2) / pageWidth));
}
