// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/pages/canvas/project.tsx (viewBounds, visibleNodes,
// visibleConnections, L691-726).
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: pure functions over the board camera; overscan grows with the stage
// (spec 03 §3.4), hidden nodes never render, always-included ids, LOD and label thresholds, stable id lists.
import type { Camera } from '../camera/camera';
import type { EngineNode, Rect, Size } from '../model/types';

/** infinite-canvas padding 280 */
export const OVERSCAN_WORLD_MIN = 280;
/** below: render a flat kind-coloured rect, no images/iframes */
export const LOD_MIN_SCREEN_PX = 24;
/** below: no label */
export const LABEL_MIN_SCREEN_PX = 48;
/** below: glyph + dot only */
export const LABEL_GLYPH_ONLY_SCREEN_PX = 120;

/** Overscan in world px: max(280, 0.25 × max(stage w, h) / zoom). */
export function overscanWorld(cam: Camera, stage: Size): number {
  return Math.max(OVERSCAN_WORLD_MIN, (0.25 * Math.max(stage.w, stage.h)) / cam.zoom);
}

/** World bounds of the culling window (view + overscan). */
export function cullBounds(cam: Camera, stage: Size): Rect {
  const pad = overscanWorld(cam, stage);
  const left = -cam.x / cam.zoom - pad;
  const top = -cam.y / cam.zoom - pad;
  return { x: left, y: top, w: stage.w / cam.zoom + pad * 2, h: stage.h / cam.zoom + pad * 2 };
}

function overlapsBounds(r: Rect, bounds: Rect): boolean {
  return r.x + r.w > bounds.x && r.x < bounds.x + bounds.w && r.y + r.h > bounds.y && r.y < bounds.y + bounds.h;
}

export interface VisibleInput {
  /** nodes in paint order */
  nodesInOrder: readonly EngineNode[];
  cam: Camera;
  stage: Size;
  /** selection, mode node, live ids, preview rect ids, editing/renaming ids */
  alwaysInclude?: ReadonlySet<string>;
  /** drag/resize preview rects (a dragged node is tested where it is drawn) */
  previewRects?: ReadonlyMap<string, Rect>;
}

/**
 * Ids of the nodes to render, in paint order. Hidden nodes are never visible; a group counts as visible when its
 * own rect intersects (its children are tested independently).
 */
export function computeVisibleIds(input: VisibleInput): string[] {
  const bounds = cullBounds(input.cam, input.stage);
  const always = input.alwaysInclude;
  const ids: string[] = [];
  for (const node of input.nodesInOrder) {
    if (node.hidden) continue;
    if (always?.has(node.id)) {
      ids.push(node.id);
      continue;
    }
    const rect = input.previewRects?.get(node.id) ?? node;
    if (overlapsBounds(rect, bounds)) ids.push(node.id);
  }
  return ids;
}

/** Connection endpoints of an edge (right-middle of the source, left-middle of the target). */
export function edgeEndpoints(from: Rect, to: Rect): { startX: number; startY: number; endX: number; endY: number; curvature: number } {
  const startX = from.x + from.w;
  const startY = from.y + from.h / 2;
  const endX = to.x;
  const endY = to.y + to.h / 2;
  return { startX, startY, endX, endY, curvature: Math.max(Math.abs(endX - startX) * 0.5, 50) };
}

/**
 * A cubic curve stays inside its control-point hull, so the endpoint bounds widened by the curvature are a safe
 * visibility test.
 */
export function edgeInView(from: Rect, to: Rect, bounds: Rect): boolean {
  const { startX, startY, endX, endY, curvature } = edgeEndpoints(from, to);
  const right = bounds.x + bounds.w;
  const bottom = bounds.y + bounds.h;
  return (
    Math.max(startX + curvature, endX) > bounds.x
    && Math.min(startX, endX - curvature) < right
    && Math.max(startY, endY) > bounds.y
    && Math.min(startY, endY) < bottom
  );
}

/** Below `LOD_MIN_SCREEN_PX` on screen the node renders as a flat rect. */
export function isLod(size: { w: number; h: number }, zoom: number): boolean {
  return Math.max(size.w, size.h) * zoom < LOD_MIN_SCREEN_PX;
}

/** O(n) comparison of two id lists. */
export function sameIdList(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
