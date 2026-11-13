/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/lib/snap.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: frames → board rects {x, y, w, h};
 *   ruler guides dropped; resize snaps the moving edges of any of the 8 handles with the kind's minimum size.
 */
import type { ResizeHandle, Rect, Size, SnapGuide } from '../model/types';

/**
 * Alignment snapping: while a node moves or resizes, its edges and centers pull onto the matching edges/centers
 * of the other nodes on the board. Pure math — the overlay draws the returned guides, the pointer controller
 * applies the snapped rect.
 */

/* how close (in screen px) an edge must be before it locks on */
export const SNAP_PX = 8;

export type { SnapGuide };

/** A line something can snap onto, with the span it covers along the other axis. */
interface Target {
  at: number;
  from: number;
  to: number;
}

/* start / center / end of a span */
const lines = (pos: number, size: number): number[] => [pos, pos + size / 2, pos + size];

function rectTargets(others: readonly Rect[], key: 'x' | 'y'): Target[] {
  return others.flatMap((o) =>
    lines(o[key], key === 'x' ? o.w : o.h).map((at) =>
      key === 'x' ? { at, from: o.y, to: o.y + o.h } : { at, from: o.x, to: o.x + o.w },
    ),
  );
}

function closest(ownOffsets: number[], base: number, targets: readonly Target[], tol: number): { delta: number; target: Target } | null {
  let hit: { delta: number; target: Target } | null = null;
  for (const target of targets) {
    for (const offset of ownOffsets) {
      const delta = target.at - (base + offset);
      if (Math.abs(delta) <= tol && (!hit || Math.abs(delta) < Math.abs(hit.delta))) hit = { delta, target };
    }
  }
  return hit;
}

export interface SnapOptions {
  /** resize: the handle being dragged (default 'se': the right and bottom edges move) */
  handle?: ResizeHandle;
  /** resize: a snap that would shrink past the minimum loses to the clamp */
  min?: Size;
}

/**
 * Snap a dragged rect against the other rects. Moving considers the rect's start/center/end on both axes;
 * resizing only the edges the handle moves. `zoom` converts the screen-px tolerance to world units.
 */
export function snapRect(
  mode: 'move' | 'resize',
  rect: Rect,
  others: readonly Rect[],
  zoom: number,
  opts: SnapOptions = {},
): Rect & { guides: SnapGuide[] } {
  const tol = SNAP_PX / zoom;
  let { x, y, w, h } = rect;
  const xTargets = rectTargets(others, 'x');
  const yTargets = rectTargets(others, 'y');
  let gx: { delta: number; target: Target } | null = null;
  let gy: { delta: number; target: Target } | null = null;
  if (mode === 'move') {
    gx = closest(lines(0, w), x, xTargets, tol);
    gy = closest(lines(0, h), y, yTargets, tol);
    if (gx) x += gx.delta;
    if (gy) y += gy.delta;
  } else {
    const handle = opts.handle ?? 'se';
    const min = opts.min ?? { w: 1, h: 1 };
    const movesRight = handle.includes('e');
    const movesLeft = handle.includes('w');
    const movesBottom = handle.includes('s');
    const movesTop = handle.includes('n');
    if (movesRight || movesLeft) {
      gx = closest([movesRight ? w : 0], x, xTargets, tol);
      if (gx) {
        const nextW = movesRight ? w + gx.delta : w - gx.delta;
        if (nextW >= min.w) {
          if (movesLeft) x += gx.delta;
          w = nextW;
        } else gx = null;
      }
    }
    if (movesBottom || movesTop) {
      gy = closest([movesBottom ? h : 0], y, yTargets, tol);
      if (gy) {
        const nextH = movesBottom ? h + gy.delta : h - gy.delta;
        if (nextH >= min.h) {
          if (movesTop) y += gy.delta;
          h = nextH;
        } else gy = null;
      }
    }
  }
  const guides: SnapGuide[] = [];
  if (gx) guides.push({ axis: 'v', at: gx.target.at, from: Math.min(y, gx.target.from), to: Math.max(y + h, gx.target.to) });
  if (gy) guides.push({ axis: 'h', at: gy.target.at, from: Math.min(x, gy.target.from), to: Math.max(x + w, gy.target.to) });
  return { x, y, w, h, guides };
}
