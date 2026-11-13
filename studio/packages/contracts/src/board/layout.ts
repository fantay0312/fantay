// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/canvas/canvas-node-size.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: width/height → w/h, nodeSizeFromRatio → nodeSizeFromAspect; the board default
// sizes, placement modes and group layouts of spec 04 §4.4.4 are Fantay additions.
import {
  BOARD_DEFAULT_SIZES,
  BOARD_DEVICE_SIZES,
  BOARD_LAYOUT,
  type BoardDevice,
  type BoardNodeKind,
  type BoardPlacement,
} from '../api/board.js';
import { boardNodesBounds, rectsOverlap, topLevelAncestorId, type BoardRect } from './geometry.js';
import { indexBoardNodes } from './tree.js';
import { compareBoardVariantLabels } from './variants.js';

export interface BoardSize { w: number; h: number }

/** Minimum rect of an auto-layout group after `refitGroupRect`. */
export const BOARD_GROUP_MIN_SIZE = { w: 160, h: 120 } as const;

const DECK_FRAME_SIZE: BoardSize = { w: 1280, h: 720 };
const MOTION_SIZES: Record<'16:9' | '9:16' | '1:1', BoardSize> = {
  '16:9': { w: 960, h: 540 },
  '9:16': { w: 405, h: 720 },
  '1:1': { w: 720, h: 720 },
};

/** Scales (never enlarges) a size to fit inside maxW × maxH (IC `fitNodeSize`). */
export function fitNodeSize(w: number, h: number, maxW = 640, maxH = 640): BoardSize {
  const width = Math.max(1, w);
  const height = Math.max(1, h);
  const scale = Math.min(1, maxW / width, maxH / height);
  return { w: width * scale, h: height * scale };
}

/**
 * Size for an aspect such as `16:9` or `1080x1920` inside baseW × baseH (IC `nodeSizeFromRatio`): extreme ratios
 * (< 1:4 or > 4:1) fall back to the base size; unparseable input gives null.
 */
export function nodeSizeFromAspect(aspect: string, baseW: number, baseH: number): BoardSize | null {
  const match = typeof aspect === 'string' ? /^(\d+)(?:x|:)(\d+)/.exec(aspect) : null;
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  const ratio = width / Math.max(1, height);
  if (ratio < 0.25 || ratio > 4) return { w: baseW, h: baseH };
  return ratio >= baseW / baseH ? { w: baseW, h: baseW / ratio } : { w: baseH * ratio, h: baseH };
}

export interface BoardNodeSizeHints {
  device?: BoardDevice | undefined;
  /** Motion: '16:9' | '9:16' | '1:1'. Image/video: any `W:H` / `WxH` aspect (rounded to whole px). */
  aspect?: string | undefined;
  projectKind?: string | undefined;
  /** Accepted for call-site symmetry with media tasks; sizes do not depend on it today. */
  surface?: string | undefined;
}

/** Default size for a new node; frame/web results also carry the device the size corresponds to. */
export function defaultBoardNodeSize(kind: BoardNodeKind, hints: BoardNodeSizeHints = {}): BoardSize & { device?: BoardDevice } {
  switch (kind) {
    case 'frame':
    case 'web': {
      const device = hints.device;
      if (device !== undefined && device !== 'custom') return { ...BOARD_DEVICE_SIZES[device], device };
      if (hints.projectKind === 'deck') return { ...DECK_FRAME_SIZE, device: 'custom' };
      if (device === 'custom') return { ...BOARD_DEFAULT_SIZES[kind], device: 'custom' };
      return { ...BOARD_DEVICE_SIZES.desktop, device: 'desktop' };
    }
    case 'image':
    case 'video': {
      const base = BOARD_DEFAULT_SIZES[kind];
      const sized = hints.aspect ? nodeSizeFromAspect(hints.aspect, base.w, base.h) : null;
      return sized ? { w: Math.round(sized.w), h: Math.round(sized.h) } : { ...base };
    }
    case 'motion': {
      const aspect = hints.aspect;
      if (aspect === '9:16' || aspect === '1:1' || aspect === '16:9') return { ...MOTION_SIZES[aspect] };
      return { ...MOTION_SIZES['16:9'] };
    }
    case 'group':
      return { ...BOARD_GROUP_MIN_SIZE };
    default:
      return { ...BOARD_DEFAULT_SIZES[kind] };
  }
}

