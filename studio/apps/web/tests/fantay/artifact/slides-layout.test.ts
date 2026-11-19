// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of the run of slides: fitting, the slide in view, the reader's anchor, and the
// order slides are drawn and presented in.
import { describe, expect, it } from 'vitest';

import {
  SLIDE_ZOOM_MAX,
  SLIDE_ZOOM_MIN,
  anchorAt,
  aspectLabel,
  drawOrder,
  firstShown,
  fitSlideZoom,
  nextShown,
  scrollTopFor,
  slideInView,
  type SlideBox,
} from '../../../src/fantay/artifact/viewers/slides/slide-layout';

/** `count` slides of `height`, 16px apart, after 24px of ground. */
function run(count: number, height: number): SlideBox[] {
  return Array.from({ length: count }, (_, index) => ({ top: 24 + index * (height + 16), height }));
}

describe('aspectLabel', () => {
  it('names the common slide proportions', () => {
    expect(aspectLabel(960, 540)).toBe('16:9');
    expect(aspectLabel(1280, 720)).toBe('16:9');
    expect(aspectLabel(960, 720)).toBe('4:3');
    expect(aspectLabel(1280, 800)).toBe('16:10');
    expect(aspectLabel(540, 960)).toBe('9:16');
  });

  it('accepts the rounding real decks carry', () => {
    // PowerPoint's "widescreen" is 13.333 in × 7.5 in.
    expect(aspectLabel(1279.97, 720)).toBe('16:9');
  });

  it('falls back to a ratio, and to nothing when the size is unknown', () => {
    expect(aspectLabel(2350, 1000)).toBe('2.35:1');
    expect(aspectLabel(2000, 1000)).toBe('2:1');
    expect(aspectLabel(0, 0)).toBe('');
  });
});

describe('fitSlideZoom', () => {
  const deck = { width: 960, height: 540 };

  it('fits the width in a tall, narrow panel', () => {
    expect(fitSlideZoom(deck, { width: 768, height: 860 }, 24)).toBeCloseTo(0.75);
  });

  it('never lets one slide be taller than the window', () => {
    // 4:3 in a wide window: the height decides.
    expect(fitSlideZoom({ width: 960, height: 720 }, { width: 1400, height: 800 }, 24)).toBeCloseTo((800 - 48) / 720);
  });

  it('fits the width alone when the stage is too short to show a whole slide at a useful size', () => {
    expect(fitSlideZoom(deck, { width: 768, height: 200 }, 24)).toBeCloseTo(0.75);
  });

  it('stays inside the zoom range and survives an unmeasured stage', () => {
    expect(fitSlideZoom(deck, { width: 60, height: 900 }, 24)).toBe(SLIDE_ZOOM_MIN);
    expect(fitSlideZoom({ width: 100, height: 60 }, { width: 4000, height: 4000 }, 24)).toBe(SLIDE_ZOOM_MAX);
    expect(fitSlideZoom(deck, { width: 0, height: 0 }, 24)).toBe(1);
  });
});

describe('slideInView', () => {
  const boxes = run(6, 400);
  const scrollHeight = 24 + 6 * 416 - 16 + 24;

  it('is the first slide at the top', () => {
    expect(slideInView(boxes, 0, 800, scrollHeight)).toBe(0);
  });

  it('is the slide with the larger share of itself in view', () => {
    // Slide 1 is three quarters gone; slide 2 is whole.
    expect(slideInView(boxes, 24 + 300, 800, scrollHeight)).toBe(1);
  });

  it('prefers the earlier slide when two are equally in view', () => {
    expect(slideInView(boxes, 24, 832, scrollHeight)).toBe(0);
  });

  it('reaches the last slide at the end of the run, even when several share the last screen', () => {
    const viewport = 1300;
    expect(slideInView(boxes, scrollHeight - viewport, viewport, scrollHeight)).toBe(5);
  });

  it('answers 0 for an empty run', () => {
    expect(slideInView([], 0, 800, 0)).toBe(0);
  });
});

describe('anchor', () => {
  it('round-trips a position inside a slide', () => {
    const boxes = run(8, 400);
    const anchor = anchorAt(boxes, 24 + 2 * 416 + 100);
    expect(anchor).toEqual({ index: 2, offset: 0.25 });
    expect(scrollTopFor(anchor, boxes)).toBe(24 + 2 * 416 + 100);
  });

  it('keeps the same slide at the same depth when the slides change size', () => {
    const anchor = anchorAt(run(8, 400), 24 + 2 * 416 + 100);
    const larger = run(8, 800);
    expect(scrollTopFor(anchor, larger)).toBe(24 + 2 * 816 + 200);
  });

  it('anchors a position in the gap above a slide to that slide', () => {
    const boxes = run(3, 400);
    const anchor = anchorAt(boxes, 0);
    expect(anchor.index).toBe(0);
    expect(scrollTopFor(anchor, boxes)).toBeCloseTo(0);
  });

  it('clamps an anchor that points past a shorter deck', () => {
    expect(scrollTopFor({ index: 40, offset: 0 }, run(3, 400))).toBe(24 + 2 * 416);
    expect(scrollTopFor({ index: 2, offset: 0 }, [])).toBe(0);
  });
});

describe('presenting order', () => {
  const hidden = [false, true, true, false, false, true];

  it('skips hidden slides in both directions', () => {
    expect(nextShown(hidden, 0, 1)).toBe(3);
    expect(nextShown(hidden, 3, -1)).toBe(0);
  });

  it('stays put at either end', () => {
    expect(nextShown(hidden, 4, 1)).toBe(4);
    expect(nextShown(hidden, 0, -1)).toBe(0);
  });

  it('opens on the nearest shown slide when asked to start on a hidden one', () => {
    expect(firstShown(hidden, 1)).toBe(3);
    expect(firstShown(hidden, 5)).toBe(4);
    expect(firstShown(hidden, 3)).toBe(3);
  });

  it('shows every slide of a deck that is hidden throughout', () => {
    const all = [true, true, true];
    expect(nextShown(all, 0, 1)).toBe(1);
    expect(firstShown(all, 2)).toBe(2);
  });
});

describe('drawOrder', () => {
  it('draws the window and a margin, nearest to the reader first', () => {
    expect(drawOrder(4, 5, 20, 2, 4)).toEqual([4, 3, 5, 2, 6, 7]);
  });

  it('stays inside the deck', () => {
    expect(drawOrder(0, 1, 3, 2, 0)).toEqual([0, 1, 2]);
    expect(drawOrder(0, 0, 0, 2, 0)).toEqual([]);
  });
});
