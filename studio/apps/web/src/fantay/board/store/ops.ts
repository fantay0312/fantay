// SPDX-License-Identifier: AGPL-3.0-only
// Engine transactions → 04 contract ops (spec 03 §3.11 with plan R1). The engine never applies ops itself: a
// transaction is normalized here (integer geometry, kind-allowed patch keys, no-op elimination, edge endpoint
// rules) and sent to the 04 store with `dataStore.apply(ops, applyOptionsFor(tx))`. Undo/redo is the 04 store's
// (server inverses), so only `origin: 'local'` transactions are undoable.
import {
  BOARD_LIMITS,
  BOARD_PATCH_KEYS_BY_KIND,
  edgeEndpointError,
  type BoardEdgeKind,
  type BoardGroupDraft,
  type BoardNodeDraft,
  type BoardNodeKind,
  type BoardNodePatch,
  type BoardOp as ContractOp,
  type BoardPlacement,
} from '@open-design/contracts';

import type { BoardApplyOptions } from '../data/types';
import { jsonEqual } from '../model/contract-adapter';
import type { EngineDoc, EngineNode } from '../model/types';

export type TxOrigin = 'local' | 'agent' | 'remote' | 'system';
export type BoardTxLabel =
  | 'create' | 'delete' | 'move' | 'resize' | 'nudge' | 'rename' | 'style' | 'text' | 'group' | 'ungroup'
  | 'reorder' | 'lock' | 'connect' | 'disconnect' | 'paste' | 'duplicate' | 'device' | 'cover' | 'autosize'
  | 'align' | 'insert' | 'visibility';

/** A new node: common fields plus kind-specific contract fields in `data` (e.g. `ref`, `text`, `shape`). */
export interface NewNodeDraft {
  kind: BoardNodeKind;
  id?: string;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  title?: string;
  parentId?: string | null;
  locked?: boolean;
  hidden?: boolean;
  variantLabel?: string;
  data?: Record<string, unknown>;
}

/** A node change: common fields plus contract patch keys in `data`; `null` clears an optional field. */
export interface NodePatch {
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  title?: string | null;
  parentId?: string | null;
  variantLabel?: string | null;
  locked?: boolean;
  hidden?: boolean;
  autoSize?: boolean;
  data?: BoardNodePatch;
}

export type EngineOp =
  | { type: 'add'; node: NewNodeDraft; placement?: BoardPlacement; ifAbsent?: boolean }
  | { type: 'patch'; id: string; patch: NodePatch }
  | { type: 'move'; moves: ReadonlyArray<{ id: string; x: number; y: number }> }
  | { type: 'remove'; ids: readonly string[]; cascade?: boolean }
  | { type: 'connect'; edge: { id?: string; kind: BoardEdgeKind; from: string; to: string; label?: string }; ifAbsent?: boolean }
  | { type: 'disconnect'; ids: readonly string[] }
  | { type: 'reorder'; id: string; to: 'front' | 'back' | number }
  | { type: 'group'; ids: readonly string[]; group: BoardGroupDraft }
  | { type: 'ungroup'; id: string };

export interface BoardTransaction {
  origin: TxOrigin;
  label: BoardTxLabel;
  ops: readonly EngineOp[];
  /** consecutive undoable applies with the same key within 1500 ms merge into one undo entry (R1) */
  coalesceKey?: string;
}

export interface TranslateContext {
  doc: EngineDoc;
  newNodeId?: () => string;
  newEdgeId?: () => string;
}

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

