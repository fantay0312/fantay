// SPDX-License-Identifier: AGPL-3.0-only
// Pure op helpers of the board web store (spec 04 §7.2): id filling, the entities an op is rev-checked against,
// `expectRev` filling, the stale-identity guard for re-pointed refs, and the B13 optimistic `createdAt` stamps.
// Op semantics themselves stay in `@open-design/contracts` (`applyBoardOps`); nothing here re-implements them.
import {
  compareBoardEdges,
  type BoardChangeSet,
  type BoardContent,
  type BoardDocument,
  type BoardEdge,
  type BoardFileRef,
  type BoardNode,
  type BoardNodeDraft,
  type BoardNodePatch,
  type BoardOp,
  type BoardOpResult,
} from '@open-design/contracts';

export function boardContentOf(doc: BoardDocument): BoardContent {
  return {
    ...(doc.title !== undefined ? { title: doc.title } : {}),
    settings: doc.settings,
    ...(doc.pages !== undefined ? { pages: doc.pages } : {}),
    nodes: doc.nodes,
    edges: doc.edges,
  };
}

/** `doc` with `content` swapped in; returns `doc` itself when nothing differs (keeps identity for selectors). */
export function boardWithContent(doc: BoardDocument, content: BoardContent): BoardDocument {
  if (
    content.nodes === doc.nodes && content.edges === doc.edges && content.settings === doc.settings
    && content.title === doc.title && content.pages === doc.pages
  ) {
    return doc;
  }
  const { title: _title, pages: _pages, ...rest } = doc;
  return {
    ...rest,
    ...(content.title !== undefined ? { title: content.title } : {}),
    settings: content.settings,
    ...(content.pages !== undefined ? { pages: content.pages } : {}),
    nodes: content.nodes,
    edges: content.edges,
  };
}

/** On a board with several pages, new nodes and `layout {all}` go to the page the client shows. */
export function withActivePage(op: BoardOp, page: string | null): BoardOp {
  if (!page) return op;
  if (op.op === 'add' && op.node.page === undefined) return { ...op, node: { ...op.node, page } };
  if (op.op === 'layout' && 'all' in op.target && op.target.page === undefined) return { ...op, target: { ...op.target, page } };
  return op;
}

/** Fills missing ids of add/group/connect drafts so the optimistic view and the daemon use the same ids. */
export function fillBoardOpIds(op: BoardOp, newId: (prefix: 'n' | 'e') => string): BoardOp {
  switch (op.op) {
    case 'add':
      return typeof op.node.id === 'string' ? op : { ...op, node: { ...op.node, id: newId('n') } as BoardNodeDraft };
    case 'group':
      return typeof op.group.id === 'string' ? op : { ...op, group: { ...op.group, id: newId('n') } };
    case 'connect':
      return typeof op.edge.id === 'string' ? op : { ...op, edge: { ...op.edge, id: newId('e') } };
    default:
      return op;
  }
}

/** Entities whose `rev` an op is checked against through its `expectRev` field (update/move/remove/reorder/ungroup/restore). */
export function boardOpRevTargets(op: BoardOp): string[] {
  switch (op.op) {
    case 'update':
    case 'reorder':
    case 'ungroup':
      return [op.id];
    case 'move':
      return [...new Set(op.moves.map((move) => move.id))];
    case 'remove':
      return [...new Set(op.ids)];
    case 'restore':
      return [...new Set([
        ...op.nodes.map((node) => node.id),
        ...op.removeNodeIds,
        ...op.edges.map((edge) => edge.id),
        ...op.removeEdgeIds,
      ])];
    default:
      return [];
  }
}

function revRecord(ids: readonly string[], revs: ReadonlyMap<string, number | null>): Record<string, number> | undefined {
  const record: Record<string, number> = {};
  let any = false;
  for (const id of ids) {
    const rev = revs.get(id);
    if (typeof rev === 'number') {
      record[id] = rev;
      any = true;
    }
  }
  return any ? record : undefined;
}

/** The op with `expectRev` set from `revs` (entities without a known rev get none). */
export function withBoardExpectRev(op: BoardOp, revs: ReadonlyMap<string, number | null>): BoardOp {
  switch (op.op) {
    case 'update':
    case 'reorder':
    case 'ungroup': {
      const rev = revs.get(op.id);
      if (typeof rev !== 'number') {
        if (op.expectRev === undefined) return op;
        const { expectRev: _drop, ...rest } = op;
        return rest as BoardOp;
      }
      return op.expectRev === rev ? op : { ...op, expectRev: rev };
    }
    case 'move':
    case 'remove':
    case 'restore': {
      const record = revRecord(boardOpRevTargets(op), revs);
      if (!record) {
        if (op.expectRev === undefined) return op;
        const { expectRev: _drop, ...rest } = op;
        return rest as BoardOp;
      }
      return { ...op, expectRev: record };
    }
    default:
      return op;
  }
}

