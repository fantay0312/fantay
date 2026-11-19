// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/pdfLayout.test.ts @ c5e6b24f (MIT): the cases for
// stacking mixed-height pages, the page in view, jumping, the mounted window and restoring a saved
// spot. Changed here: they exercise our layout (per-page width and height, whole-pixel boxes, real
// size at 100%, "most visible" current page, fraction anchors) and add zoom fitting and the bitmap
// budget.
import { describe, expect, it } from 'vitest';

import {
  PDF_CSS_UNITS,
  PDF_MAX_ZOOM,
  PDF_MIN_ZOOM,
  pdfAnchorAt,
  pdfAnchorTop,
  pdfCurrentPage,
  pdfFitZoom,
  pdfLayout,
  pdfOutputScale,
  pdfPageDistance,
  pdfPageLeft,
  pdfPageScrollTop,
  pdfPageWindow,
  pdfResolveZoom,
  type PdfPageSize,
} from '../../../src/fantay/artifact/viewers/pdf/pdf-layout';

const A4: PdfPageSize = { width: 595.28, height: 841.89 };
const A4_LANDSCAPE: PdfPageSize = { width: 841.89, height: 595.28 };
const METRICS = { pad: 24, gap: 16 };
/** A zoom at which one PDF point is one CSS pixel, so the numbers below read as plain pixels. */
const POINT = 1 / PDF_CSS_UNITS;

describe('pdfFitZoom / pdfResolveZoom', () => {
  it('fits the widest page to the window minus its padding', () => {
    const zoom = pdfFitZoom([A4], { width: 768, height: 800 }, 'width', 24);
    expect(zoom).toBeCloseTo((768 - 48) / (595.28 * PDF_CSS_UNITS), 6);
    // A landscape page anywhere in the document decides the fit.
    expect(pdfFitZoom([A4, A4_LANDSCAPE, A4], { width: 768, height: 800 }, 'width', 24)).toBeCloseTo((768 - 48) / (841.89 * PDF_CSS_UNITS), 6);
  });

  it('shows a whole page when asked to, never wider than the window', () => {
    const tall = pdfFitZoom([A4], { width: 1200, height: 600 }, 'page', 24);
    expect(tall).toBeCloseTo((600 - 48) / (841.89 * PDF_CSS_UNITS), 6);
    const narrow = pdfFitZoom([A4], { width: 300, height: 2000 }, 'page', 24);
    expect(narrow).toBeCloseTo((300 - 48) / (595.28 * PDF_CSS_UNITS), 6);
  });

  it('keeps a fit inside a sane range and an explicit zoom inside the steps', () => {
    expect(pdfFitZoom([{ width: 20, height: 20 }], { width: 2000, height: 2000 }, 'width', 24)).toBe(PDF_MAX_ZOOM);
    expect(pdfFitZoom([{ width: 20000, height: 20000 }], { width: 400, height: 400 }, 'width', 24)).toBeGreaterThan(0);
    expect(pdfFitZoom([{ width: 20000, height: 20000 }], { width: 400, height: 400 }, 'width', 24)).toBeLessThan(PDF_MIN_ZOOM);
    expect(pdfFitZoom([], { width: 400, height: 400 }, 'width', 24)).toBe(1);
    expect(pdfResolveZoom(9, [A4], { width: 768, height: 800 }, 24)).toBe(PDF_MAX_ZOOM);
    expect(pdfResolveZoom(0.01, [A4], { width: 768, height: 800 }, 24)).toBe(PDF_MIN_ZOOM);
    expect(pdfResolveZoom(1.5, [A4], { width: 768, height: 800 }, 24)).toBe(1.5);
    expect(pdfResolveZoom('width', [A4], { width: 768, height: 800 }, 24)).toBeCloseTo(pdfFitZoom([A4], { width: 768, height: 800 }, 'width', 24), 9);
  });

  it('never collapses in a window smaller than its padding', () => {
    expect(pdfFitZoom([A4], { width: 10, height: 10 }, 'width', 24)).toBeGreaterThan(0);
  });
});

