// SPDX-License-Identifier: AGPL-3.0-only
// The arithmetic of the diagram stage, the same model as the image viewer's: the viewport scrolls,
// a plane at least as large as the viewport centres a frame of the drawing's size × zoom, so a small
// drawing sits in the middle and a large one pans. Kept apart so it can be tested without a DOM.

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** Space kept between the drawing and the edge of the stage. */
export const STAGE_PAD = 24;

/** The zoom that shows the whole drawing, never above 100%. */
export function fitZoom(natural: Size, viewport: Size, pad = STAGE_PAD): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const availableWidth = Math.max(1, viewport.width - pad * 2);
  const availableHeight = Math.max(1, viewport.height - pad * 2);
  return Math.min(1, availableWidth / natural.width, availableHeight / natural.height);
}

/** Below this zoom a drawing's words are too small to read comfortably. */
export const READABLE_ZOOM = 0.75;

/**
 * The zoom a drawing opens at, and goes back to: the whole drawing in view when that keeps its
 * words readable; otherwise as wide as the stage and read by scrolling down, like a page. A tall
 * drawing (a long sequence, a diagram laid out for a narrow panel) is then read at its real size
 * instead of being shrunk until its height fits. Never above 100%.
 */
export function openZoom(natural: Size, viewport: Size, pad = STAGE_PAD): number {
  const whole = fitZoom(natural, viewport, pad);
  if (whole >= READABLE_ZOOM || natural.width <= 0) return whole;
  return Math.min(1, Math.max(1, viewport.width - pad * 2) / natural.width);
}

export function clampZoom(zoom: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, zoom));
}

/** Where the drawing's left/top edge sits inside the scrolling plane at a zoom. */
export function frameOffset(viewport: number, natural: number, zoom: number, pad = STAGE_PAD): number {
  return Math.max(pad, (viewport - natural * zoom) / 2);
}

/** The drawing point (in diagram units) under a viewport point, given the scroll position. */
export function pointAt(scroll: Point, at: Point, viewport: Size, natural: Size, zoom: number): Point {
  return {
    x: (scroll.x + at.x - frameOffset(viewport.width, natural.width, zoom)) / zoom,
    y: (scroll.y + at.y - frameOffset(viewport.height, natural.height, zoom)) / zoom,
  };
}

/** The scroll position that puts drawing point `point` under viewport point `at`. */
export function scrollFor(point: Point, at: Point, viewport: Size, natural: Size, zoom: number): Point {
  return {
    x: point.x * zoom + frameOffset(viewport.width, natural.width, zoom) - at.x,
    y: point.y * zoom + frameOffset(viewport.height, natural.height, zoom) - at.y,
  };
}