function randomChars(count: number): string {
  const bytes = new Uint8Array(count);
  const cryptoApi = typeof globalThis !== 'undefined' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') cryptoApi.getRandomValues(bytes);
  else for (let index = 0; index < count; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  let out = '';
  for (const byte of bytes) out += ID_ALPHABET[byte % 36];
  return out;
}

/** Random board id (`n_…` / `e_…`, matches contracts `BOARD_ID_PATTERN`). */
export function newBoardId(prefix: 'n' | 'e'): string {
  return `${prefix}_${randomChars(16)}`;
}

const SERVER_KEYS: ReadonlySet<string> = new Set(['rev', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'missing', 'id', 'kind']);
const GEOMETRY_KEYS: ReadonlySet<string> = new Set(['x', 'y', 'w', 'h']);

/** Whole world px (never -0). */
function roundCoord(value: number): number {
  return Math.round(value) + 0;
}

function clampSize(kind: BoardNodeKind, value: number): number {
  const max = kind === 'group' ? BOARD_LIMITS.maxGroupSize : BOARD_LIMITS.maxNodeSize;
  return Math.min(max, Math.max(BOARD_LIMITS.minNodeSize, roundCoord(value)));
}

function normalizeGeometry(kind: BoardNodeKind, key: string, value: number): number {
  if (key === 'w' || key === 'h') return clampSize(kind, value);
  return roundCoord(value);
}

/** Contract patch for an engine patch, or null when it changes nothing. Keys the kind cannot patch are dropped. */
export function nodePatchToContract(node: EngineNode, patch: NodePatch): BoardNodePatch | null {
  const allowed = new Set(BOARD_PATCH_KEYS_BY_KIND[node.kind]);
  const current = node.source as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const put = (key: string, raw: unknown): void => {
    if (raw === undefined || !allowed.has(key)) return;
    let value = raw;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return;
      if (GEOMETRY_KEYS.has(key)) value = normalizeGeometry(node.kind, key, value);
    }
    if ((key === 'title' || key === 'variantLabel') && value === '') value = null;
    const existing = current[key];
    if (value === null) {
      if (existing === undefined || existing === null) return;
      out[key] = null;
      return;
    }
    if (jsonEqual(existing, value)) return;
    out[key] = value;
  };
  put('x', patch.x);
  put('y', patch.y);
  put('w', patch.w);
  put('h', patch.h);
  put('title', patch.title);
  put('parentId', patch.parentId);
  put('variantLabel', patch.variantLabel);
  put('locked', patch.locked);
  put('hidden', patch.hidden);
  put('autoSize', patch.autoSize);
  for (const [key, value] of Object.entries(patch.data ?? {})) {
    if (GEOMETRY_KEYS.has(key) || SERVER_KEYS.has(key)) continue;
    put(key, value);
  }
  return Object.keys(out).length > 0 ? (out as BoardNodePatch) : null;
}

