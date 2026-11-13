// SPDX-License-Identifier: AGPL-3.0-only
// Screen-space placement of a world rect (spec 03 §3.1 formula). The camera writes --vx/--vy/--zoom on the board
// root, so overlays and labels follow pan/zoom without React.
import type { CSSProperties } from 'react';

import type { Rect } from '../model/types';

/** `left/top/width/height` of a world rect on screen, grown by `outset` screen px on every side. */
export function screenBox(rect: Rect, outset = 0): CSSProperties {
  const o = outset === 0 ? '' : ` - ${outset}px`;
  const g = outset === 0 ? '' : ` + ${outset * 2}px`;
  return {
    left: `calc(var(--vx, 0px) + ${rect.x}px * var(--zoom, 1)${o})`,
    top: `calc(var(--vy, 0px) + ${rect.y}px * var(--zoom, 1)${o})`,
    width: `calc(${rect.w}px * var(--zoom, 1)${g})`,
    height: `calc(${rect.h}px * var(--zoom, 1)${g})`,
  };
}

/** A world point on screen. */
export function screenPoint(x: number, y: number): CSSProperties {
  return {
    left: `calc(var(--vx, 0px) + ${x}px * var(--zoom, 1))`,
    top: `calc(var(--vy, 0px) + ${y}px * var(--zoom, 1))`,
  };
}
