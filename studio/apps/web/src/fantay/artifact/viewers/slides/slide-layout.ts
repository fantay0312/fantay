// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of a run of slides: how large a slide is drawn, which slide the reader is on, and
// where the reader is inside it. Pure, so the viewer and the tests agree on every number.

export interface Size {
  width: number;
  height: number;
}

export const SLIDE_ZOOM_MIN = 0.25;
export const SLIDE_ZOOM_MAX = 4;

/** Below this stage height "fit" stops shrinking slides to show a whole one: they would be thumbnails. */
const MIN_HEIGHT_FOR_WHOLE_SLIDE = 280;

export function clampSlideZoom(zoom: number): number {
  return Math.min(SLIDE_ZOOM_MAX, Math.max(SLIDE_ZOOM_MIN, zoom));
}

/**
 * The zoom at which one whole slide fits the stage: as wide as the stage allows, and no taller than
 * it, so a 4:3 deck in a wide window is not cut at the bottom. `pad` is the ground kept on each side.
 */
export function fitSlideZoom(slide: Size, stage: Size, pad: number): number {
  if (slide.width <= 0 || slide.height <= 0 || stage.width <= 0) return 1;
  const byWidth = Math.max(1, stage.width - pad * 2) / slide.width;
  if (stage.height < MIN_HEIGHT_FOR_WHOLE_SLIDE) return clampSlideZoom(byWidth);
  const byHeight = Math.max(1, stage.height - pad * 2) / slide.height;
  return clampSlideZoom(Math.min(byWidth, byHeight));
}

const NAMED_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [4, 3],
  [16, 10],
  [3, 2],
  [1, 1],
  [9, 16],
  [3, 4],
  [2, 3],
];

/** "16:9", "4:3"; a size that is none of the common ones reads as "2.35:1". '' when the size is unknown. */
export function aspectLabel(width: number, height: number): string {
  if (!(width > 0 && height > 0)) return '';
  const ratio = width / height;
  for (const [w, h] of NAMED_RATIOS) {
    if (Math.abs(ratio - w / h) / (w / h) < 0.012) return `${w}:${h}`;
  }
  return `${ratio.toFixed(2).replace(/\.?0+$/, '')}:1`;
}

/** Where each slide sits in the scrolling run, in the scroller's own pixels. */
export interface SlideBox {
  top: number;
  height: number;
}

/**
 * The slide the reader is on: the one with the most of itself in view, the earlier one on a tie.
 * At the very end of the run it is the last slide, so the count can reach "12 / 12" even when
 * several small slides share the last screen. 0-based; 0 for an empty run.
 */
export function slideInView(boxes: readonly SlideBox[], scrollTop: number, viewport: number, scrollHeight: number): number {
  if (boxes.length === 0) return 0;
  if (scrollTop > 0 && scrollTop + viewport >= scrollHeight - 1) return boxes.length - 1;
  const bottom = scrollTop + viewport;
  let best = 0;
  let bestShare = -1;
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (!box) continue;
    if (box.top >= bottom) break;
    const visible = Math.min(bottom, box.top + box.height) - Math.max(scrollTop, box.top);
    if (visible <= 0) continue;
    // Share of the slide, not pixels: a slide half off the top must not beat a whole one below it.
    const share = box.height > 0 ? visible / box.height : 0;
    if (share > bestShare + 1e-6) {
      best = index;
      bestShare = share;
    }
  }
  return best;
}

/** A place in the run that survives a change of zoom or width: a slide and how far into it. */
export interface SlideAnchor {
  /** 0-based slide. */
  index: number;
  /** Distance below the slide's top edge, as a share of the slide's height. Negative above it. */
  offset: number;
}

/** The anchor for a scroll position: the first slide that still reaches below the top edge. */
export function anchorAt(boxes: readonly SlideBox[], scrollTop: number): SlideAnchor {
  for (let index = 0; index < boxes.length; index += 1) {
    const box = boxes[index];
    if (!box || box.top + box.height <= scrollTop) continue;
    return { index, offset: box.height > 0 ? (scrollTop - box.top) / box.height : 0 };
  }
  return { index: Math.max(0, boxes.length - 1), offset: 0 };
}

/** The scroll position that puts an anchor back at the top edge. */
export function scrollTopFor(anchor: SlideAnchor, boxes: readonly SlideBox[]): number {
  const box = boxes[Math.min(boxes.length - 1, Math.max(0, anchor.index))];
  if (!box) return 0;
  return Math.max(0, box.top + anchor.offset * box.height);
}

/**
 * The next slide to show when presenting, skipping slides the author hid. Returns `from` when
 * there is nothing further in that direction. A deck whose slides are all hidden shows them all.
 */
export function nextShown(hidden: readonly boolean[], from: number, direction: 1 | -1): number {
  const skip = hidden.some((flag) => !flag);
  for (let index = from + direction; index >= 0 && index < hidden.length; index += direction) {
    if (!skip || !hidden[index]) return index;
  }
  return from;
}

/** The slide to open a presentation on: `from`, or the nearest shown slide when `from` is hidden. */
export function firstShown(hidden: readonly boolean[], from: number): number {
  if (hidden.length === 0) return 0;
  const start = Math.min(hidden.length - 1, Math.max(0, from));
  if (!hidden[start] || hidden.every(Boolean)) return start;
  const forward = nextShown(hidden, start, 1);
  return forward !== start ? forward : nextShown(hidden, start, -1);
}

/**
 * Which slides to draw: those in view plus a margin either side, nearest to the reader first.
 * `first` and `last` are the slides touching the viewport (0-based, inclusive).
 */
export function drawOrder(first: number, last: number, count: number, margin: number, focus: number): number[] {
  if (count <= 0) return [];
  const from = Math.max(0, Math.min(first, last) - margin);
  const to = Math.min(count - 1, Math.max(first, last) + margin);
  const wanted: number[] = [];
  for (let index = from; index <= to; index += 1) wanted.push(index);
  return wanted.sort((a, b) => Math.abs(a - focus) - Math.abs(b - focus) || a - b);
}