/** Contract `add` draft: integer geometry, defined common fields, kind fields without server-managed keys. */
export function newNodeDraftToContract(draft: NewNodeDraft, id: string): BoardNodeDraft {
  const out: Record<string, unknown> = { kind: draft.kind, id };
  if (typeof draft.x === 'number' && typeof draft.y === 'number' && Number.isFinite(draft.x) && Number.isFinite(draft.y)) {
    out.x = roundCoord(draft.x);
    out.y = roundCoord(draft.y);
  }
  if (typeof draft.w === 'number' && Number.isFinite(draft.w)) out.w = clampSize(draft.kind, draft.w);
  if (typeof draft.h === 'number' && Number.isFinite(draft.h)) out.h = clampSize(draft.kind, draft.h);
  if (draft.title) out.title = draft.title;
  if (typeof draft.parentId === 'string') out.parentId = draft.parentId;
  if (draft.locked) out.locked = true;
  if (draft.hidden) out.hidden = true;
  if (draft.variantLabel) out.variantLabel = draft.variantLabel;
  for (const [key, value] of Object.entries(draft.data ?? {})) {
    if (value === undefined || SERVER_KEYS.has(key) || GEOMETRY_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out as unknown as BoardNodeDraft;
}

function edgeExists(doc: EngineDoc, from: string, to: string, kind: BoardEdgeKind): boolean {
  for (const edge of doc.edges.values()) if (edge.from === from && edge.to === to && edge.kind === kind) return true;
  return false;
}

/**
 * Normalizes engine ops into contract ops against the current document. Ops that cannot change anything (unchanged
 * moves, empty patches, unknown targets, invalid or duplicate connections) are dropped.
 */
export function toContractOps(ops: readonly EngineOp[], ctx: TranslateContext): ContractOp[] {
  const { doc } = ctx;
  const nodeId = ctx.newNodeId ?? (() => newBoardId('n'));
  const edgeId = ctx.newEdgeId ?? (() => newBoardId('e'));
  /** ids added earlier in the same transaction (later ops may target them) */
  const added = new Map<string, BoardNodeKind>();
  const out: ContractOp[] = [];
  const nodeKind = (id: string): BoardNodeKind | undefined => doc.nodes.get(id)?.kind ?? added.get(id);
  for (const op of ops) {
    switch (op.type) {
      case 'add': {
        const id = op.node.id ?? nodeId();
        added.set(id, op.node.kind);
        out.push({
          op: 'add',
          node: newNodeDraftToContract(op.node, id),
          ...(op.placement ? { placement: op.placement } : {}),
          ...(op.ifAbsent ? { ifAbsent: true } : {}),
        });
        break;
      }
      case 'patch': {
        const node = doc.nodes.get(op.id);
        if (!node) {
          // a node added in the same transaction: no current value to diff against
          const kind = added.get(op.id);
          if (!kind) break;
          const allowed = new Set(BOARD_PATCH_KEYS_BY_KIND[kind]);
          const { data, ...common } = op.patch;
          const patch: Record<string, unknown> = {};
          for (const [key, value] of [...Object.entries(common), ...Object.entries(data ?? {})]) {
            if (value === undefined || !allowed.has(key)) continue;
            patch[key] = typeof value === 'number' && GEOMETRY_KEYS.has(key) ? normalizeGeometry(kind, key, value) : value;
          }
          if (Object.keys(patch).length > 0) out.push({ op: 'update', id: op.id, patch: patch as BoardNodePatch });
          break;
        }
        const patch = nodePatchToContract(node, op.patch);
        if (patch) out.push({ op: 'update', id: op.id, patch });
        break;
      }
      case 'move': {
        const moves: Array<{ id: string; x: number; y: number }> = [];
        for (const move of op.moves) {
          if (!Number.isFinite(move.x) || !Number.isFinite(move.y)) continue;
          const x = roundCoord(move.x);
          const y = roundCoord(move.y);
          const node = doc.nodes.get(move.id);
          if (!node) {
            if (added.has(move.id)) moves.push({ id: move.id, x, y });
            continue;
          }
          if (node.x === x && node.y === y) continue;
          moves.push({ id: move.id, x, y });
        }
        if (moves.length > 0) out.push({ op: 'move', moves });
        break;
      }
      case 'remove': {
        const ids = op.ids.filter((id) => doc.nodes.has(id) || added.has(id));
        if (ids.length > 0) out.push({ op: 'remove', ids, ...(op.cascade ? { cascade: true } : {}) });
        break;
      }
      case 'connect': {
        const { from, to, kind } = op.edge;
        const fromKind = nodeKind(from);
        const toKind = nodeKind(to);
        if (!fromKind || !toKind) break;
        if (edgeEndpointError(kind, { id: from, kind: fromKind }, { id: to, kind: toKind }) !== null) break;
        if (edgeExists(doc, from, to, kind)) break;
        out.push({
          op: 'connect',
          edge: { id: op.edge.id ?? edgeId(), kind, from, to, ...(op.edge.label ? { label: op.edge.label } : {}) },
          ...(op.ifAbsent ? { ifAbsent: true } : {}),
        });
        break;
      }
      case 'disconnect': {
        const ids = op.ids.filter((id) => doc.edges.has(id));
        if (ids.length > 0) out.push({ op: 'disconnect', ids });
        break;
      }
      case 'reorder': {
        if (doc.nodes.has(op.id)) out.push({ op: 'reorder', id: op.id, to: op.to });
        break;
      }
      case 'group': {
        const ids = op.ids.filter((id) => doc.nodes.has(id) || added.has(id));
        if (ids.length >= 2) out.push({ op: 'group', ids, group: op.group });
        break;
      }
      case 'ungroup': {
        if (doc.nodes.get(op.id)?.kind === 'group') out.push({ op: 'ungroup', id: op.id });
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** 04 apply options of a transaction (plan R1): only local edits are undoable; others resolve conflicts silently. */
export function applyOptionsFor(tx: BoardTransaction): BoardApplyOptions {
  return {
    undoable: tx.origin === 'local',
    silentConflict: tx.origin !== 'local',
    label: tx.label,
    ...(tx.coalesceKey ? { coalesceKey: tx.coalesceKey } : {}),
  };
}
