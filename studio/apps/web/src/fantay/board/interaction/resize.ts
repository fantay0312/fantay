// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/components/canvas/canvas-node.tsx (handleResizeMove, L216-283).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: a pure function over board rects; 8 handles (edges and corners), ⌥ resizes
// from the centre, the kind's minimum size and an optional fixed aspect ratio.
import type { Point, Rect, ResizeHandle, Size } from '../model/types';

export interface ResizeOptions {
  /** keep the start rect's aspect ratio (or `ratio`) */
  keepAspect: boolean;
  /** grow/shrink symmetrically around the start rect's centre */
  fromCenter: boolean;
  min: Size;
  /** width / height; defaults to the start rect's */
  ratio?: number;
}

/** Horizontal / vertical direction a handle moves: +1 right/down edge, −1 left/top edge, 0 none. */
export function handleAxes(handle: ResizeHandle): { hx: -1 | 0 | 1; hy: -1 | 0 | 1 } {
  return {
    hx: handle.includes('e') ? 1 : handle.includes('w') ? -1 : 0,
    hy: handle.includes('s') ? 1 : handle.includes('n') ? -1 : 0,
  };
}

/** The rect after dragging `handle` by `delta` world px from `start`. */
export function resizeRect(start: Rect, handle: ResizeHandle, delta: Point, opts: ResizeOptions): Rect {
  const { hx, hy } = handleAxes(handle);
  const factor = opts.fromCenter ? 2 : 1;
  const minW = Math.max(1, opts.min.w);
  const minH = Math.max(1, opts.min.h);
  const ratio = opts.ratio ?? start.w / Math.max(1, start.h);
  let width = hx === 0 ? start.w : Math.max(minW, start.w + hx * delta.x * factor);
  let height = hy === 0 ? start.h : Math.max(minH, start.h + hy * delta.y * factor);
  if (opts.keepAspect && ratio > 0) {
    if (hx !== 0 && hy !== 0) {
      if (Math.abs(delta.x) >= Math.abs(delta.y)) height = width / ratio;
      else width = height * ratio;
    } else if (hx !== 0) {
      height = width / ratio;
    } else if (hy !== 0) {
      width = height * ratio;
    }
    if (height < minH) {
      height = minH;
      width = height * ratio;
    }
    if (width < minW) {
      width = minW;
      height = width / ratio;
    }
  }
  const startRight = start.x + start.w;
  const startBottom = start.y + start.h;
  let x: number;
  let y: number;
  if (opts.fromCenter) {
    x = start.x + start.w / 2 - width / 2;
    y = start.y + start.h / 2 - height / 2;
  } else {
    x = hx < 0 ? startRight - width : hx === 0 ? start.x + (start.w - width) / 2 : start.x;
    y = hy < 0 ? startBottom - height : hy === 0 ? start.y + (start.h - height) / 2 : start.y;
  }
  return { x, y, w: width, h: height };
}