const MOBILE_PATH_PATTERN = /(^|[\/._-])(mobile|ios|android|iphone|phone)([\/._-]|$)/i;
const TABLET_PATH_PATTERN = /(tablet|ipad)/i;

/** Device of a frame placed from a project file: deck projects → custom; else mobile, tablet, desktop (spec 04 §4.4.4). */
export function deviceForFramePath(path: string, platform?: string | null, projectKind?: string | null): BoardDevice {
  if (projectKind === 'deck') return 'custom';
  if (platform === 'mobile-ios' || platform === 'mobile-android' || MOBILE_PATH_PATTERN.test(path)) return 'mobile';
  if (platform === 'tablet' || TABLET_PATH_PATTERN.test(path)) return 'tablet';
  return 'desktop';
}

// ---- placement ----------------------------------------------------------------

export interface BoardPlaceOptions {
  /** Nodes that neither count for collisions nor for the content bounds (e.g. the nodes being placed). */
  ignoreIds?: readonly string[] | undefined;
  /** Gap between several items placed by one call (default `BOARD_LAYOUT.itemGap`). */
  gap?: number | undefined;
}

type PlacementNode = BoardRect & { id: string; parentId?: string | undefined };

function topLevelRects(nodes: readonly PlacementNode[], ignore: ReadonlySet<string>): PlacementNode[] {
  const byId = indexBoardNodes(nodes);
  return nodes.filter((node) => !ignore.has(node.id) && (node.parentId === undefined || !byId.has(node.parentId)));
}

function autoOrigin(topLevel: readonly BoardRect[]): { x: number; y: number } {
  const bounds = boardNodesBounds(topLevel);
  return bounds ? { x: bounds.x, y: bounds.y + bounds.h + BOARD_LAYOUT.clusterGapY } : { x: 0, y: 0 };
}

function spiralOffsets(maxSteps: number): Array<[number, number]> {
  const offsets: Array<[number, number]> = [];
  let x = 0;
  let y = 0;
  let dx = 1;
  let dy = 0;
  let segmentLength = 1;
  let segmentPassed = 0;
  let turns = 0;
  for (let step = 0; step < maxSteps; step += 1) {
    offsets.push([x, y]);
    x += dx;
    y += dy;
    segmentPassed += 1;
    if (segmentPassed === segmentLength) {
      segmentPassed = 0;
      [dx, dy] = [-dy, dx];
      turns += 1;
      if (turns % 2 === 0) segmentLength += 1;
    }
  }
  return offsets;
}

function blockOrigin(
  nodes: readonly PlacementNode[],
  topLevel: readonly PlacementNode[],
  block: BoardSize,
  placement: BoardPlacement,
): { x: number; y: number } {
  switch (placement.mode) {
    case 'at':
      return { x: placement.x, y: placement.y };
    case 'near': {
      const byId = indexBoardNodes(nodes);
      const base = byId.get(placement.nodeId);
      if (!base) return autoOrigin(topLevel);
      const anchorId = topLevelAncestorId(base.id, byId);
      const others = topLevel.filter((node) => node.id !== anchorId);
      let candidate = placement.side === 'below'
        ? { x: base.x, y: base.y + base.h + BOARD_LAYOUT.itemGap }
        : { x: base.x + base.w + BOARD_LAYOUT.itemGap, y: base.y };
      for (let attempt = 0; attempt <= 50; attempt += 1) {
        const rect = { x: candidate.x, y: candidate.y, w: block.w, h: block.h };
        let lowest: BoardRect | null = null;
        for (const other of others) {
          if (!rectsOverlap(rect, other)) continue;
          if (!lowest || other.y + other.h > lowest.y + lowest.h) lowest = other;
        }
        if (!lowest) return candidate;
        if (attempt === 50) break;
        candidate = { x: candidate.x, y: lowest.y + lowest.h + BOARD_LAYOUT.itemGap };
      }
      return autoOrigin(topLevel);
    }
    case 'viewport': {
      const start = { x: placement.centerX - block.w / 2, y: placement.centerY - block.h / 2 };
      for (const [ox, oy] of spiralOffsets(BOARD_LAYOUT.spiralMaxSteps)) {
        const rect = {
          x: start.x + ox * BOARD_LAYOUT.spiralStep,
          y: start.y + oy * BOARD_LAYOUT.spiralStep,
          w: block.w,
          h: block.h,
        };
        if (!topLevel.some((node) => rectsOverlap(rect, node, BOARD_LAYOUT.itemGap / 2))) return { x: rect.x, y: rect.y };
      }
      return autoOrigin(topLevel);
    }
    case 'auto':
    default:
      return autoOrigin(topLevel);
  }
}

