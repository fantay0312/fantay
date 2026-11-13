// SPDX-License-Identifier: Apache-2.0
// Board op engine (spec 04 §4.4): conflict rule, op semantics, auto-layout groups, inverse and change set.
// Used by the daemon (authoritative, `checkConflicts: true`) and the web store (optimistic, `checkConflicts: false`).
// Op set design informed by infinite-canvas canvas-agent-ops.ts (MIT); no code copied.
import type { ApiValidationIssue } from '../errors.js';
import {
  BOARD_LAYOUT,
  BOARD_LIMITS,
  type BoardActor,
  type BoardChangeSet,
  type BoardContent,
  type BoardDevice,
  type BoardEdge,
  type BoardGroupNode,
  type BoardLimitErrorDetails,
  type BoardNode,
  type BoardNodeKind,
  type BoardOp,
  type BoardOpConflict,
  type BoardOpResult,
  type BoardOpSkipReason,
  type BoardPage,
  type BoardSettings,
} from '../api/board.js';
import { compareBoardEdges } from './defaults.js';
import { edgeEndpointError, groupWrapRect, type BoardRect } from './geometry.js';
import { isBoardId } from './ids.js';
import { boardNodesOnPage, boardPagesOf, resolveBoardPageId } from './pages.js';
import {
  defaultBoardNodeSize,
  layoutColumn,
  layoutGrid,
  layoutRow,
  layoutTidyTopLevel,
  placeBoardItems,
  refitGroupRect,
  sortBoardLayoutItems,
  type BoardLayoutPosition,
} from './layout.js';
import {
  applyNodeDefaults,
  buildActor,
  buildEdgeRecord,
  buildNodeRecord,
  buildPatchValue,
  childPath,
  isPlainObject,
  jsonEqual,
  nullableModeOf,
  orderNodeKeys,
  pushIssue,
  validateNodeRecord,
  validatePatchForKind,
  type Issues,
} from './schema.js';
import { ancestorIds, boardGroupDepth, descendantIdSet, groupChainHeight, childrenByParent } from './tree.js';
import { checkBoardContentLimits, collectBoardIntegrityIssues, validateBoardOpShape } from './validate.js';

export {
  defaultBoardSettings,
  emptyBoardContent,
  emptyBoardDocument,
  emptyBoardSyncLedger,
} from './defaults.js';

export interface BoardApplyContext {
  /** Revision the caller based its ops on (request `baseRevision`). */
  baseRevision: number;
  /** Revision stamped on every changed entity (current revision + 1). */
  nextRevision: number;
  actor: BoardActor;
  now: number;
  /** Random id source for drafts without an id (contracts never generate random ids). */
  newId(prefix: 'n' | 'e'): string;
  /** true: daemon conflict rule (409 semantics). false: optimistic/sync apply (missing targets are skipped). */
  checkConflicts: boolean;
}

export type BoardApplyOutcome =
  | {
      ok: true;
      content: BoardContent;
      results: BoardOpResult[];
      /** Net changes; empty (`isEmptyBoardChangeSet`) with `fromRevision === toRevision` when nothing changed. */
      changes: BoardChangeSet;
      /**
       * `[]` when nothing changed, else one `restore` op (first), followed by a `set-meta` op only when the batch
       * changed the board title, settings or pages (a restore op cannot carry them).
       */
      inverse: BoardOp[];
      /** Paths of file-backed nodes that left the board (for the sync ledger's `dismissed`). */
      removedPaths: string[];
      /** Nodes created, changed or removed by the batch. */
      touchedNodeIds: string[];
    }
  | { ok: false; reason: 'conflict'; conflicts: BoardOpConflict[] }
  | { ok: false; reason: 'invalid'; issues: ApiValidationIssue[] }
  | { ok: false; reason: 'limit'; details: BoardLimitErrorDetails };

const CLEAR = Symbol('clear');
type NodeChanges = Record<string, unknown>;
type OpOutcome = { status: 'applied'; ids: string[] } | { status: 'skipped'; reason: BoardOpSkipReason; ids: string[] };

const NODE_STAMP_KEYS: ReadonlySet<string> = new Set(['rev', 'updatedAt', 'updatedBy']);
const EDGE_STAMP_KEYS: ReadonlySet<string> = new Set(['rev', 'updatedBy']);

function equalModuloStamps(a: object, b: object, stampKeys: ReadonlySet<string>): boolean {
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const leftKeys = Object.keys(left).filter((key) => !stampKeys.has(key) && left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => !stampKeys.has(key) && right[key] !== undefined);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every((key) => jsonEqual(left[key], right[key]));
}