function dropStaleIdentity(next: BoardFileRef, previous: BoardFileRef | null | undefined): BoardFileRef {
  if (!next.workspaceArtifactId || !previous || previous.path === next.path) return next;
  if (previous.workspaceArtifactId !== next.workspaceArtifactId) return next;
  const { workspaceArtifactId: _stale, ...rest } = next;
  return rest;
}

/**
 * W1 gate rule: a ref that changes `path` must not carry the old file's `workspaceArtifactId` (the daemon keeps a
 * client-sent identity unchecked, and the next sync would move the ref back to the identity's live path). An
 * `update` that re-points `ref` / `render` / composition `source.ref` while copying the previous identity gets the
 * identity stripped, so the daemon resolves a fresh one for the new path.
 */
export function sanitizeBoardRefIdentities(op: BoardOp, current: BoardNode | undefined): BoardOp {
  if (op.op !== 'update' || !current) return op;
  const patch = op.patch;
  let next: BoardNodePatch | null = null;
  if (patch.ref && typeof patch.ref === 'object') {
    const previous = 'ref' in current ? (current.ref as BoardFileRef | null) : null;
    const fixed = dropStaleIdentity(patch.ref, previous);
    if (fixed !== patch.ref) next = { ...(next ?? patch), ref: fixed };
  }
  if (current.kind === 'motion') {
    if (patch.render && typeof patch.render === 'object') {
      const fixed = dropStaleIdentity(patch.render, current.render);
      if (fixed !== patch.render) next = { ...(next ?? patch), render: fixed };
    }
    if (patch.source && patch.source.type === 'composition') {
      const previous = current.source.type === 'composition' ? current.source.ref : null;
      const fixed = dropStaleIdentity(patch.source.ref, previous);
      if (fixed !== patch.source.ref) next = { ...(next ?? patch), source: { type: 'composition', ref: fixed } };
    }
  }
  return next ? { ...op, patch: next } : op;
}

/** Ids an add/connect/group created, in op order (mirror of the daemon's B13 rule; restores keep their stamps). */
export function boardCreatedIdsInOpOrder(
  ops: readonly BoardOp[],
  results: readonly BoardOpResult[],
  before: BoardContent,
  after: BoardContent,
): string[] {
  const existed = new Set<string>([...before.nodes.map((node) => node.id), ...before.edges.map((edge) => edge.id)]);
  const present = new Set<string>([...after.nodes.map((node) => node.id), ...after.edges.map((edge) => edge.id)]);
  const created: string[] = [];
  const seen = new Set<string>();
  for (const result of results) {
    if (result.status !== 'applied') continue;
    const op = ops[result.index];
    if (!op || (op.op !== 'add' && op.op !== 'connect' && op.op !== 'group')) continue;
    for (const id of result.ids) {
      if (existed.has(id) || !present.has(id) || seen.has(id)) continue;
      seen.add(id);
      created.push(id);
    }
  }
  return created;
}

/** Applies stored `createdAt` stamps (nodes also lift `updatedAt`); edges are re-sorted by (createdAt, id). */
export function restampBoardCreatedAt(content: BoardContent, stamps: ReadonlyMap<string, number>): BoardContent {
  if (stamps.size === 0) return content;
  let nodesChanged = false;
  const nodes = content.nodes.map((node) => {
    const createdAt = stamps.get(node.id);
    if (createdAt === undefined || node.createdAt === createdAt) return node;
    nodesChanged = true;
    return { ...node, createdAt, updatedAt: Math.max(node.updatedAt, createdAt) } as BoardNode;
  });
  let edgesChanged = false;
  const edges = content.edges.map((edge): BoardEdge => {
    const createdAt = stamps.get(edge.id);
    if (createdAt === undefined || edge.createdAt === createdAt) return edge;
    edgesChanged = true;
    return { ...edge, createdAt };
  });
  if (!nodesChanged && !edgesChanged) return content;
  return {
    ...content,
    nodes: nodesChanged ? nodes : content.nodes,
    edges: edgesChanged ? [...edges].sort(compareBoardEdges) : content.edges,
  };
}

export function maxBoardCreatedAt(content: Pick<BoardContent, 'nodes' | 'edges'>): number {
  let max = 0;
  for (const node of content.nodes) if (node.createdAt > max) max = node.createdAt;
  for (const edge of content.edges) if (edge.createdAt > max) max = edge.createdAt;
  return max;
}

/** Nodes and edges a committed change set touched. */
export function boardChangeTouchedIds(changes: BoardChangeSet): string[] {
  return [...new Set([
    ...changes.upsertNodes.map((node) => node.id),
    ...changes.removeNodeIds,
    ...changes.upsertEdges.map((edge) => edge.id),
    ...changes.removeEdgeIds,
  ])];
}

export function boardChangeRemovedIds(changes: BoardChangeSet): string[] {
  return [...new Set([...changes.removeNodeIds, ...changes.removeEdgeIds])];
}

/** `ops[3].patch` → 3 (validation issue paths of `applyBoardOps`). */
export function opIndexOfIssuePath(path: string): number | null {
  const match = /^ops\[(\d+)\]/.exec(path);
  return match ? Number(match[1]) : null;
}
