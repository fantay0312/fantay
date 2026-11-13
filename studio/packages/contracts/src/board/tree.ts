// SPDX-License-Identifier: Apache-2.0
// Internal parent/child helpers shared by the board geometry, ops and validation modules (not re-exported).
import { BOARD_LIMITS } from '../api/board.js';

export interface BoardTreeNode {
  id: string;
  kind: string;
  parentId?: string | undefined;
}

export function indexBoardNodes<T extends { id: string }>(nodes: readonly T[]): Map<string, T> {
  const byId = new Map<string, T>();
  for (const node of nodes) byId.set(node.id, node);
  return byId;
}

/** parentId → child ids, in array (paint) order. */
export function childrenByParent(nodes: readonly { id: string; parentId?: string | undefined }[]): Map<string, string[]> {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentId === undefined) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  return children;
}

/** Existing ancestors of `id`, nearest first. Stops at a missing parent or a cycle. */
export function ancestorIds(id: string, byId: ReadonlyMap<string, { parentId?: string | undefined }>): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId;
  while (parentId !== undefined && byId.has(parentId) && !seen.has(parentId)) {
    result.push(parentId);
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return result;
}

/** True when following parentId from `id` returns to an already visited node. */
export function hasParentCycle(id: string, byId: ReadonlyMap<string, { parentId?: string | undefined }>): boolean {
  const seen = new Set<string>([id]);
  let parentId = byId.get(id)?.parentId;
  while (parentId !== undefined && byId.has(parentId)) {
    if (seen.has(parentId)) return true;
    seen.add(parentId);
    parentId = byId.get(parentId)?.parentId;
  }
  return false;
}

/** Group nesting level: number of existing ancestors, plus one when the node itself is a group. */
export function boardGroupDepth(id: string, byId: ReadonlyMap<string, BoardTreeNode>): number {
  const node = byId.get(id);
  if (!node) return 0;
  return ancestorIds(id, byId).length + (node.kind === 'group' ? 1 : 0);
}

/** Height of the group chain rooted at `id`: 0 for a non-group, 1 + the tallest child group chain for a group. */
export function groupChainHeight(
  id: string,
  byId: ReadonlyMap<string, BoardTreeNode>,
  children: ReadonlyMap<string, readonly string[]>,
  seen: Set<string> = new Set(),
): number {
  const node = byId.get(id);
  if (!node || node.kind !== 'group' || seen.has(id)) return 0;
  seen.add(id);
  let tallest = 0;
  for (const childId of children.get(id) ?? []) {
    tallest = Math.max(tallest, groupChainHeight(childId, byId, children, seen));
  }
  return 1 + tallest;
}

/**
 * Whether the subtrees rooted at `rootIds` stay within `BOARD_LIMITS.maxGroupDepth` when they become children of
 * `parentId` (null = top level). A group may contain groups; a nested group may not.
 */
export function subtreesFitUnder(
  rootIds: readonly string[],
  parentId: string | null,
  byId: ReadonlyMap<string, BoardTreeNode>,
  children: ReadonlyMap<string, readonly string[]>,
): boolean {
  const parentDepth = parentId === null ? 0 : boardGroupDepth(parentId, byId);
  return rootIds.every((id) => parentDepth + groupChainHeight(id, byId, children) <= BOARD_LIMITS.maxGroupDepth);
}

/** All descendants of `groupId` (cycle-safe), as a set. */
export function descendantIdSet(groupId: string, children: ReadonlyMap<string, readonly string[]>): Set<string> {
  const result = new Set<string>();
  const queue = [groupId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const childId of children.get(current) ?? []) {
      if (childId === groupId || result.has(childId)) continue;
      result.add(childId);
      queue.push(childId);
    }
  }
  return result;
}
