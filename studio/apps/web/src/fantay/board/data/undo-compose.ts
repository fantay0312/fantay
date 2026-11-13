// SPDX-License-Identifier: AGPL-3.0-only
// Undo-entry coalescing (plan R1): consecutive undoable applies with the same `coalesceKey` share one undo entry.
// The entry must still bring back the state before the FIRST apply, also for entities only a later apply touched,
// so the two server inverses (`[restore, set-meta?]`, contracts `applyBoardOps`) are composed into one.
import type { BoardOp } from '@open-design/contracts';

type RestoreOp = Extract<BoardOp, { op: 'restore' }>;
type SetMetaOp = Extract<BoardOp, { op: 'set-meta' }>;

function isRestore(op: BoardOp): op is RestoreOp {
  return op.op === 'restore';
}

function isSetMeta(op: BoardOp): op is SetMetaOp {
  return op.op === 'set-meta';
}

/** Node order before `restore` ran on a board whose order was `orderAfter` (the restore op's own simulation). */
function orderBefore(restore: RestoreOp, orderAfter: readonly string[]): string[] {
  if (restore.order) return [...restore.order];
  const created = new Set(restore.removeNodeIds);
  const present = new Set(orderAfter);
  return [
    ...orderAfter.filter((id) => !created.has(id)),
    ...restore.nodes.map((node) => node.id).filter((id) => !present.has(id)),
  ];
}

function composeRestore(older: RestoreOp, newer: RestoreOp, orderBetween: readonly string[]): RestoreOp {
  const olderNodes = new Set(older.nodes.map((node) => node.id));
  const olderRemovedNodes = new Set(older.removeNodeIds);
  const olderEdges = new Set(older.edges.map((edge) => edge.id));
  const olderRemovedEdges = new Set(older.removeEdgeIds);
  const known = (id: string, snapshots: Set<string>, removed: Set<string>) => snapshots.has(id) || removed.has(id);
  // State before the newer apply = state after the older one (`orderBetween` is that board's order).
  const middleOrder = newer.order ? [...newer.order] : orderBetween;
  return {
    op: 'restore',
    nodes: [...older.nodes, ...newer.nodes.filter((node) => !known(node.id, olderNodes, olderRemovedNodes))],
    edges: [...older.edges, ...newer.edges.filter((edge) => !known(edge.id, olderEdges, olderRemovedEdges))],
    removeNodeIds: [...older.removeNodeIds, ...newer.removeNodeIds.filter((id) => !known(id, olderNodes, olderRemovedNodes))],
    removeEdgeIds: [...older.removeEdgeIds, ...newer.removeEdgeIds.filter((id) => !known(id, olderEdges, olderRemovedEdges))],
    // Always explicit: the appended tail of re-added nodes would otherwise come back in the wrong order.
    order: orderBefore(older, middleOrder),
    expectRev: { ...(older.expectRev ?? {}), ...(newer.expectRev ?? {}) },
  };
}

function composeMeta(older: SetMetaOp | undefined, newer: SetMetaOp | undefined): SetMetaOp | null {
  if (!older) return newer ?? null;
  if (!newer) return older;
  const title = older.title !== undefined ? older.title : newer.title;
  const settings = older.settings || newer.settings ? { ...(newer.settings ?? {}), ...(older.settings ?? {}) } : undefined;
  const pages = older.pages ?? newer.pages;
  return {
    op: 'set-meta',
    ...(title !== undefined ? { title } : {}),
    ...(settings ? { settings } : {}),
    ...(pages ? { pages } : {}),
  };
}

/**
 * One inverse equivalent to running `newer` and then `older` (newer applies first in time-reversed order):
 * snapshots of the older inverse win, the newer inverse adds what only the later apply touched, ids the later
 * apply created are removed unless the older inverse restores them, and the node order of the board before the
 * older apply is restored explicitly. `orderBetween` = the acked board's node order right before the newer apply's
 * change set was applied. `expectRev` is refreshed when the entry is sent.
 */
export function composeBoardInverses(older: readonly BoardOp[], newer: readonly BoardOp[], orderBetween: readonly string[]): BoardOp[] {
  const olderRestore = older.find(isRestore);
  const newerRestore = newer.find(isRestore);
  const restore = olderRestore && newerRestore
    ? composeRestore(olderRestore, newerRestore, orderBetween)
    : olderRestore ?? newerRestore ?? null;
  const meta = composeMeta(older.find(isSetMeta), newer.find(isSetMeta));
  return [...(restore ? [restore] : []), ...(meta ? [meta] : [])];
}
