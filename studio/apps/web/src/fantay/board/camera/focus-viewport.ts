// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/canvas/canvas-node-geometry.ts (focusViewportForNode).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: node `position/width/height` → board rect `x/y/w/h`, viewport `{x, y, k}`
// → camera `{x, y, zoom}` (plan R1 keeps only this port of the infinite-canvas geometry in camera/).
import type { Rect, Size } from '../model/types';
import type { Camera } from './camera';

export type FocusFrame = {
  // Screen-space room taken above/below the node by open overlays (hover toolbar, prompt panel), gaps included.
  above?: number;
  below?: number;
  // Fixed chrome covering the bottom edge of the canvas (dock), excluded from the usable area.
  bottomInset?: number;
};

// Viewport that centers the node (plus any open overlay above/below) in the usable canvas area, zoomed so the
// whole thing fits (the node itself is kept within 60% of the viewport). When an overlay is open below the node,
// the remaining space is split 3:1 so the panel sits closer to the bottom dock (half the usual bottom gap).
export function focusViewportForNode(node: Pick<Rect, 'x' | 'y' | 'w' | 'h'>, size: Size, frame: FocusFrame = {}): Camera {
  const above = frame.above ?? 0;
  const below = frame.below ?? 0;
  const usableBottom = Math.max(0, size.h - (frame.bottomInset ?? 0));
  const nodeCenterX = node.x + node.w / 2;
  const nodeCenterY = node.y + node.h / 2;
  const verticalRoom = usableBottom * 0.92 - above - below;
  const k = Math.min(Math.max(Math.min((size.w * 0.6) / node.w, (size.h * 0.6) / node.h, verticalRoom / node.h), 0.05), 1);
  const groupHeight = above + node.h * k + below;
  const slack = usableBottom - groupHeight;
  const groupTop = slack * (below > 0 && slack > 0 ? 0.75 : 0.5);
  return { x: size.w / 2 - nodeCenterX * k, y: groupTop + groupHeight / 2 - nodeCenterY * k - (below - above) / 2, zoom: k };
}