/**
 * Top-left positions for new items (spec 04 §4.4.4). Several sizes form one row block (`itemGap`, wrapping at
 * `rowWrapWidth`) that is placed as a whole: `auto` below the current content, `near` beside/below a node (walking
 * down past collisions), `at` an exact point, `viewport` the nearest free spiral slot around a world point.
 * Results are rounded to whole world px, in input order.
 */
export function placeBoardItems(
  content: { nodes: readonly PlacementNode[] },
  sizes: readonly BoardSize[],
  placement: BoardPlacement,
  opts: BoardPlaceOptions = {},
): Array<{ x: number; y: number }> {
  if (sizes.length === 0) return [];
  const items = sizes.map((size, index) => ({ id: String(index), x: 0, y: 0, w: size.w, h: size.h }));
  const relative = layoutRow(items, { x: 0, y: 0 }, opts.gap ?? BOARD_LAYOUT.itemGap, BOARD_LAYOUT.rowWrapWidth, 'input');
  const relativeById = new Map(relative.map((position) => [position.id, position]));
  let blockW = 0;
  let blockH = 0;
  for (const item of items) {
    const position = relativeById.get(item.id)!;
    blockW = Math.max(blockW, position.x + item.w);
    blockH = Math.max(blockH, position.y + item.h);
  }
  const nodes = content.nodes;
  const topLevel = topLevelRects(nodes, new Set(opts.ignoreIds ?? []));
  const origin = blockOrigin(nodes, topLevel, { w: blockW, h: blockH }, placement);
  return items.map((item) => {
    const position = relativeById.get(item.id)!;
    return { x: Math.round(origin.x + position.x), y: Math.round(origin.y + position.y) };
  });
}

// ---- group and selection layouts ----------------------------------------------

/** 'variant': variant label (natural), then `origin.batchIndex`, then x. 'position': y, then x. 'input': as given. */
export type BoardLayoutOrder = 'variant' | 'position' | 'input';

export interface BoardLayoutItem extends BoardRect {
  id: string;
  variantLabel?: string | undefined;
  origin?: { batchIndex?: number | undefined } | undefined;
}
export interface BoardLayoutPosition { id: string; x: number; y: number }

function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Stable, deterministic sort used by every layout (ties fall back to id, then input order). */
export function sortBoardLayoutItems<T extends BoardLayoutItem>(items: readonly T[], order: BoardLayoutOrder): T[] {
  if (order === 'input') return items.slice();
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const a = left.item;
      const b = right.item;
      if (order === 'variant') {
        const byLabel = compareBoardVariantLabels(a.variantLabel ?? '', b.variantLabel ?? '');
        if (byLabel !== 0) return byLabel;
        const batchA = a.origin?.batchIndex ?? -1;
        const batchB = b.origin?.batchIndex ?? -1;
        if (batchA !== batchB) return batchA - batchB;
        if (a.x !== b.x) return a.x - b.x;
        if (a.y !== b.y) return a.y - b.y;
      } else {
        if (a.y !== b.y) return a.y - b.y;
        if (a.x !== b.x) return a.x - b.x;
      }
      return compareIds(a.id, b.id) || left.index - right.index;
    })
    .map(({ item }) => item);
}

