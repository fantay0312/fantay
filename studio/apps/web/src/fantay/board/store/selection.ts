// SPDX-License-Identifier: AGPL-3.0-only
// Pure selection reducers (spec 03 §3.7): click, toggle, marquee, select-all, Tab cycling in reading order,
// pruning after document changes and the drag set of a selection.
import { ancestorsOf, descendantsOf } from '../model/contract-adapter';
import { contains, intersects } from '../model/geometry';
import type { EngineDoc, EngineNode, Rect } from '../model/types';

/** Row tolerance (world px) of the Tab reading order. */
export const READING_ROW_TOLERANCE = 40;

export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/**
 * Press on a node with the Select tool: Shift or ⌘/Ctrl toggles; a node already in a multi-selection keeps the
 * selection (the drag moves the group); otherwise the node becomes the selection.
 */
export function pressSelect(selection: readonly string[], id: string, toggle: boolean): readonly string[] {
  if (toggle) return toggleSelect(selection, id);
  if (selection.includes(id)) return selection;
  return [id];
}

export function toggleSelect(selection: readonly string[], id: string): readonly string[] {
  return selection.includes(id) ? selection.filter((entry) => entry !== id) : [...selection, id];
}

function selectable(node: EngineNode): boolean {
  return !node.locked && !node.hidden;
}

/** Marquee hits: intersecting non-locked, non-hidden nodes; groups only when fully enclosed. */
export function marqueeHits(nodes: Iterable<EngineNode>, rect: Rect, rectOf?: (node: EngineNode) => Rect): string[] {
  const hits: string[] = [];
  for (const node of nodes) {
    if (!selectable(node)) continue;
    const r = rectOf ? rectOf(node) : node;
    if (node.kind === 'group' ? contains(rect, r) : intersects(rect, r)) hits.push(node.id);
  }
  return hits;
}

/** Shift-marquee keeps the previous selection and appends new hits in hit order. */
export function marqueeSelect(keep: readonly string[], hits: readonly string[]): readonly string[] {
  if (keep.length === 0) return hits;
  const kept = new Set(keep);
  return [...keep, ...hits.filter((id) => !kept.has(id))];
}

/** ⌘A: every non-locked, non-hidden node in paint order. */
export function selectAll(doc: EngineDoc): string[] {
  const ids: string[] = [];
  for (const id of doc.order) {
    const node = doc.nodes.get(id);
    if (node && selectable(node)) ids.push(id);
  }
  return ids;
}

/** Reading order: by y, then x, nodes within `READING_ROW_TOLERANCE` world px of a row's first y share the row. */
export function readingOrder(nodes: readonly EngineNode[]): string[] {
  const sorted = [...nodes].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const rows: EngineNode[][] = [];
  for (const node of sorted) {
    const row = rows[rows.length - 1];
    if (row && row[0] && node.y - row[0].y <= READING_ROW_TOLERANCE) row.push(node);
    else rows.push([node]);
  }
  return rows.flatMap((row) => row.sort((a, b) => a.x - b.x || (a.id < b.id ? -1 : 1)).map((node) => node.id));
}

/** Tab / ⇧Tab: the next node in reading order after the last selected one (wraps). */
export function cycleSelection(doc: EngineDoc, selection: readonly string[], direction: 1 | -1): string | null {
  const candidates: EngineNode[] = [];
  for (const node of doc.nodes.values()) if (!node.hidden) candidates.push(node);
  const order = readingOrder(candidates);
  if (order.length === 0) return null;
  const current = selection[selection.length - 1];
  const index = current ? order.indexOf(current) : -1;
  if (index < 0) return direction === 1 ? order[0]! : order[order.length - 1]!;
  return order[(index + direction + order.length) % order.length]!;
}

/** Removes ids that disappeared between two documents (ids never seen stay: an optimistic add may be pending). */
export function pruneRemoved(selection: readonly string[], prev: EngineDoc, next: EngineDoc): readonly string[] {
  const kept = selection.filter((id) => next.nodes.has(id) || !prev.nodes.has(id));
  return kept.length === selection.length ? selection : kept;
}

export interface DragSet {
  /** nodes that get a `move` op (a dragged group carries its descendants) */
  roots: string[];
  /** every node drawn at an offset while dragging (roots plus their descendants) */
  all: string[];
}

/** The drag set of a selection: selected unlocked nodes plus the descendants of selected groups. */
export function dragSetFor(doc: EngineDoc, selection: readonly string[]): DragSet {
  const chosen = new Set<string>();
  for (const id of selection) {
    const node = doc.nodes.get(id);
    if (node && !node.locked && !node.hidden) chosen.add(id);
  }
  const roots = [...chosen].filter((id) => !ancestorsOf(doc, id).some((ancestor) => chosen.has(ancestor)));
  const all = new Set<string>(roots);
  for (const id of roots) {
    const node = doc.nodes.get(id);
    if (node?.kind !== 'group') continue;
    for (const child of descendantsOf(doc, id)) all.add(child);
  }
  return { roots, all: [...all] };
}
