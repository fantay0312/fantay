/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: tests/snapGuides.test.ts (frame-vs-frame cases) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: ruler-guide cases replaced by
 *   node-vs-node cases (tolerance scaling, closest wins, far edge and centre); 8-handle resize snapping and the
 *   resizeRect math (aspect lock, ⌥ from centre, minimum size) are Fantay additions.
 */
import { describe, expect, it } from 'vitest';

import { resizeRect } from '../../../src/fantay/board/interaction/resize';
import { SNAP_PX, snapRect } from '../../../src/fantay/board/interaction/snap';

const rect = (x: number, y: number, w: number, h: number) => ({ x, y, w, h });

describe('snapRect move', () => {
  it('pulls a moving edge onto another node edge within the screen tolerance', () => {
    const moved = snapRect('move', rect(205, 0, 100, 100), [rect(0, 500, 200, 50)], 1);
    expect(moved.x).toBe(200);
    expect(moved.guides).toEqual([{ axis: 'v', at: 200, from: 0, to: 550 }]);
  });

  it('snaps the far edge and the centre, too', () => {
    expect(snapRect('move', rect(96, 0, 100, 100), [rect(200, 400, 50, 50)], 1).x).toBe(100);
    expect(snapRect('move', rect(0, 147, 100, 100), [rect(400, 150, 50, 100)], 1).y).toBe(150);
  });

  it('scales the tolerance with the zoom', () => {
    /* 8 screen px: 16 world px at 50%, 4 at 200% */
    const others = [rect(0, 500, 200, 50)];
    expect(snapRect('move', rect(212, 0, 100, 100), others, 0.5).x).toBe(200);
    expect(snapRect('move', rect(206, 0, 100, 100), others, 2).x).toBe(206);
    expect(SNAP_PX).toBe(8);
  });

  it('takes the closest of several candidates', () => {
    const near = snapRect('move', rect(205, 0, 100, 100), [rect(0, 500, 200, 50), rect(0, 600, 203, 50)], 1);
    expect(near.x).toBe(203);
    expect(near.guides[0]).toMatchObject({ axis: 'v', at: 203, from: 0, to: 650 });
  });

  it('leaves a rect alone when nothing is close', () => {
    const free = snapRect('move', rect(300, 300, 100, 100), [rect(0, 0, 50, 50)], 1);
    expect(free).toEqual({ x: 300, y: 300, w: 100, h: 100, guides: [] });
  });
});

describe('snapRect resize (8 handles)', () => {
  const others = [rect(0, 0, 300, 200)];

  it('snaps the right and bottom edges of an se resize', () => {
    const resized = snapRect('resize', rect(500, 500, 296, 203), [rect(796 + 4, 0, 10, 10), rect(0, 700, 10, 40)], 1);
    expect(resized).toMatchObject({ x: 500, y: 500, w: 300, h: 200 });
  });

  it('snaps the left edge of a w resize, keeping the right edge fixed', () => {
    const resized = snapRect('resize', rect(305, 400, 100, 100), others, 1, { handle: 'w' });
    expect(resized.x).toBe(300);
    expect(resized.x + resized.w).toBe(405);
    expect(resized.y).toBe(400);
    expect(resized.h).toBe(100);
  });

  it('snaps the top edge of an n resize, keeping the bottom edge fixed', () => {
    const resized = snapRect('resize', rect(500, 205, 100, 100), others, 1, { handle: 'n' });
    expect(resized.y).toBe(200);
    expect(resized.y + resized.h).toBe(305);
  });

  it('a snap that would shrink past the minimum loses to the clamp', () => {
    const resized = snapRect('resize', rect(296, 400, 10, 10), [rect(0, 0, 300, 50)], 1, { handle: 'w', min: { w: 8, h: 8 } });
    expect(resized.x).toBe(296);
    expect(resized.w).toBe(10);
    expect(resized.guides).toEqual([]);
  });

  it('an e resize ignores the vertical axis', () => {
    const resized = snapRect('resize', rect(0, 203, 296, 100), others, 1, { handle: 'e' });
    expect(resized).toMatchObject({ x: 0, y: 203, w: 300, h: 100 });
  });
});

describe('resizeRect', () => {
  const start = rect(100, 100, 200, 100);
  const free = { keepAspect: false, fromCenter: false, min: { w: 20, h: 20 } };

  it('moves only the dragged edges', () => {
    expect(resizeRect(start, 'se', { x: 50, y: 20 }, free)).toEqual(rect(100, 100, 250, 120));
    expect(resizeRect(start, 'nw', { x: 50, y: 20 }, free)).toEqual(rect(150, 120, 150, 80));
    expect(resizeRect(start, 'e', { x: 30, y: 99 }, free)).toEqual(rect(100, 100, 230, 100));
    expect(resizeRect(start, 'n', { x: 99, y: -40 }, free)).toEqual(rect(100, 60, 200, 140));
  });

  it('clamps to the minimum size, anchored at the opposite edge', () => {
    expect(resizeRect(start, 'w', { x: 500, y: 0 }, free)).toEqual(rect(280, 100, 20, 100));
  });

  it('keeps the aspect ratio on corners (dominant axis) and edges', () => {
    const locked = { ...free, keepAspect: true };
    expect(resizeRect(start, 'se', { x: 100, y: 10 }, locked)).toEqual(rect(100, 100, 300, 150));
    expect(resizeRect(start, 'se', { x: 10, y: 100 }, locked)).toEqual(rect(100, 100, 400, 200));
    const edge = resizeRect(start, 'e', { x: 100, y: 0 }, locked);
    expect(edge.w).toBe(300);
    expect(edge.h).toBe(150);
    expect(edge.y).toBe(75); // grows symmetrically on the free axis
  });

  it('⌥ resizes from the centre', () => {
    expect(resizeRect(start, 'se', { x: 20, y: 10 }, { ...free, fromCenter: true })).toEqual(rect(80, 90, 240, 120));
  });
});
