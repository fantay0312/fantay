// SPDX-License-Identifier: AGPL-3.0-only
// 04 contract ⇄ engine document (spec 03 §2 contract-adapter.ts, plan R1). The engine never owns the document:
// it derives an `EngineDoc` from the 04 store's `BoardDocument`. Engine nodes are memoized per contract node
// object (a WeakMap keyed by identity), so a document update that replaces one node keeps every other engine
// node identical and React re-renders only what changed. Unknown contract keys stay on `node.source`.
import {
  BOARD_PATCH_KEYS_BY_KIND,
  boardNodePageId,
  boardPagesOf,
  resolveBoardPageId,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
  type BoardNodePatch,
} from '@open-design/contracts';

import type { EngineDoc, EngineEdge, EngineNode } from './types';

const NODE_CACHE = new WeakMap<BoardNode, EngineNode>();
const EDGE_CACHE = new WeakMap<BoardEdge, EngineEdge>();

/** Engine view of one contract node; the same object for the same contract node. */
export function toEngineNode(node: BoardNode): EngineNode {
  const cached = NODE_CACHE.get(node);
  if (cached) return cached;
  const engine = Object.freeze({
    id: node.id,
    kind: node.kind,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
    title: typeof node.title === 'string' && node.title.length > 0 ? node.title : undefined,
    parentId: typeof node.parentId === 'string' ? node.parentId : null,
    variantLabel: typeof node.variantLabel === 'string' && node.variantLabel.length > 0 ? node.variantLabel : undefined,
    locked: node.locked === true,
    hidden: node.hidden === true,
    missing: node.missing !== undefined && node.missing !== null,
    data: node,
    source: node,
  }) as unknown as EngineNode;
  NODE_CACHE.set(node, engine);
  return engine;
}

export function toEngineEdge(edge: BoardEdge): EngineEdge {
  const cached = EDGE_CACHE.get(edge);
  if (cached) return cached;
  const engine: EngineEdge = Object.freeze({
    id: edge.id,
    from: edge.from,
    to: edge.to,
    kind: edge.kind,
    label: typeof edge.label === 'string' && edge.label.length > 0 ? edge.label : undefined,
    source: edge,
  });
  EDGE_CACHE.set(edge, engine);
  return engine;
}

const EMPTY_NODES: ReadonlyMap<string, EngineNode> = new Map();
const EMPTY_EDGES: ReadonlyMap<string, EngineEdge> = new Map();
const EMPTY_INDEX: ReadonlyMap<string, number> = new Map();
const EMPTY_CHILDREN: ReadonlyMap<string, readonly string[]> = new Map();
const EMPTY_ORDER: readonly string[] = Object.freeze([]);

export function emptyEngineDoc(projectId: string): EngineDoc {
  return {
    projectId,
    revision: 0,
    pageId: null,
    nodes: EMPTY_NODES,
    edges: EMPTY_EDGES,
    order: EMPTY_ORDER,
    arrayIndex: EMPTY_INDEX,
    children: EMPTY_CHILDREN,
    source: null,
  };
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Derives the engine document of one page: the engine (culling, selection, minimap, fit) only ever sees that page.
 * Returns `prev` unchanged when the 04 document and the page are the same; keeps the previous `order` array when
 * the paint order did not change. `arrayIndex` stays the index in the whole document (z-order ops use it).
 */
export function toEngineDoc(board: BoardDocument | null, projectId: string, prev?: EngineDoc | null, pageId?: string | null): EngineDoc {
  if (!board) return prev && prev.source === null && prev.projectId === projectId ? prev : emptyEngineDoc(projectId);
  const pages = boardPagesOf(board);
  const shownPage = resolveBoardPageId(pages, pageId);
  if (prev && prev.source === board && prev.projectId === projectId && prev.pageId === shownPage) return prev;

  const nodes = new Map<string, EngineNode>();
  const arrayIndex = new Map<string, number>();
  const groups: string[] = [];
  const others: string[] = [];
  const children = new Map<string, string[]>();
  board.nodes.forEach((raw, index) => {
    if (boardNodePageId(raw, pages) !== shownPage) return;
    const node = toEngineNode(raw);
    nodes.set(node.id, node);
    arrayIndex.set(node.id, index);
    if (node.kind === 'group') groups.push(node.id);
    else others.push(node.id);
  });
  for (const node of nodes.values()) {
    if (node.parentId === null || !nodes.has(node.parentId)) continue;
    const list = children.get(node.parentId);
    if (list) list.push(node.id);
    else children.set(node.parentId, [node.id]);
  }
  const edges = new Map<string, EngineEdge>();
  for (const raw of board.edges) {
    if (!nodes.has(raw.from) || !nodes.has(raw.to)) continue;
    const edge = toEngineEdge(raw);
    edges.set(edge.id, edge);
  }
  const nextOrder = [...groups, ...others];
  return {
    projectId,
    revision: board.revision,
    pageId: shownPage,
    nodes,
    edges,
    order: prev && sameIds(prev.order, nextOrder) ? prev.order : nextOrder,
    arrayIndex,
    children,
    source: board,
  };
}

/** The contract node of an engine node (identity: the engine node is a view of it). */
export function toContractNode(node: EngineNode): BoardNode {
  return node.source;
}

/** Engine nodes in paint order. */
export function nodesInOrder(doc: EngineDoc): EngineNode[] {
  const list: EngineNode[] = [];
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node) list.push(node);
  }
  return list;
}

