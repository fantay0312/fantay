// SPDX-License-Identifier: Apache-2.0
// Applying a `BoardChangeSet` (PATCH/sync response) to a client copy of the board (spec 04 §3.2 changes.ts).
import type { BoardChangeSet, BoardDocument, BoardEdge, BoardNode } from '../api/board.js';
import { compareBoardEdges } from './defaults.js';

export { compareBoardEdges } from './defaults.js';

export function emptyBoardChangeSet(from: number, to: number): BoardChangeSet {
  return { fromRevision: from, toRevision: to, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] };
}

export function isEmptyBoardChangeSet(c: BoardChangeSet): boolean {
  return c.upsertNodes.length === 0
    && c.removeNodeIds.length === 0
    && c.upsertEdges.length === 0
    && c.removeEdgeIds.length === 0
    && c.order === undefined
    && c.meta === undefined;
}

function upsertInPlace<T extends { id: string }>(current: readonly T[], removeIds: readonly string[], upserts: readonly T[]): T[] {
  const removed = new Set(removeIds);
  const byId = new Map(upserts.map((entry) => [entry.id, entry]));
  const next: T[] = [];
  const present = new Set<string>();
  for (const entry of current) {
    if (removed.has(entry.id)) continue;
    next.push(byId.get(entry.id) ?? entry);
    present.add(entry.id);
  }
  for (const entry of upserts) {
    if (present.has(entry.id)) continue;
    next.push(entry);
    present.add(entry.id);
  }
  return next;
}

function reorderNodes(nodes: readonly BoardNode[], order: readonly string[]): BoardNode[] {
  const rank = new Map<string, number>();
  order.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
  const listed = nodes.filter((node) => rank.has(node.id)).sort((a, b) => rank.get(a.id)! - rank.get(b.id)!);
  return [...listed, ...nodes.filter((node) => !rank.has(node.id))];
}

/**
 * Remove, then replace in place, append new ids in `upsertNodes` order, then apply `order` when present. Edges keep
 * the canonical order (`createdAt`, then `id`). Unchanged nodes keep their object identity. `revision` becomes
 * `toRevision`; the document's `updatedAt` / `updatedBy` / `viewport` / `sync` are left as they are.
 */
export function applyBoardChangeSet(doc: BoardDocument, changes: BoardChangeSet): BoardDocument {
  if (isEmptyBoardChangeSet(changes) && changes.toRevision === doc.revision) return doc;
  let nodes = upsertInPlace(doc.nodes, changes.removeNodeIds, changes.upsertNodes);
  if (changes.order) nodes = reorderNodes(nodes, changes.order);
  const edges: BoardEdge[] = upsertInPlace(doc.edges, changes.removeEdgeIds, changes.upsertEdges).sort(compareBoardEdges);
  const { title: currentTitle, pages: currentPages, ...rest } = doc;
  const title = changes.meta ? changes.meta.title : currentTitle ?? null;
  const pages = changes.meta && changes.meta.pages !== undefined ? changes.meta.pages : currentPages ?? null;
  return {
    ...rest,
    ...(title !== null ? { title } : {}),
    ...(pages !== null ? { pages } : {}),
    settings: changes.meta ? changes.meta.settings : doc.settings,
    nodes,
    edges,
    revision: changes.toRevision,
  };
}