function arraysEqual(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function isAutoLayout(layout: unknown): boolean {
  return layout === 'row' || layout === 'grid';
}

/** File paths a node references on the board (used for `removedPaths`). */
function nodeFilePaths(node: BoardNode): string[] {
  switch (node.kind) {
    case 'frame':
    case 'image':
    case 'video':
    case 'audio':
      return node.ref ? [node.ref.path] : [];
    case 'design':
      return [node.ref.path];
    case 'motion':
      return node.source.type === 'composition' ? [node.source.ref.path] : [];
    default:
      return [];
  }
}

class BoardWorkingCopy {
  order: string[];
  readonly nodes: Map<string, BoardNode>;
  readonly edges: Map<string, BoardEdge>;
  title: string | undefined;
  settings: BoardSettings;
  pages: BoardPage[] | undefined;
  mutations = 0;
  /** Ids (nodes and edges) that did not exist when the batch started; exempt from conflict checks. */
  readonly createdInBatch = new Set<string>();
  /** Nodes whose z-order was changed explicitly (stamped even when their fields are unchanged). */
  readonly reordered = new Set<string>();

  constructor(content: BoardContent) {
    this.order = content.nodes.map((node) => node.id);
    this.nodes = new Map(content.nodes.map((node) => [node.id, node]));
    this.edges = new Map(content.edges.map((edge) => [edge.id, edge]));
    this.title = content.title;
    this.settings = content.settings;
    this.pages = content.pages;
  }

  node(id: string): BoardNode | undefined {
    return this.nodes.get(id);
  }

  hasId(id: string): boolean {
    return this.nodes.has(id) || this.edges.has(id);
  }

  nodeList(): BoardNode[] {
    return this.order.map((id) => this.nodes.get(id)!);
  }

  childIds(parentId: string): string[] {
    return this.order.filter((id) => this.nodes.get(id)!.parentId === parentId);
  }

  childrenMap(): Map<string, string[]> {
    return childrenByParent(this.nodeList());
  }

  patchNode(id: string, changes: NodeChanges): boolean {
    const current = this.nodes.get(id);
    if (!current) return false;
    const next: Record<string, unknown> = { ...current };
    for (const [key, value] of Object.entries(changes)) {
      if (value === CLEAR) delete next[key];
      else next[key] = value;
    }
    if (jsonEqual(current, next)) return false;
    this.nodes.set(id, next as unknown as BoardNode);
    this.mutations += 1;
    return true;
  }

  setNode(node: BoardNode): void {
    const current = this.nodes.get(node.id);
    if (current && jsonEqual(current, node)) return;
    if (!current) {
      this.order.push(node.id);
      this.createdInBatch.add(node.id);
    }
    this.nodes.set(node.id, node);
    this.mutations += 1;
  }

  insertNodeAt(node: BoardNode, index: number): void {
    this.nodes.set(node.id, node);
    this.order.splice(Math.max(0, Math.min(index, this.order.length)), 0, node.id);
    this.createdInBatch.add(node.id);
    this.mutations += 1;
  }

  removeNode(id: string): void {
    if (!this.nodes.delete(id)) return;
    this.order = this.order.filter((entry) => entry !== id);
    for (const edge of [...this.edges.values()]) {
      if (edge.from === id || edge.to === id) this.edges.delete(edge.id);
    }
    this.mutations += 1;
  }

  setEdge(edge: BoardEdge): void {
    const current = this.edges.get(edge.id);
    if (current && jsonEqual(current, edge)) return;
    if (!current) this.createdInBatch.add(edge.id);
    this.edges.set(edge.id, edge);
    this.mutations += 1;
  }

  removeEdge(id: string): void {
    if (this.edges.delete(id)) this.mutations += 1;
  }

  moveInOrder(id: string, index: number): boolean {
    const from = this.order.indexOf(id);
    if (from < 0) return false;
    const to = Math.max(0, Math.min(index, this.order.length - 1));
    if (from === to) return false;
    const next = this.order.slice();
    next.splice(from, 1);
    next.splice(to, 0, id);
    this.order = next;
    this.mutations += 1;
    return true;
  }

  applyOrder(ids: readonly string[]): void {
    const rank = new Map<string, number>();
    ids.forEach((id, index) => { if (!rank.has(id)) rank.set(id, index); });
    const listed = this.order.filter((id) => rank.has(id)).sort((a, b) => rank.get(a)! - rank.get(b)!);
    const unlisted = this.order.filter((id) => !rank.has(id));
    const next = [...listed, ...unlisted];
    if (!arraysEqual(next, this.order)) {
      this.order = next;
      this.mutations += 1;
    }
  }

  /** Moves a node to (x, y) and its descendants by the same delta. */
  translateTo(id: string, x: number, y: number, children: ReadonlyMap<string, readonly string[]>, skip?: ReadonlySet<string>): boolean {
    const node = this.nodes.get(id);
    if (!node) return false;
    const dx = x - node.x;
    const dy = y - node.y;
    if (dx === 0 && dy === 0) return false;
    let changed = this.patchNode(id, { x, y });
    if (node.kind === 'group') {
      for (const descendantId of descendantIdSet(id, children)) {
        if (skip?.has(descendantId)) continue;
        const descendant = this.nodes.get(descendantId);
        if (!descendant) continue;
        changed = this.patchNode(descendantId, { x: descendant.x + dx, y: descendant.y + dy }) || changed;
      }
    }
    return changed;
  }
}

class BoardOpEngine {
  readonly work: BoardWorkingCopy;
  readonly conflicts: BoardOpConflict[] = [];
  readonly issues: Issues = [];
  private readonly dirty = new Map<string, string[]>();
  private readonly finalLayout = new Map<string, unknown>();
  private readonly actor: BoardActor;

  constructor(content: BoardContent, private readonly ops: readonly BoardOp[], private readonly ctx: BoardApplyContext) {
    this.work = new BoardWorkingCopy(content);
    this.actor = buildActor(ctx.actor);
    for (const op of ops) {
      if (op.op === 'update' && isPlainObject(op.patch) && op.patch.layout !== undefined) this.finalLayout.set(op.id, op.patch.layout);
    }
  }

  stamp(): BoardActor {
    return buildActor(this.actor);
  }

  // ---- conflicts --------------------------------------------------------------------

  private conflict(opIndex: number, id: string, reason: BoardOpConflict['reason'], currentRev?: number): void {
    this.conflicts.push({ opIndex, id, reason, ...(currentRev !== undefined ? { currentRev } : {}) });
  }

  /** Conflict rule of spec 04 §4.4.2 for one existing entity. Returns false when it conflicts. */
  private checkRev(opIndex: number, id: string, rev: number, expectRev: number | undefined): boolean {
    if (!this.ctx.checkConflicts || this.work.createdInBatch.has(id)) return true;
    if (expectRev !== undefined ? rev !== expectRev : rev > this.ctx.baseRevision) {
      this.conflict(opIndex, id, 'stale-entity', rev);
      return false;
    }
    return true;
  }

  /** A required target is missing: conflict `missing-entity` (authoritative) or a skip (optimistic/sync). */
  private missingTarget(opIndex: number, id: string): OpOutcome | null {
    if (this.ctx.checkConflicts) {
      this.conflict(opIndex, id, 'missing-entity');
      return null;
    }
    return { status: 'skipped', reason: 'missing', ids: [] };
  }

  /** An id that must be new already exists: skip with `ifAbsent` (or optimistically), else conflict `exists`. */
  private existingTarget(opIndex: number, id: string, ifAbsent: boolean | undefined): OpOutcome | null {
    if (ifAbsent || !this.ctx.checkConflicts) return { status: 'skipped', reason: 'exists', ids: [id] };
    this.conflict(opIndex, id, 'exists');
    return null;
  }

  private freshId(prefix: 'n' | 'e', path: string): string | null {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const id = this.ctx.newId(prefix);
      if (isBoardId(id) && !this.work.hasId(id)) return id;
    }
    pushIssue(this.issues, path, 'invalid-value', 'newId() did not produce a fresh board id.');
    return null;
  }

  // ---- auto layout ------------------------------------------------------------------

  /** Nodes on `page` (unknown or absent: the first page); placement and `layout {all}` never look past it. */
  private pageNodes(page: string | undefined): BoardNode[] {
    const pages = boardPagesOf({ ...(this.work.pages ? { pages: this.work.pages } : {}) });
    return boardNodesOnPage(this.work.nodeList(), pages, resolveBoardPageId(pages, page));
  }

  private isAuto(node: BoardNode | undefined): node is BoardGroupNode {
    if (!node || node.kind !== 'group' || !isAutoLayout(node.layout)) return false;
    return (this.finalLayout.get(node.id) ?? node.layout) !== 'free';
  }

  private markDirty(groupId: string | undefined, append: readonly string[] = []): void {
    if (groupId === undefined || !this.isAuto(this.work.node(groupId))) return;
    const list = this.dirty.get(groupId) ?? [];
    for (const id of append) if (!list.includes(id)) list.push(id);
    this.dirty.set(groupId, list);
  }

  /** Re-lays out dirty row/grid groups, deepest first; a refit that changes a group's size dirties its parent. */
  flushLayouts(): void {
    while (this.dirty.size > 0) {
      let pickId: string | null = null;
      let pickDepth = -1;
      for (const id of this.dirty.keys()) {
        const depth = ancestorIds(id, this.work.nodes).length;
        if (depth > pickDepth) {
          pickId = id;
          pickDepth = depth;
        }
      }
      const groupId = pickId!;
      const append = this.dirty.get(groupId) ?? [];
      this.dirty.delete(groupId);
      const group = this.work.node(groupId);
      if (!this.isAuto(group)) continue;
      const before = { w: group.w, h: group.h };
      this.relayoutGroup(group, append);
      const after = this.work.node(groupId)!;
      if (after.w !== before.w || after.h !== before.h) this.markDirty(after.parentId);
    }
  }

  private relayoutGroup(group: BoardGroupNode, append: readonly string[]): void {
    const childIds = this.work.childIds(group.id);
    const children = childIds.map((id) => this.work.node(id)!);
    const variants = group.role === 'variants';
    const gap = variants ? BOARD_LAYOUT.variantGap : BOARD_LAYOUT.itemGap;
    let items: BoardNode[];
    if (variants) {
      items = sortBoardLayoutItems(children, 'variant');
    } else {
      const appendSet = new Set(append.filter((id) => childIds.includes(id)));
      items = [
        ...sortBoardLayoutItems(children.filter((child) => !appendSet.has(child.id)), 'position'),
        ...[...appendSet].map((id) => this.work.node(id)!),
      ];
    }
    const origin = { x: group.x + BOARD_LAYOUT.groupPad, y: group.y + BOARD_LAYOUT.groupHeader };
    const positions = group.layout === 'grid'
      ? layoutGrid(items, origin, gap, undefined, 'input')
      : layoutRow(items, origin, gap, BOARD_LAYOUT.rowWrapWidth, 'input');
    this.applyPositions(positions);
    const laidOut = this.work.childIds(group.id).map((id) => this.work.node(id)!);
    const rect = refitGroupRect(this.work.node(group.id)!, laidOut);
    this.work.patchNode(group.id, { w: rect.w, h: rect.h });
  }

  private applyPositions(positions: readonly BoardLayoutPosition[]): string[] {
    const children = this.work.childrenMap();
    const moved: string[] = [];
    for (const position of positions) {
      if (this.work.translateTo(position.id, position.x, position.y, children)) moved.push(position.id);
    }
    return moved;
  }

  // ---- ops --------------------------------------------------------------------------

  run(): void {
    const results: BoardOpResult[] = [];
    this.ops.forEach((op, index) => {
      const mutationsBefore = this.work.mutations;
      const conflictsBefore = this.conflicts.length;
      const issuesBefore = this.issues.length;
      const outcome = this.applyOne(op, index);
      if (outcome && this.conflicts.length === conflictsBefore && this.issues.length === issuesBefore) this.flushLayouts();
      if (!outcome || this.conflicts.length > conflictsBefore || this.issues.length > issuesBefore) {
        results.push({ index, status: 'skipped', ids: [] });
        return;
      }
      if (outcome.status === 'skipped') {
        results.push({ index, status: 'skipped', reason: outcome.reason, ids: outcome.ids });
      } else if (this.work.mutations === mutationsBefore) {
        results.push({ index, status: 'skipped', reason: 'noop', ids: outcome.ids });
      } else {
        results.push({ index, status: 'applied', ids: outcome.ids });
      }
    });
    this.results = results;
  }

  results: BoardOpResult[] = [];

  private applyOne(op: BoardOp, index: number): OpOutcome | null {
    const path = childPath('ops', index);
    switch (op.op) {
      case 'add': return this.add(op, index, path);
      case 'update': return this.update(op, index, path);
      case 'move': return this.move(op, index);
      case 'remove': return this.remove(op, index);
      case 'connect': return this.connect(op, index, path);
      case 'disconnect': return this.disconnect(op, index);
      case 'reorder': return this.reorder(op, index);
      case 'group': return this.group(op, index, path);
      case 'ungroup': return this.ungroup(op, index, path);
      case 'layout': return this.layout(op, index, path);
      case 'set-meta': return this.setMeta(op);
      case 'restore': return this.restore(op, index);
      default: return null;
    }
  }

  private add(op: Extract<BoardOp, { op: 'add' }>, index: number, path: string): OpOutcome | null {
    const draft = op.node as unknown as Record<string, unknown> & { kind: BoardNodeKind };
    const kind = draft.kind;
    let id: string;
    if (typeof draft.id === 'string') {
      id = draft.id;
      if (this.work.hasId(id)) return this.existingTarget(index, id, op.ifAbsent);
    } else {
      const fresh = this.freshId('n', childPath(path, 'node.id'));
      if (!fresh) return null;
      id = fresh;
    }
    const parentId = typeof draft.parentId === 'string' ? draft.parentId : undefined;
    const parent = parentId !== undefined ? this.work.node(parentId) : undefined;
    if (parentId !== undefined) {
      if (!parent) return this.missingTarget(index, parentId);
      if (parent.kind !== 'group') {
        pushIssue(this.issues, childPath(path, 'node.parentId'), 'parent-not-group', `Parent ${parentId} is not a group.`);
        return null;
      }
      if (kind === 'group' && boardGroupDepth(parentId, this.work.nodes) + 1 > BOARD_LIMITS.maxGroupDepth) {
        pushIssue(this.issues, childPath(path, 'node.parentId'), 'group-depth', `Groups nest at most ${BOARD_LIMITS.maxGroupDepth} levels.`);
        return null;
      }
    }
    const record = buildNodeRecord(draft, 'draft', false);
    applyNodeDefaults(record);
    // A node lives with what it is attached to: its group, or the node it is placed next to.
    const anchor = parent ?? (op.placement?.mode === 'near' ? this.work.node(op.placement.nodeId) : undefined);
    const page = anchor ? anchor.page : (typeof draft.page === 'string' ? draft.page : undefined);
    delete record.page;
    const size = defaultBoardNodeSize(kind, { device: record.device as BoardDevice | undefined });
    const w = typeof draft.w === 'number' ? draft.w : size.w;
    const h = typeof draft.h === 'number' ? draft.h : size.h;
    let x: number;
    let y: number;
    if (typeof draft.x === 'number' && typeof draft.y === 'number') {
      x = draft.x;
      y = draft.y;
    } else if (parent && this.isAuto(parent)) {
      x = parent.x + BOARD_LAYOUT.groupPad;
      y = parent.y + BOARD_LAYOUT.groupHeader;
    } else {
      const [position] = placeBoardItems({ nodes: this.pageNodes(page) }, [{ w, h }], op.placement ?? { mode: 'auto' });
      x = position!.x;
      y = position!.y;
    }
    const now = this.ctx.now;
    const node = orderNodeKeys(kind, {
      ...record,
      ...(page !== undefined ? { page } : {}),
      id,
      x,
      y,
      w,
      h,
      createdAt: now,
      updatedAt: now,
      createdBy: this.stamp(),
      updatedBy: this.stamp(),
      rev: this.ctx.nextRevision,
    }) as unknown as BoardNode;
    this.work.setNode(node);
    if (parent) this.markDirty(parent.id, [id]);
    return { status: 'applied', ids: [id] };
  }

  private update(op: Extract<BoardOp, { op: 'update' }>, index: number, path: string): OpOutcome | null {
    const node = this.work.node(op.id);
    if (!node) return this.missingTarget(index, op.id);
    if (!this.checkRev(index, node.id, node.rev, op.expectRev)) return null;
    const patch = op.patch as unknown as Record<string, unknown>;
    const patchPath = childPath(path, 'patch');
    const issuesBefore = this.issues.length;
    validatePatchForKind(patch, node.kind, this.ctx.actor.kind, patchPath, this.issues);
    if (this.issues.length > issuesBefore) return null;
    const nextParent = patch.parentId;
    if (typeof nextParent === 'string' && nextParent !== node.parentId) {
      const parent = this.work.node(nextParent);
      if (!parent) return this.missingTarget(index, nextParent);
      const children = this.work.childrenMap();
      if (parent.kind !== 'group') {
        pushIssue(this.issues, childPath(patchPath, 'parentId'), 'parent-not-group', `Parent ${nextParent} is not a group.`);
        return null;
      }
      if (nextParent === node.id || descendantIdSet(node.id, children).has(nextParent)) {
        pushIssue(this.issues, childPath(patchPath, 'parentId'), 'parent-cycle', 'A node cannot be moved into itself or its descendants.');
        return null;
      }
      const parentDepth = boardGroupDepth(nextParent, this.work.nodes);
      if (parentDepth + groupChainHeight(node.id, this.work.nodes, children) > BOARD_LIMITS.maxGroupDepth) {
        pushIssue(this.issues, childPath(patchPath, 'parentId'), 'group-depth', `Groups nest at most ${BOARD_LIMITS.maxGroupDepth} levels.`);
        return null;
      }
    }
    const changes: NodeChanges = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      if (value === null) changes[key] = nullableModeOf(node.kind, key) === 'value' ? null : CLEAR;
      else changes[key] = buildPatchValue(node.kind, key, value);
    }
    const oldParent = node.parentId;
    if (!this.work.patchNode(node.id, changes)) return { status: 'applied', ids: [node.id] };
    const updated = this.work.node(node.id)!;
    if (updated.parentId !== oldParent) {
      this.markDirty(oldParent);
      this.markDirty(updated.parentId, [node.id]);
    } else if (updated.x !== node.x || updated.y !== node.y || updated.w !== node.w || updated.h !== node.h) {
      this.markDirty(updated.parentId);
    }
    if (updated.kind === 'group' && node.kind === 'group'
      && (updated.layout !== node.layout || updated.role !== node.role || updated.w !== node.w || updated.h !== node.h)) {
      this.markDirty(updated.id);
    }
    return { status: 'applied', ids: [node.id] };
  }

  private move(op: Extract<BoardOp, { op: 'move' }>, index: number): OpOutcome | null {
    const expectRev = op.expectRev ?? {};
    const targets = new Map<string, { x: number; y: number }>();
    let failed = false;
    for (const move of op.moves) {
      const node = this.work.node(move.id);
      if (!node) {
        if (this.missingTarget(index, move.id) === null) failed = true;
        continue;
      }
      if (!targets.has(move.id) && !this.checkRev(index, node.id, node.rev, expectRev[node.id])) failed = true;
      targets.set(move.id, { x: move.x, y: move.y });
    }
    if (failed) return null;
    if (targets.size === 0) return { status: 'skipped', reason: 'missing', ids: [] };
    const children = this.work.childrenMap();
    const explicit = new Set(targets.keys());
    const deltas = new Map<string, { dx: number; dy: number }>();
    for (const [id, target] of targets) {
      const node = this.work.node(id)!;
      deltas.set(id, { dx: target.x - node.x, dy: target.y - node.y });
    }
    // Descendants of moved groups follow the nearest explicitly moved ancestor.
    const implicit = new Map<string, { x: number; y: number }>();
    for (const id of explicit) {
      const node = this.work.node(id)!;
      if (node.kind !== 'group') continue;
      for (const descendantId of descendantIdSet(id, children)) {
        if (explicit.has(descendantId) || implicit.has(descendantId)) continue;
        const anchor = ancestorIds(descendantId, this.work.nodes).find((ancestor) => explicit.has(ancestor));
        if (!anchor) continue;
        const delta = deltas.get(anchor)!;
        const descendant = this.work.node(descendantId)!;
        implicit.set(descendantId, { x: descendant.x + delta.dx, y: descendant.y + delta.dy });
      }
    }
    for (const [id, target] of targets) this.work.patchNode(id, { x: target.x, y: target.y });
    for (const [id, target] of implicit) this.work.patchNode(id, { x: target.x, y: target.y });
    for (const id of explicit) this.markDirty(this.work.node(id)!.parentId);
    return { status: 'applied', ids: [...explicit] };
  }

  private remove(op: Extract<BoardOp, { op: 'remove' }>, index: number): OpOutcome | null {
    const expectRev = op.expectRev ?? {};
    const existing = [...new Set(op.ids)].filter((id) => this.work.node(id));
    if (existing.length === 0) return { status: 'skipped', reason: 'missing', ids: [] };
    let failed = false;
    for (const id of existing) {
      const node = this.work.node(id)!;
      if (!this.checkRev(index, id, node.rev, expectRev[id])) failed = true;
    }
    if (failed) return null;
    const children = this.work.childrenMap();
    const removal = new Set(existing);
    if (op.cascade) {
      for (const id of existing) {
        if (this.work.node(id)!.kind === 'group') for (const descendantId of descendantIdSet(id, children)) removal.add(descendantId);
      }
    }
    const childCountBefore = new Map<string, number>();
    for (const [parentId, ids] of children) childCountBefore.set(parentId, ids.length);
    // Children of removed groups move up to the nearest surviving ancestor (positions unchanged).
    const reparent = new Map<string, string | undefined>();
    for (const id of this.work.order) {
      if (removal.has(id)) continue;
      const parentId = this.work.node(id)!.parentId;
      if (parentId === undefined || !removal.has(parentId)) continue;
      reparent.set(id, ancestorIds(id, this.work.nodes).find((ancestor) => !removal.has(ancestor)));
    }
    const touchedParents = new Set<string>();
    for (const id of removal) {
      const parentId = this.work.node(id)?.parentId;
      if (parentId !== undefined && !removal.has(parentId)) touchedParents.add(parentId);
    }
    const removedInOrder = this.work.order.filter((id) => removal.has(id));
    for (const id of removedInOrder) this.work.removeNode(id);
    for (const [id, parentId] of reparent) {
      this.work.patchNode(id, { parentId: parentId === undefined ? CLEAR : parentId });
      if (parentId !== undefined) touchedParents.add(parentId);
    }
    // Groups other than sections that lost their last child disappear too (cascading upwards). Groups that were
    // already empty before this op are kept.
    const removedGroups: string[] = [];
    let candidates = [...touchedParents];
    while (candidates.length > 0) {
      const next: string[] = [];
      for (const groupId of candidates) {
        const group = this.work.node(groupId);
        if (!group || group.kind !== 'group' || group.role === 'section') continue;
        if ((childCountBefore.get(groupId) ?? 0) === 0) continue;
        if (this.work.childIds(groupId).length > 0) continue;
        const parentId = group.parentId;
        this.work.removeNode(groupId);
        removedGroups.push(groupId);
        touchedParents.delete(groupId);
        if (parentId !== undefined) {
          touchedParents.add(parentId);
          next.push(parentId);
        }
      }
      candidates = next;
    }
    for (const parentId of touchedParents) this.markDirty(parentId);
    return { status: 'applied', ids: [...removedInOrder, ...removedGroups] };
  }

  private connect(op: Extract<BoardOp, { op: 'connect' }>, index: number, path: string): OpOutcome | null {
    const draft = op.edge as unknown as Record<string, unknown> & { kind: BoardEdge['kind']; from: string; to: string };
    let id: string;
    if (typeof draft.id === 'string') {
      id = draft.id;
      if (this.work.hasId(id)) return this.existingTarget(index, id, op.ifAbsent);
    } else {
      const fresh = this.freshId('e', childPath(path, 'edge.id'));
      if (!fresh) return null;
      id = fresh;
    }
    const from = this.work.node(draft.from);
    if (!from) return this.missingTarget(index, draft.from);
    const to = this.work.node(draft.to);
    if (!to) return this.missingTarget(index, draft.to);
    const endpointError = edgeEndpointError(draft.kind, from, to);
    if (endpointError) {
      pushIssue(this.issues, childPath(path, 'edge'), endpointError, `Edge ${draft.kind} ${from.kind} → ${to.kind} is not allowed.`);
      return null;
    }
    for (const edge of this.work.edges.values()) {
      if (edge.from === draft.from && edge.to === draft.to && edge.kind === draft.kind) {
        return this.existingTarget(index, edge.id, op.ifAbsent);
      }
    }
    const record = buildEdgeRecord(draft, false);
    const edge = {
      id,
      kind: record.kind,
      from: record.from,
      to: record.to,
      ...(record.label !== undefined ? { label: record.label } : {}),
      createdAt: this.ctx.now,
      createdBy: this.stamp(),
      updatedBy: this.stamp(),
      rev: this.ctx.nextRevision,
    } as BoardEdge;
    this.work.setEdge(edge);
    return { status: 'applied', ids: [id] };
  }

  private disconnect(op: Extract<BoardOp, { op: 'disconnect' }>, index: number): OpOutcome | null {
    const existing = [...new Set(op.ids)].filter((id) => this.work.edges.has(id));
    if (existing.length === 0) return { status: 'skipped', reason: 'missing', ids: [] };
    let failed = false;
    for (const id of existing) {
      if (!this.checkRev(index, id, this.work.edges.get(id)!.rev, undefined)) failed = true;
    }
    if (failed) return null;
    for (const id of existing) this.work.removeEdge(id);
    return { status: 'applied', ids: existing };
  }

  private reorder(op: Extract<BoardOp, { op: 'reorder' }>, index: number): OpOutcome | null {
    const node = this.work.node(op.id);
    if (!node) return this.missingTarget(index, op.id);
    if (!this.checkRev(index, node.id, node.rev, op.expectRev)) return null;
    const last = this.work.order.length - 1;
    const target = op.to === 'front' ? last : op.to === 'back' ? 0 : Math.max(0, Math.min(Math.floor(op.to), last));
    if (this.work.moveInOrder(node.id, target)) this.work.reordered.add(node.id);
    return { status: 'applied', ids: [node.id] };
  }

  private group(op: Extract<BoardOp, { op: 'group' }>, index: number, path: string): OpOutcome | null {
    const ids = [...new Set(op.ids)];
    let failed = false;
    const members: BoardNode[] = [];
    for (const id of ids) {
      const node = this.work.node(id);
      if (!node) {
        const outcome = this.missingTarget(index, id);
        if (outcome === null) failed = true;
        else return outcome;
        continue;
      }
      if (!this.checkRev(index, id, node.rev, undefined)) failed = true;
      members.push(node);
    }
    if (failed) return null;
    const draft = op.group as unknown as Record<string, unknown>;
    let groupId: string;
    if (typeof draft.id === 'string') {
      groupId = draft.id;
      if (this.work.hasId(groupId)) return this.existingTarget(index, groupId, false);
    } else {
      const fresh = this.freshId('n', childPath(path, 'group.id'));
      if (!fresh) return null;
      groupId = fresh;
    }
    const parentId = members[0]!.parentId;
    if (members.some((member) => member.parentId !== parentId)) {
      pushIssue(this.issues, childPath(path, 'ids'), 'group-mixed-parents', 'Grouped nodes must share one parent (or all be top level).');
      return null;
    }
    const children = this.work.childrenMap();
    const memberHeight = Math.max(0, ...members.map((member) => groupChainHeight(member.id, this.work.nodes, children)));
    const parentDepth = parentId === undefined ? 0 : boardGroupDepth(parentId, this.work.nodes);
    if (parentDepth + 1 + memberHeight > BOARD_LIMITS.maxGroupDepth) {
      pushIssue(this.issues, childPath(path, 'ids'), 'group-depth', `Groups nest at most ${BOARD_LIMITS.maxGroupDepth} levels.`);
      return null;
    }
    const record = buildNodeRecord({ ...draft, kind: 'group' }, 'draft', false);
    applyNodeDefaults(record);
    const rect: BoardRect = groupWrapRect(members);
    const now = this.ctx.now;
    const groupNode = orderNodeKeys('group', {
      ...record,
      id: groupId,
      kind: 'group',
      ...rect,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(members[0]!.page !== undefined ? { page: members[0]!.page } : {}),
      createdAt: now,
      updatedAt: now,
      createdBy: this.stamp(),
      updatedBy: this.stamp(),
      rev: this.ctx.nextRevision,
    }) as unknown as BoardNode;
    const firstIndex = Math.min(...members.map((member) => this.work.order.indexOf(member.id)));
    this.work.insertNodeAt(groupNode, firstIndex);
    for (const member of members) this.work.patchNode(member.id, { parentId: groupId });
    this.markDirty(parentId);
    this.markDirty(groupId);
    return { status: 'applied', ids: [groupId] };
  }

  private ungroup(op: Extract<BoardOp, { op: 'ungroup' }>, index: number, path: string): OpOutcome | null {
    const group = this.work.node(op.id);
    if (!group) return this.missingTarget(index, op.id);
    if (group.kind !== 'group') {
      pushIssue(this.issues, childPath(path, 'id'), 'not-a-group', `${op.id} is not a group.`);
      return null;
    }
    if (!this.checkRev(index, group.id, group.rev, op.expectRev)) return null;
    for (const childId of this.work.childIds(group.id)) {
      this.work.patchNode(childId, { parentId: group.parentId === undefined ? CLEAR : group.parentId });
    }
    this.work.removeNode(group.id);
    this.markDirty(group.parentId);
    return { status: 'applied', ids: [group.id] };
  }

  private layout(op: Extract<BoardOp, { op: 'layout' }>, index: number, path: string): OpOutcome | null {
    const target = op.target as { groupId?: string; ids?: string[]; all?: true; page?: string };
    let items: BoardNode[];
    let origin: { x: number; y: number };
    let gap: number = op.gap ?? BOARD_LAYOUT.itemGap;
    let order: 'variant' | 'position' = 'position';
    let group: BoardGroupNode | null = null;
    if (target.groupId !== undefined) {
      const node = this.work.node(target.groupId);
      if (!node) return this.missingTarget(index, target.groupId);
      if (node.kind !== 'group') {
        pushIssue(this.issues, childPath(path, 'target.groupId'), 'not-a-group', `${target.groupId} is not a group.`);
        return null;
      }
      group = node;
      items = this.work.childIds(node.id).map((id) => this.work.node(id)!);
      origin = { x: node.x + BOARD_LAYOUT.groupPad, y: node.y + BOARD_LAYOUT.groupHeader };
      if (node.role === 'variants') {
        order = 'variant';
        gap = op.gap ?? BOARD_LAYOUT.variantGap;
      }
    } else {
      if (target.ids !== undefined) {
        items = [];
        for (const id of [...new Set(target.ids)]) {
          const node = this.work.node(id);
          if (!node) {
            const outcome = this.missingTarget(index, id);
            if (outcome === null) return null;
            continue;
          }
          items.push(node);
        }
      } else {
        items = this.pageNodes(target.page).filter((node) => node.parentId === undefined || !this.work.node(node.parentId));
      }
      const bounds = items.length > 0 ? {
        x: Math.min(...items.map((node) => node.x)),
        y: Math.min(...items.map((node) => node.y)),
      } : { x: 0, y: 0 };
      origin = bounds;
    }
    if (items.length === 0) return { status: 'applied', ids: [] };
    let positions: BoardLayoutPosition[];
    switch (op.mode) {
      case 'column':
        positions = layoutColumn(items, origin, gap, order);
        break;
      case 'grid':
        positions = layoutGrid(items, origin, gap, op.columns, order);
        break;
      case 'tidy':
        positions = target.all === true && target.groupId === undefined && target.ids === undefined
          ? layoutTidyTopLevel({ nodes: this.pageNodes(target.page) })
          : layoutRow(items, origin, gap, BOARD_LAYOUT.rowWrapWidth, order);
        break;
      case 'row':
      default:
        positions = layoutRow(items, origin, gap, BOARD_LAYOUT.rowWrapWidth, order);
        break;
    }
    const moved = this.applyPositions(positions);
    if (group) {
      const current = this.work.node(group.id)!;
      const laidOut = this.work.childIds(group.id).map((id) => this.work.node(id)!);
      const rect = refitGroupRect(current, laidOut);
      this.work.patchNode(group.id, { w: rect.w, h: rect.h });
      this.markDirty(current.parentId);
    } else {
      for (const id of moved) this.markDirty(this.work.node(id)?.parentId);
    }
    return { status: 'applied', ids: moved };
  }

  private setMeta(op: Extract<BoardOp, { op: 'set-meta' }>): OpOutcome {
    if (op.title !== undefined) {
      const title = op.title === null ? undefined : op.title;
      if (title !== this.work.title) {
        this.work.title = title;
        this.work.mutations += 1;
      }
    }
    if (op.settings !== undefined) {
      const next: BoardSettings = { ...this.work.settings };
      if (op.settings.background !== undefined) next.background = op.settings.background;
      if (op.settings.autoPlace !== undefined) next.autoPlace = op.settings.autoPlace;
      if (!jsonEqual(next, this.work.settings)) {
        this.work.settings = next;
        this.work.mutations += 1;
      }
    }
    if (op.pages !== undefined) {
      const pages = op.pages.length > 0 ? op.pages : undefined;
      if (!jsonEqual(pages, this.work.pages)) {
        this.work.pages = pages;
        this.work.mutations += 1;
      }
    }
    return { status: 'applied', ids: [] };
  }

  private restore(op: Extract<BoardOp, { op: 'restore' }>, index: number): OpOutcome | null {
    const expectRev = op.expectRev ?? {};
    let failed = false;
    const check = (id: string, rev: number | undefined): void => {
      if (rev !== undefined && !this.checkRev(index, id, rev, expectRev[id])) failed = true;
    };
    for (const node of op.nodes) check(node.id, this.work.node(node.id)?.rev);
    for (const id of op.removeNodeIds) check(id, this.work.node(id)?.rev);
    for (const edge of op.edges) check(edge.id, this.work.edges.get(edge.id)?.rev);
    for (const id of op.removeEdgeIds) check(id, this.work.edges.get(id)?.rev);
    if (failed) return null;
    // Snapshots were validated as full nodes by validateBoardOpShape.
    const built = op.nodes.map((snapshot) => orderNodeKeys(
      snapshot.kind,
      buildNodeRecord(snapshot as unknown as Record<string, unknown> & { kind: BoardNodeKind }, 'full', true),
    ) as unknown as BoardNode);
    for (const id of op.removeEdgeIds) this.work.removeEdge(id);
    for (const id of op.removeNodeIds) this.work.removeNode(id);
    for (const node of built) this.work.setNode(node);
    for (const snapshot of op.edges) {
      this.work.setEdge(buildEdgeRecord(snapshot as unknown as Record<string, unknown>, true) as unknown as BoardEdge);
    }
    if (op.order !== undefined) this.work.applyOrder(op.order);
    return { status: 'applied', ids: [...built.map((node) => node.id), ...op.removeNodeIds] };
  }
}