/** Left-to-right rows; wraps when an item would cross `origin.x + wrapWidth` (never before the first item of a row). */
export function layoutRow(
  children: readonly BoardLayoutItem[],
  origin: { x: number; y: number },
  gap: number,
  wrapWidth: number,
  order: BoardLayoutOrder,
): BoardLayoutPosition[] {
  const positions: BoardLayoutPosition[] = [];
  let x = origin.x;
  let rowTop = origin.y;
  let rowMaxH = 0;
  for (const child of sortBoardLayoutItems(children, order)) {
    if (x > origin.x && x + child.w > origin.x + wrapWidth) {
      rowTop += rowMaxH + gap;
      x = origin.x;
      rowMaxH = 0;
    }
    positions.push({ id: child.id, x, y: rowTop });
    x += child.w + gap;
    rowMaxH = Math.max(rowMaxH, child.h);
  }
  return positions;
}

/** Uniform cells (max w × max h), `columns ?? ceil(sqrt(n))` per row, filled in reading order. */
export function layoutGrid(
  children: readonly BoardLayoutItem[],
  origin: { x: number; y: number },
  gap: number,
  columns?: number,
  order: BoardLayoutOrder = 'position',
): BoardLayoutPosition[] {
  const sorted = sortBoardLayoutItems(children, order);
  if (sorted.length === 0) return [];
  const columnCount = Math.max(1, Math.floor(columns ?? Math.ceil(Math.sqrt(sorted.length))));
  let cellW = 0;
  let cellH = 0;
  for (const child of sorted) {
    cellW = Math.max(cellW, child.w);
    cellH = Math.max(cellH, child.h);
  }
  return sorted.map((child, index) => ({
    id: child.id,
    x: origin.x + (index % columnCount) * (cellW + gap),
    y: origin.y + Math.floor(index / columnCount) * (cellH + gap),
  }));
}

/** One vertical stack, no wrapping. */
export function layoutColumn(
  children: readonly BoardLayoutItem[],
  origin: { x: number; y: number },
  gap: number,
  order: BoardLayoutOrder = 'position',
): BoardLayoutPosition[] {
  let y = origin.y;
  return sortBoardLayoutItems(children, order).map((child) => {
    const position = { id: child.id, x: origin.x, y };
    y += child.h + gap;
    return position;
  });
}

/** Top-level items stacked at the content's left edge in y-then-x order, `clusterGapY` apart. */
export function layoutTidyTopLevel(
  content: { nodes: readonly (BoardLayoutItem & { parentId?: string | undefined })[] },
): BoardLayoutPosition[] {
  const nodes = content.nodes;
  const byId = indexBoardNodes(nodes);
  const topLevel = nodes.filter((node) => node.parentId === undefined || !byId.has(node.parentId));
  const bounds = boardNodesBounds(topLevel);
  if (!bounds) return [];
  let y = bounds.y;
  return sortBoardLayoutItems(topLevel, 'position').map((node) => {
    const position = { id: node.id, x: bounds.x, y };
    y += node.h + BOARD_LAYOUT.clusterGapY;
    return position;
  });
}

/** Keeps the group's top-left; grows/shrinks w/h to the children plus `groupPad` (minimum 160×120). */
export function refitGroupRect(group: BoardRect, children: readonly BoardRect[]): BoardRect {
  let maxRight = -Infinity;
  let maxBottom = -Infinity;
  for (const child of children) {
    maxRight = Math.max(maxRight, child.x + child.w);
    maxBottom = Math.max(maxBottom, child.y + child.h);
  }
  const w = children.length > 0 ? maxRight - group.x + BOARD_LAYOUT.groupPad : 0;
  const h = children.length > 0 ? maxBottom - group.y + BOARD_LAYOUT.groupPad : 0;
  return {
    x: group.x,
    y: group.y,
    w: Math.max(BOARD_GROUP_MIN_SIZE.w, w),
    h: Math.max(BOARD_GROUP_MIN_SIZE.h, h),
  };
}
