// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/canvas/canvas-node-geometry.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: position/width/height → x/y/w/h, metadata.groupId → parentId, nested groups
// (deepest containing group wins), board edge endpoint rules, group/ungroup predicates for the board op set.
import {
  BOARD_LAYOUT,
  type BoardEdgeKind,
  type BoardNodeKind,
} from '../api/board.js';
import {
  boardGroupDepth,
  childrenByParent,
  descendantIdSet,
  indexBoardNodes,
  subtreesFitUnder,
} from './tree.js';

export interface BoardRect { x: number; y: number; w: number; h: number }

/** The node shape the geometry helpers need; every `BoardNode` satisfies it. */
export interface BoardGeometryNode extends BoardRect {
  id: string;
  kind: BoardNodeKind;
  parentId?: string | undefined;
}

type IdCollection = ReadonlySet<string> | readonly string[];

function toIdSet(ids: IdCollection): ReadonlySet<string> {
  return ids instanceof Set ? ids : new Set(ids as readonly string[]);
}

export function boardNodeRect(node: BoardRect): BoardRect {
  return { x: node.x, y: node.y, w: node.w, h: node.h };
}

/** Bounding rect of the given rects (IC `nodeBounds`), or null for an empty list. */
export function boardNodesBounds(nodes: readonly BoardRect[]): BoardRect | null {
  if (nodes.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const node of nodes) {
    left = Math.min(left, node.x);
    top = Math.min(top, node.y);
    right = Math.max(right, node.x + node.w);
    bottom = Math.max(bottom, node.y + node.h);
  }
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/** True when the rects intersect after growing `b` by `gap` on every side. Touching edges do not overlap. */
export function rectsOverlap(a: BoardRect, b: BoardRect, gap = 0): boolean {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

export function containsCenter(group: BoardRect, node: BoardRect): boolean {
  const centerX = node.x + node.w / 2;
  const centerY = node.y + node.h / 2;
  return centerX >= group.x && centerX <= group.x + group.w && centerY >= group.y && centerY <= group.y + group.h;
}

/**
 * Group under the dragged nodes' centres. Dragging a group never drops it into another group. With nested groups the
 * deepest containing group wins; among equals the topmost (latest in paint order) wins.
 */
export function findGroupDropTarget<T extends BoardGeometryNode>(movedIds: IdCollection, nodes: readonly T[]): T | null {
  const moved = toIdSet(movedIds);
  const movingNodes: T[] = [];
  for (const node of nodes) {
    if (!moved.has(node.id)) continue;
    if (node.kind === 'group') return null;
    movingNodes.push(node);
  }
  if (movingNodes.length === 0) return null;
  const byId = indexBoardNodes(nodes);
  let best: T | null = null;
  let bestDepth = -1;
  // Walk backwards instead of copying and reversing; this runs on every drag frame.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const group = nodes[index]!;
    if (group.kind !== 'group' || moved.has(group.id)) continue;
    if (!movingNodes.some((node) => containsCenter(group, node))) continue;
    const depth = boardGroupDepth(group.id, byId);
    if (depth > bestDepth) {
      best = group;
      bestDepth = depth;
    }
  }
  return best;
}

/** Id of the deepest group containing the node's centre (never the node itself or one of its descendants). */
export function findContainingGroupId(node: BoardGeometryNode, nodes: readonly BoardGeometryNode[]): string | null {
  const excluded = node.kind === 'group' ? descendantIdSet(node.id, childrenByParent(nodes)) : new Set<string>();
  excluded.add(node.id);
  const byId = indexBoardNodes(nodes);
  let bestId: string | null = null;
  let bestDepth = -1;
  // Called once per moved node when a drag ends, so avoid copying the node list each time.
  for (let index = nodes.length - 1; index >= 0; index -= 1) {
    const group = nodes[index]!;
    if (group.kind !== 'group' || excluded.has(group.id) || !containsCenter(group, node)) continue;
    const depth = boardGroupDepth(group.id, byId);
    if (depth > bestDepth) {
      bestId = group.id;
      bestDepth = depth;
    }
  }
  return bestId;
}

/** Group rect wrapping its members: `groupPad` (24) on three sides and `groupHeader` (52) on top. */
export function groupWrapRect(members: readonly BoardRect[]): BoardRect {
  const pad = BOARD_LAYOUT.groupPad;
  const top = BOARD_LAYOUT.groupHeader;
  const bounds = boardNodesBounds(members);
  if (!bounds) return { x: 0, y: 0, w: pad * 2, h: top + pad };
  return { x: bounds.x - pad, y: bounds.y - top, w: bounds.w + pad * 2, h: bounds.h + top + pad };
}

/** Shifts the moved non-group nodes inside `group` (24 px inset) and parents them to it. Returns a new array. */
export function snapNodesIntoGroup<T extends BoardGeometryNode>(
  movedIds: IdCollection,
  nodes: readonly T[],
  group: BoardRect & { id: string },
): T[] {
  const moved = toIdSet(movedIds);
  const movingNodes = nodes.filter((node) => moved.has(node.id) && node.kind !== 'group');
  if (movingNodes.length === 0) return nodes.slice();
  const pad = BOARD_LAYOUT.groupPad;
  const bounds = boardNodesBounds(movingNodes)!;
  const left = group.x + pad;
  const top = group.y + pad;
  const right = group.x + group.w - pad;
  const bottom = group.y + group.h - pad;
  const boundsRight = bounds.x + bounds.w;
  const boundsBottom = bounds.y + bounds.h;
  const dx = bounds.w > right - left ? left - bounds.x
    : bounds.x < left ? left - bounds.x
      : boundsRight > right ? right - boundsRight : 0;
  const dy = bounds.h > bottom - top ? top - bounds.y
    : bounds.y < top ? top - bounds.y
      : boundsBottom > bottom ? bottom - boundsBottom : 0;
  return nodes.map((node) => {
    if (!moved.has(node.id) || node.kind === 'group') return node;
    return { ...node, x: node.x + dx, y: node.y + dy, parentId: group.id };
  });
}

/**
 * Whether the `group` op can wrap these nodes: at least two existing nodes that share one parent (or are all top
 * level), and the new group keeps every group within `BOARD_LIMITS.maxGroupDepth`.
 */
export function canGroupNodes(ids: IdCollection, nodes: readonly BoardGeometryNode[]): boolean {
  const idSet = toIdSet(ids);
  const members = nodes.filter((node) => idSet.has(node.id));
  if (members.length < 2) return false;
  const parentId = members[0]!.parentId ?? null;
  if (members.some((member) => (member.parentId ?? null) !== parentId)) return false;
  const byId = indexBoardNodes(nodes);
  if (parentId !== null && byId.get(parentId)?.kind !== 'group') return false;
  // The new group sits where the members were; the members move one level down.
  const children = childrenByParent(nodes);
  const syntheticId = '\u0000new-group';
  const syntheticById = new Map(byId);
  syntheticById.set(syntheticId, { id: syntheticId, kind: 'group', x: 0, y: 0, w: 0, h: 0, ...(parentId === null ? {} : { parentId }) });
  const syntheticChildren = new Map(children);
  syntheticChildren.set(syntheticId, members.map((member) => member.id));
  return subtreesFitUnder([syntheticId], parentId, syntheticById, syntheticChildren);
}

/** Whether "ungroup" applies: a selected group, or a selected node that sits inside a group. */
export function canUngroupNodes(ids: IdCollection, nodes: readonly BoardGeometryNode[]): boolean {
  const idSet = toIdSet(ids);
  return nodes.some((node) => idSet.has(node.id) && (node.kind === 'group' || node.parentId !== undefined));
}

/** Group nesting level of a node: its existing ancestors, plus one when the node itself is a group (top-level group = 1). */
export function groupDepth(id: string, byId: ReadonlyMap<string, Pick<BoardGeometryNode, 'id' | 'kind' | 'parentId'>>): number {
  return boardGroupDepth(id, byId);
}

/** Every descendant of `groupId` (children, grandchildren …) in array order. */
export function descendantIds(groupId: string, nodes: readonly Pick<BoardGeometryNode, 'id' | 'parentId'>[]): string[] {
  const all = descendantIdSet(groupId, childrenByParent(nodes));
  return nodes.filter((node) => all.has(node.id)).map((node) => node.id);
}

/** The top-level node containing `id` (the node itself when it has no parent). Cycle-safe. */
export function topLevelAncestorId(id: string, byId: ReadonlyMap<string, { parentId?: string | undefined }>): string {
  let current = id;
  const seen = new Set<string>([id]);
  for (;;) {
    const parentId = byId.get(current)?.parentId;
    if (parentId === undefined || !byId.has(parentId) || seen.has(parentId)) return current;
    seen.add(parentId);
    current = parentId;
  }
}

export type BoardEdgeEndpointError =
  | 'self-loop'
  | 'group-endpoint'
  | 'reference-target-not-generator'
  | 'output-source-not-generator'
  | 'output-target-not-media'
  | 'reference-source-invalid';

/** Kinds that may feed a generator through a `reference` edge (plan R3e). Groups are not connectable in phase 1. */
export const BOARD_REFERENCE_SOURCE_KINDS = ['image', 'note', 'frame', 'web', 'design'] as const satisfies readonly BoardNodeKind[];
/** Kinds a generator may write through an `output` edge. */
export const BOARD_OUTPUT_TARGET_KINDS = ['image', 'video', 'audio'] as const satisfies readonly BoardNodeKind[];

/**
 * Edge endpoint rules (plan R3e): `reference` image|note|frame|web|design → generator; `output` generator →
 * image|video|audio; `lineage` any non-group → any non-group. Self loops and group endpoints are never allowed.
 */
export function edgeEndpointError(
  kind: BoardEdgeKind,
  from: Pick<BoardGeometryNode, 'id' | 'kind'>,
  to: Pick<BoardGeometryNode, 'id' | 'kind'>,
): BoardEdgeEndpointError | null {
  if (from.id === to.id) return 'self-loop';
  if (from.kind === 'group' || to.kind === 'group') return 'group-endpoint';
  if (kind === 'reference') {
    if (to.kind !== 'generator') return 'reference-target-not-generator';
    if (!(BOARD_REFERENCE_SOURCE_KINDS as readonly BoardNodeKind[]).includes(from.kind)) return 'reference-source-invalid';
    return null;
  }
  if (kind === 'output') {
    if (from.kind !== 'generator') return 'output-source-not-generator';
    if (!(BOARD_OUTPUT_TARGET_KINDS as readonly BoardNodeKind[]).includes(to.kind)) return 'output-target-not-media';
    return null;
  }
  return null;
}