describe('pdfLayout', () => {
  // A short banner, a letter page, then a page half as tall as it is wide.
  const sizes: PdfPageSize[] = [
    { width: 612, height: 140 },
    { width: 612, height: 792 },
    { width: 612, height: 306 },
  ];
  const layout = pdfLayout(sizes, POINT, METRICS);

  it('stacks pages with the padding around them and the gap between them', () => {
    expect(layout.heights).toEqual([140, 792, 306]);
    expect(layout.tops).toEqual([24, 180, 988]);
    expect(layout.height).toBe(24 + 140 + 16 + 792 + 16 + 306 + 24);
    expect(layout.width).toBe(612);
  });

  it('draws 100% at real size and rounds every box to whole pixels', () => {
    const real = pdfLayout([A4], 1, METRICS);
    expect(real.widths).toEqual([794]);
    expect(real.heights).toEqual([1123]);
    const odd = pdfLayout([A4, A4, A4], 0.913, METRICS);
    for (const value of [...odd.widths, ...odd.heights, ...odd.tops]) expect(Number.isInteger(value)).toBe(true);
    expect(odd.tops[2]).toBe(24 + 2 * ((odd.heights[0] ?? 0) + 16));
  });

  it('keeps each page its own width', () => {
    const mixed = pdfLayout([A4, A4_LANDSCAPE], POINT, METRICS);
    expect(mixed.widths).toEqual([595, 842]);
    expect(mixed.width).toBe(842);
    // Centred while it fits; flush with the padding once it is wider than the window.
    expect(pdfPageLeft(mixed, 0, 1000)).toBe((1000 - 595) / 2);
    expect(pdfPageLeft(mixed, 1, 600)).toBe(24);
  });

  it('scales with the zoom', () => {
    expect(pdfLayout(sizes, POINT * 2, METRICS).tops).toEqual([24, 320, 1920]);
  });

  it('is an empty ground for a document with no pages', () => {
    const empty = pdfLayout([], 1, METRICS);
    expect(empty.tops).toEqual([]);
    expect(empty.height).toBe(48);
    expect(pdfPageWindow(empty, 0, 500)).toEqual({ first: 0, last: -1 });
    expect(pdfCurrentPage(empty, 0, 500)).toBe(0);
    expect(pdfAnchorTop(empty, { page: 3, offset: 0.5 })).toBe(0);
  });

  describe('the page in view', () => {
    it('is the most visible page, the earlier one on a tie', () => {
      // Window of 400 at the top: the banner is entirely in view, the letter page only in part.
      expect(pdfCurrentPage(layout, 0, 400)).toBe(0);
      // The banner has scrolled away: the letter page fills the window.
      expect(pdfCurrentPage(layout, 200, 400)).toBe(1);
      // The last page shows more of itself than the letter page does.
      expect(pdfCurrentPage(layout, 900, 400)).toBe(2);
      const even = pdfLayout([A4, A4], POINT, METRICS);
      const boundary = (even.tops[1] ?? 0) - 8 - 300;
      expect(pdfCurrentPage(even, boundary, 600)).toBe(0);
      expect(pdfCurrentPage(even, boundary + 40, 600)).toBe(1);
    });

    it('keeps a page that was jumped to while it is entirely in view', () => {
      const slides = pdfLayout(
        Array.from({ length: 6 }, () => ({ width: 960, height: 200 })),
        POINT,
        METRICS,
      );
      // At the very end three short pages are fully visible. Without a hint the first of them wins…
      const end = slides.height - 700;
      expect(pdfCurrentPage(slides, end, 700)).toBe(3);
      // …but the last page stays current once the reader has jumped to it.
      expect(pdfCurrentPage(slides, end, 700, 5)).toBe(5);
      // It gives the title up as soon as it is no longer entirely in view.
      expect(pdfCurrentPage(slides, 0, 700, 5)).toBe(0);
    });

    it('makes every page current after a jump to it', () => {
      const long = pdfLayout(Array.from({ length: 40 }, () => A4), 0.9, METRICS);
      for (const index of [0, 1, 17, 38, 39]) {
        const top = Math.min(pdfPageScrollTop(long, index), long.height - 800);
        expect(pdfCurrentPage(long, top, 800, index)).toBe(index);
      }
    });
  });

  describe('jumping', () => {
    it('lands with the space above the page showing', () => {
      expect(pdfPageScrollTop(layout, 0)).toBe(0);
      expect(pdfPageScrollTop(layout, 1)).toBe(180 - 16);
      expect(pdfPageScrollTop(layout, 2)).toBe(988 - 16);
      expect(pdfPageScrollTop(layout, 99)).toBe(988 - 16);
      expect(pdfPageScrollTop(layout, -4)).toBe(0);
    });
  });

  describe('the mounted window', () => {
    const long = pdfLayout(Array.from({ length: 200 }, () => ({ width: 600, height: 800 })), POINT, METRICS);
    const pitch = 816;

    it('holds the pages in view plus a margin above and below', () => {
      expect(pdfPageWindow(long, 0, 800)).toEqual({ first: 0, last: 2 });
      // Page 50 at the top of the window: most of a window above, a window and a quarter below.
      const top = 24 + pitch * 50;
      expect(pdfPageWindow(long, top, 800)).toEqual({ first: 49, last: 52 });
      expect(pdfPageWindow(long, long.height - 800, 800).last).toBe(199);
    });

    it('never mounts every page of a long document', () => {
      const window = pdfPageWindow(long, 24 + pitch * 100, 800);
      expect(window.last - window.first + 1).toBeLessThan(8);
    });

    it('caps the number of tiny pages and keeps the ones on screen', () => {
      const tiny = pdfLayout(Array.from({ length: 500 }, () => ({ width: 100, height: 20 })), POINT, METRICS);
      const top = 24 + 36 * 250;
      const window = pdfPageWindow(tiny, top, 3000, { limit: 48 });
      expect(window.last - window.first + 1).toBe(48);
      expect(window.first).toBeLessThanOrEqual(250);
      expect(window.last).toBeGreaterThanOrEqual(250);
    });

    it('orders pages by their distance from the middle of the window', () => {
      const top = 24 + pitch * 10;
      expect(pdfPageDistance(long, 10, top, 800)).toBe(0);
      expect(pdfPageDistance(long, 11, top, 800)).toBeGreaterThan(0);
      expect(pdfPageDistance(long, 12, top, 800)).toBeGreaterThan(pdfPageDistance(long, 11, top, 800));
      expect(pdfPageDistance(long, 8, top, 800)).toBeGreaterThan(pdfPageDistance(long, 9, top, 800));
    });
  });

  describe("the reader's place", () => {
    it('is the page under the top of the window and how far down it', () => {
      expect(pdfAnchorAt(layout, 24 + 70)).toEqual({ page: 0, offset: 0.5 });
      expect(pdfAnchorAt(layout, 180 + 396)).toEqual({ page: 1, offset: 0.5 });
      // Above a page the place is a share of the space above it, not of the page.
      expect(pdfAnchorAt(layout, 0)).toEqual({ page: 0, offset: -1 });
      expect(pdfAnchorAt(layout, 12)).toEqual({ page: 0, offset: -0.5 });
      expect(pdfAnchorAt(layout, 170)).toEqual({ page: 1, offset: -10 / 16 });
    });

    it('comes back to the same place after a zoom or a change of width', () => {
      for (const top of [0, 94, 170, 576, 1100]) {
        const anchor = pdfAnchorAt(layout, top);
        expect(pdfAnchorTop(layout, anchor)).toBeCloseTo(top, 6);
        const doubled = pdfLayout(sizes, POINT * 2, METRICS);
        const restored = pdfAnchorTop(doubled, anchor);
        // Same page, same fraction of it.
        expect(pdfAnchorAt(doubled, restored).page).toBe(anchor.page);
        if (anchor.offset >= 0) expect(pdfAnchorAt(doubled, restored).offset).toBeCloseTo(anchor.offset, 2);
      }
    });

    it('keeps the very top at the very top whatever the pages turn out to be', () => {
      // The document opens with every page assumed as large as the first; the real sizes arrive later.
      const assumed = pdfLayout([A4, A4, A4], 0.85, METRICS);
      const top = pdfAnchorAt(assumed, 0);
      const measured = pdfLayout([A4, { width: 1190.55, height: 841.89 }, A4], 0.42, METRICS);
      expect(pdfAnchorTop(measured, top)).toBe(0);
      // In the gap above the second page: the same share of the gap.
      const gap = pdfAnchorAt(assumed, (assumed.tops[1] ?? 0) - 4);
      expect(pdfAnchorTop(measured, gap)).toBe((measured.tops[1] ?? 0) - 4);
    });

    it('stays inside the pages that remain when a new version is shorter', () => {
      // A page that shrank keeps the reader on its last pixel.
      expect(pdfAnchorTop(layout, { page: 2, offset: 4 })).toBe(988 + 305);
      // A page that no longer exists falls back to the top of the last page.
      const shorter = pdfLayout(sizes.slice(0, 2), POINT, METRICS);
      expect(pdfAnchorTop(shorter, { page: 2, offset: 0.4 })).toBe(180 - 16);
      expect(pdfAnchorTop(layout, { page: 0, offset: -5 })).toBe(0);
      expect(pdfAnchorTop(layout, { page: 1, offset: -5 })).toBe(180 - 16);
    });
  });
});

describe('pdfOutputScale', () => {
  it('uses the screen ratio while the bitmap fits the budget', () => {
    expect(pdfOutputScale(720, 1018, 2, 16 * 1024 * 1024)).toBe(2);
    expect(pdfOutputScale(720, 1018, 1, 16 * 1024 * 1024)).toBe(1);
  });

  it('draws softer instead of passing the budget', () => {
    const width = 3176;
    const height = 4492;
    const ratio = pdfOutputScale(width, height, 2, 16 * 1024 * 1024);
    expect(ratio).toBeLessThan(2);
    expect(width * ratio * height * ratio).toBeLessThanOrEqual(16 * 1024 * 1024 + 1);
  });

  it('falls back to 1 for a ratio that is not a number', () => {
    expect(pdfOutputScale(100, 100, Number.NaN, 1e9)).toBe(1);
    expect(pdfOutputScale(100, 100, 0, 1e9)).toBe(1);
  });
});
