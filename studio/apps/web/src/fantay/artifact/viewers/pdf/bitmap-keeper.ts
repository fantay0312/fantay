// SPDX-License-Identifier: AGPL-3.0-only
// What happens to a page's bitmap when the page goes away.
// A page that scrolls out of the window gives its canvas back and the memory is released at once.
// When the whole viewer goes away (another tab came forward, or the agent rewrote the file and the
// host remounts the viewer) the pages that were on screen are kept for a short while instead. The
// next viewer for the same file shows them immediately, at the same place, and replaces each one
// when its fresh drawing is ready, so coming back to a PDF, or a new version of it, never passes
// through an empty stage. What is kept is bounded: a few documents, a byte budget each, a time limit.

const MAX_KEPT_DOCUMENTS = 3;
/** RGBA bytes kept per document: the page in view and a neighbour or two on a Retina panel. */
const MAX_KEPT_BYTES = 40 * 1024 * 1024;
const KEEP_MS = 120_000;

interface Kept {
  pages: Map<number, HTMLCanvasElement>;
  timer: ReturnType<typeof setTimeout>;
}

const kept = new Map<string, Kept>();

/** Releases a canvas's backing store now instead of at the next garbage collection. */
export function freePdfCanvas(canvas: HTMLCanvasElement): void {
  canvas.width = 0;
  canvas.height = 0;
}

function canvasBytes(canvas: HTMLCanvasElement): number {
  return canvas.width * canvas.height * 4;
}

function drop(key: string): void {
  const entry = kept.get(key);
  if (!entry) return;
  clearTimeout(entry.timer);
  for (const canvas of entry.pages.values()) freePdfCanvas(canvas);
  kept.delete(key);
}

function keep(key: string, pages: Map<number, HTMLCanvasElement>): void {
  drop(key);
  if (pages.size === 0) return;
  kept.set(key, { pages, timer: setTimeout(() => drop(key), KEEP_MS) });
  while (kept.size > MAX_KEPT_DOCUMENTS) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) break;
    drop(oldest);
  }
}

function take(key: string): Map<number, HTMLCanvasElement> {
  const entry = kept.get(key);
  if (!entry) return new Map();
  clearTimeout(entry.timer);
  kept.delete(key);
  return entry.pages;
}

export interface PdfBitmapKeeper {
  /** A bitmap to show on a page until its own drawing is ready. The caller owns it from here on. */
  seed(index: number): HTMLCanvasElement | undefined;
  /** A page gives its canvas back (it left the window, or the viewer is going away). */
  retire(index: number, canvas: HTMLCanvasElement): void;
  /** Call from an effect; the returned cleanup tells the keeper the viewer is gone. */
  attach(): () => void;
}

/** `focus` answers which page the reader is on, so the pages nearest to it are the ones kept. */
export function createPdfBitmapKeeper(key: string, focus: () => number): PdfBitmapKeeper {
  // Taken on first use, not while rendering: creating a keeper has no effect on what is kept.
  let taken: Map<number, HTMLCanvasElement> | null = null;
  const seeds = (): Map<number, HTMLCanvasElement> => (taken ??= take(key));
  const retired = new Map<number, HTMLCanvasElement>();
  let attached = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;

  const flush = (): void => {
    flushTimer = null;
    if (attached) {
      // The viewer lives on: these pages only scrolled away.
      for (const canvas of retired.values()) freePdfCanvas(canvas);
      retired.clear();
      return;
    }
    // The viewer is gone: keep what was nearest to the reader, within the budget.
    for (const [index, canvas] of seeds()) if (!retired.has(index)) retired.set(index, canvas);
    seeds().clear();
    const centre = focus();
    const ordered = [...retired.entries()].sort((a, b) => Math.abs(a[0] - centre) - Math.abs(b[0] - centre));
    const pages = new Map<number, HTMLCanvasElement>();
    let bytes = 0;
    for (const [index, canvas] of ordered) {
      const size = canvasBytes(canvas);
      if (size > 0 && bytes + size <= MAX_KEPT_BYTES) {
        pages.set(index, canvas);
        bytes += size;
      } else {
        freePdfCanvas(canvas);
      }
    }
    retired.clear();
    keep(key, pages);
  };

  const scheduleFlush = (): void => {
    // Deferred, so that by the time it runs the keeper knows whether the viewer itself unmounted.
    flushTimer ??= setTimeout(flush, 0);
  };

  return {
    seed(index) {
      const canvas = retired.get(index) ?? seeds().get(index);
      retired.delete(index);
      seeds().delete(index);
      return canvas;
    },
    retire(index, canvas) {
      const previous = retired.get(index);
      if (previous && previous !== canvas) freePdfCanvas(previous);
      retired.set(index, canvas);
      scheduleFlush();
    },
    attach() {
      attached = true;
      return () => {
        attached = false;
        scheduleFlush();
      };
    },
  };
}