/** Plain-JSON deep equality (board values are JSON). */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((value, index) => jsonEqual(value, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => jsonEqual(left[key], right[key]));
}

/** Contract node with a contract patch applied (`null` deletes the key). Unknown keys survive. */
export function applyNodePatch(node: BoardNode, patch: BoardNodePatch): BoardNode {
  const next: Record<string, unknown> = { ...node };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else next[key] = value;
  }
  return next as unknown as BoardNode;
}

/**
 * Minimal contract patch that turns `before` into `after` (same id and kind): only keys patchable for the kind
 * (`BOARD_PATCH_KEYS_BY_KIND`), `null` for removed optional keys. Returns null when nothing changed.
 */
export function diffNodes(before: BoardNode, after: BoardNode): BoardNodePatch | null {
  const allowed = BOARD_PATCH_KEYS_BY_KIND[before.kind];
  const left = before as unknown as Record<string, unknown>;
  const right = after as unknown as Record<string, unknown>;
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    const prev = left[key];
    const next = right[key];
    if (jsonEqual(prev, next)) continue;
    patch[key] = next === undefined ? null : next;
  }
  return Object.keys(patch).length > 0 ? (patch as BoardNodePatch) : null;
}

/** Primary project file a node shows (frame/image/video/audio/design ref, motion composition source). */
export function nodeFilePath(node: EngineNode): string | null {
  switch (node.kind) {
    case 'frame':
    case 'image':
    case 'video':
    case 'audio':
      return node.data.ref ? node.data.ref.path : null;
    case 'design':
      return node.data.ref.path;
    case 'motion':
      return node.data.source.type === 'composition' ? node.data.source.ref.path : null;
    default:
      return null;
  }
}

/** Every project file a node references (motion: composition source and render). */
export function nodeFilePaths(node: EngineNode): string[] {
  const primary = nodeFilePath(node);
  const paths = primary ? [primary] : [];
  if (node.kind === 'motion' && node.data.render) paths.push(node.data.render.path);
  return paths;
}

/** Invariant I1: the node showing `path` (first in paint order), if any. */
export function findNodeByPath(doc: EngineDoc, path: string): EngineNode | undefined {
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && nodeFilePath(node) === path) return node;
  }
  return undefined;
}

/** Ancestor ids of a node, nearest first (cycle-safe). */
export function ancestorsOf(doc: EngineDoc, id: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([id]);
  let current = doc.nodes.get(id)?.parentId ?? null;
  while (current !== null && doc.nodes.has(current) && !seen.has(current)) {
    result.push(current);
    seen.add(current);
    current = doc.nodes.get(current)?.parentId ?? null;
  }
  return result;
}

/** Every descendant of a group (children, grandchildren, …). */
export function descendantsOf(doc: EngineDoc, groupId: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>([groupId]);
  const stack = [...(doc.children.get(groupId) ?? [])];
  while (stack.length > 0) {
    const id = stack.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const child of doc.children.get(id) ?? []) stack.push(child);
  }
  return result;
}