function emptyChangeSet(revision: number): BoardChangeSet {
  return { fromRevision: revision, toRevision: revision, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] };
}

/**
 * Applies a batch atomically (spec 04 §4.4). Conflicts, invalid ops and breached limits reject the whole batch.
 * Entities that end up different are stamped `rev = nextRevision`, `updatedAt = now`, `updatedBy = actor`;
 * unchanged entities keep their object identity. The inverse is one `restore` op that brings back the exact prior
 * content (modulo those stamps), including z-order.
 */
export function applyBoardOps(content: BoardContent, ops: readonly BoardOp[], ctx: BoardApplyContext): BoardApplyOutcome {
  const currentRevision = ctx.nextRevision - 1;
  if (ops.length > BOARD_LIMITS.maxOpsPerPatch) {
    return {
      ok: false,
      reason: 'limit',
      details: { kind: 'board-limit', limit: 'maxOpsPerPatch', max: BOARD_LIMITS.maxOpsPerPatch, actual: ops.length },
    };
  }
  const shapeIssues: Issues = [];
  ops.forEach((op, index) => validateBoardOpShape(op, childPath('ops', index), shapeIssues));
  if (shapeIssues.length > 0) return { ok: false, reason: 'invalid', issues: shapeIssues };
  if (ctx.checkConflicts && ctx.baseRevision > currentRevision) {
    return { ok: false, reason: 'conflict', conflicts: [{ opIndex: -1, id: '*', reason: 'stale-board', currentRev: currentRevision }] };
  }

  const engine = new BoardOpEngine(content, ops, ctx);
  engine.run();
  if (engine.conflicts.length > 0) return { ok: false, reason: 'conflict', conflicts: engine.conflicts };
  if (engine.issues.length > 0) return { ok: false, reason: 'invalid', issues: engine.issues };

  const work = engine.work;
  const originalNodes = new Map(content.nodes.map((node) => [node.id, node]));
  const originalEdges = new Map(content.edges.map((edge) => [edge.id, edge]));
  const originalOrder = content.nodes.map((node) => node.id);
  const now = ctx.now;

  // Stamp changed entities; unchanged ones keep their original objects.
  const changedNodeIds = new Set<string>();
  const finalNodes: BoardNode[] = work.order.map((id) => {
    const node = work.nodes.get(id)!;
    const original = originalNodes.get(id);
    if (original && !work.reordered.has(id) && equalModuloStamps(original, node, NODE_STAMP_KEYS)) return original;
    changedNodeIds.add(id);
    return { ...node, updatedAt: now, updatedBy: engine.stamp(), rev: ctx.nextRevision } as BoardNode;
  });
  const changedEdgeIds = new Set<string>();
  const finalEdges: BoardEdge[] = [...work.edges.values()].map((edge) => {
    const original = originalEdges.get(edge.id);
    if (original && equalModuloStamps(original, edge, EDGE_STAMP_KEYS)) return original;
    changedEdgeIds.add(edge.id);
    return { ...edge, updatedBy: engine.stamp(), rev: ctx.nextRevision };
  });
  finalEdges.sort(compareBoardEdges);
  const finalOrder = finalNodes.map((node) => node.id);
  const finalNodeIds = new Set(finalOrder);
  const finalEdgeIds = new Set(finalEdges.map((edge) => edge.id));
  const removedNodeIds = originalOrder.filter((id) => !finalNodeIds.has(id));
  const removedEdgeIds = content.edges.map((edge) => edge.id).filter((id) => !finalEdgeIds.has(id));
  const pagesChanged = !jsonEqual(work.pages, content.pages);
  const metaChanged = work.title !== content.title || !jsonEqual(work.settings, content.settings) || pagesChanged;
  const orderChanged = !arraysEqual(
    originalOrder.filter((id) => finalNodeIds.has(id)),
    finalOrder.filter((id) => originalNodes.has(id)),
  );

  const nothingChanged = changedNodeIds.size === 0 && changedEdgeIds.size === 0 && removedNodeIds.length === 0
    && removedEdgeIds.length === 0 && !metaChanged && !orderChanged;
  if (nothingChanged) {
    return {
      ok: true,
      content,
      results: engine.results,
      changes: emptyChangeSet(currentRevision),
      inverse: [],
      removedPaths: [],
      touchedNodeIds: [],
    };
  }

  const nextContent: BoardContent = {
    ...(work.title !== undefined ? { title: work.title } : {}),
    settings: work.settings,
    ...(work.pages !== undefined ? { pages: work.pages } : {}),
    nodes: finalNodes,
    edges: finalEdges,
  };

  // Post-validation: capacity limits (413), then integrity and per-field bounds of what changed (400).
  const limit = checkBoardContentLimits(nextContent);
  if (limit) return { ok: false, reason: 'limit', details: limit };
  const issues: Issues = [];
  finalNodes.forEach((node, index) => {
    if (changedNodeIds.has(node.id)) validateNodeRecord(node, childPath('nodes', index), 'full', issues);
  });
  collectBoardIntegrityIssues(nextContent, issues);
  if (issues.length > 0) return { ok: false, reason: 'invalid', issues };

  // Change set.
  const upsertNodes = finalNodes.filter((node) => changedNodeIds.has(node.id));
  const naiveOrder = [
    ...originalOrder.filter((id) => finalNodeIds.has(id)),
    ...upsertNodes.filter((node) => !originalNodes.has(node.id)).map((node) => node.id),
  ];
  const changes: BoardChangeSet = {
    fromRevision: currentRevision,
    toRevision: ctx.nextRevision,
    upsertNodes,
    removeNodeIds: removedNodeIds,
    upsertEdges: finalEdges.filter((edge) => changedEdgeIds.has(edge.id)),
    removeEdgeIds: removedEdgeIds,
    ...(arraysEqual(naiveOrder, finalOrder) ? {} : { order: finalOrder }),
    ...(metaChanged
      ? { meta: { title: work.title ?? null, settings: work.settings, ...(pagesChanged ? { pages: work.pages ?? null } : {}) } }
      : {}),
  };

  // Inverse: one restore op with the prior snapshots of everything that changed or disappeared.
  const restoreNodes = originalOrder
    .filter((id) => changedNodeIds.has(id) || !finalNodeIds.has(id))
    .map((id) => originalNodes.get(id)!);
  const restoreEdges = content.edges.filter((edge) => changedEdgeIds.has(edge.id) || !finalEdgeIds.has(edge.id));
  const createdNodeIds = finalOrder.filter((id) => !originalNodes.has(id));
  const createdEdgeIds = finalEdges.filter((edge) => !originalEdges.has(edge.id)).map((edge) => edge.id);
  const inverseExpectRev: Record<string, number> = {};
  for (const id of changedNodeIds) inverseExpectRev[id] = ctx.nextRevision;
  for (const id of changedEdgeIds) inverseExpectRev[id] = ctx.nextRevision;
  const createdSet = new Set(createdNodeIds);
  const simulatedOrder = [
    ...finalOrder.filter((id) => !createdSet.has(id)),
    ...restoreNodes.filter((node) => !finalNodeIds.has(node.id)).map((node) => node.id),
  ];
  const inverse: BoardOp[] = [{
    op: 'restore',
    nodes: restoreNodes,
    edges: restoreEdges,
    removeNodeIds: createdNodeIds,
    removeEdgeIds: createdEdgeIds,
    ...(arraysEqual(simulatedOrder, originalOrder) ? {} : { order: originalOrder }),
    expectRev: inverseExpectRev,
  }];
  // The restore op cannot carry board meta, so a title/settings change adds a set-meta op after it.
  if (metaChanged) {
    inverse.push({
      op: 'set-meta',
      ...(work.title !== content.title ? { title: content.title ?? null } : {}),
      ...(jsonEqual(work.settings, content.settings) ? {} : { settings: { ...content.settings } }),
      ...(pagesChanged ? { pages: content.pages ?? [] } : {}),
    });
  }

  // Removed file paths (net: a path still referenced by a surviving node is not reported).
  const survivingPaths = new Set(finalNodes.flatMap((node) => nodeFilePaths(node)));
  const removedPaths = [...new Set(
    removedNodeIds.flatMap((id) => nodeFilePaths(originalNodes.get(id)!)).filter((path) => !survivingPaths.has(path)),
  )];

  return {
    ok: true,
    content: nextContent,
    results: engine.results,
    changes,
    inverse,
    removedPaths,
    touchedNodeIds: [...upsertNodes.map((node) => node.id), ...removedNodeIds],
  };
}
