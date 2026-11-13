// SPDX-License-Identifier: Apache-2.0
// Board request validation, PUT normalization and whole-content validation (spec 04 §3.2, plan R3).
import type { ApiValidationIssue } from '../errors.js';
import {
  BOARD_LIMITS,
  BOARD_NODE_KINDS,
  type BoardActor,
  type BoardContent,
  type BoardEdge,
  type BoardImportDesignCanvasRequest,
  type BoardLimitErrorDetails,
  type BoardNode,
  type BoardNodeKind,
  type BoardPage,
  type BoardPatchRequest,
  type BoardPutRequest,
  type BoardSettings,
  type BoardSyncRequest,
  type BoardViewport,
} from '../api/board.js';
import { compareBoardEdges, defaultBoardSettings } from './defaults.js';
import { edgeEndpointError } from './geometry.js';
import { isBoardId } from './ids.js';
import {
  BOARD_BACKGROUNDS,
  BOARD_PATCH_KEY_SET,
  applyNodeDefaults,
  buildActor,
  buildEdgeRecord,
  buildNodeRecord,
  checkActorField,
  checkBoardIdField,
  checkEnumField,
  checkIdArray,
  checkNumberField,
  checkPlacement,
  checkRev,
  checkRevRecord,
  checkSettingsPatch,
  checkStringField,
  childPath,
  isPlainObject,
  isSafeBoardPath,
  isValidActor,
  orderNodeKeys,
  patchKeysForKind,
  pushIssue,
  validateEdgeRecord,
  validateNodeRecord,
  type Issues,
} from './schema.js';
import { boardGroupDepth, hasParentCycle, indexBoardNodes } from './tree.js';

export { isBoardColor, isSafeBoardPath, isSafeBoardUrl } from './schema.js';

export type BoardValidationResult<T> = { ok: true; value: T } | { ok: false; issues: ApiValidationIssue[] };

/** Keys an `update` patch may carry for each node kind (`missing` is additionally accepted from sync/daemon actors). */
export const BOARD_PATCH_KEYS_BY_KIND: Readonly<Record<BoardNodeKind, readonly string[]>> = (() => {
  const table = {} as Record<BoardNodeKind, readonly string[]>;
  for (const kind of BOARD_NODE_KINDS) table[kind] = patchKeysForKind(kind);
  return table;
})();

function result<T>(issues: Issues, value: T): BoardValidationResult<T> {
  return issues.length > 0 ? { ok: false, issues } : { ok: true, value };
}

const OP_KINDS = ['add', 'update', 'move', 'remove', 'connect', 'disconnect', 'reorder', 'group', 'ungroup', 'layout', 'set-meta', 'restore'] as const;
const GROUP_DRAFT_FORBIDDEN_KEYS = ['kind', 'x', 'y', 'w', 'h', 'parentId'] as const;
const MAX_LAYOUT_GAP = 10_000;
const MAX_LAYOUT_COLUMNS = 100;

function checkOptionalBoolean(op: Record<string, unknown>, key: string, path: string, issues: Issues): void {
  if (op[key] !== undefined && typeof op[key] !== 'boolean') pushIssue(issues, childPath(path, key), 'invalid-type', 'Expected a boolean.');
}

/** Validates a group draft (`group` op): a group node minus kind/position/size/parent. */
function validateGroupDraftShape(draft: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(draft)) {
    pushIssue(issues, path, 'invalid-type', 'Expected a group draft object.');
    return;
  }
  for (const key of GROUP_DRAFT_FORBIDDEN_KEYS) {
    if (draft[key] !== undefined) pushIssue(issues, childPath(path, key), 'field-not-allowed', `${key} is set by the group op.`);
  }
  const withoutForbidden: Record<string, unknown> = { ...draft };
  for (const key of GROUP_DRAFT_FORBIDDEN_KEYS) delete withoutForbidden[key];
  validateNodeRecord({ ...withoutForbidden, kind: 'group' }, path, 'draft', issues);
}

/** Structural validation of one op (value checks that need the target node's kind run inside `applyBoardOps`). */
export function validateBoardOpShape(op: unknown, path: string, issues: Issues): void {
  if (!isPlainObject(op)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an op object.');
    return;
  }
  if (!(OP_KINDS as readonly unknown[]).includes(op.op)) {
    pushIssue(issues, childPath(path, 'op'), 'invalid-value', `Expected one of ${OP_KINDS.join(', ')}.`);
    return;
  }
  switch (op.op) {
    case 'add':
      validateNodeRecord(op.node, childPath(path, 'node'), 'draft', issues);
      if (op.placement !== undefined) checkPlacement(op.placement, childPath(path, 'placement'), issues);
      checkOptionalBoolean(op, 'ifAbsent', path, issues);
      return;
    case 'update': {
      checkBoardIdField(op.id, childPath(path, 'id'), issues);
      if (op.expectRev !== undefined) checkRev(op.expectRev, childPath(path, 'expectRev'), issues);
      const patchPath = childPath(path, 'patch');
      if (!isPlainObject(op.patch)) {
        pushIssue(issues, patchPath, 'invalid-type', 'Expected a patch object.');
        return;
      }
      for (const key of Object.keys(op.patch)) {
        if (!BOARD_PATCH_KEY_SET.has(key)) {
          pushIssue(issues, childPath(patchPath, key), 'field-not-allowed', `${key} is not a patchable node field.`);
        }
      }
      return;
    }
    case 'move': {
      const movesPath = childPath(path, 'moves');
      if (!Array.isArray(op.moves) || op.moves.length === 0 || op.moves.length > BOARD_LIMITS.maxNodes) {
        pushIssue(issues, movesPath, Array.isArray(op.moves) ? 'out-of-range' : 'invalid-type', 'Expected 1..2000 moves.');
        return;
      }
      op.moves.forEach((move, index) => {
        const movePath = childPath(movesPath, index);
        if (!isPlainObject(move)) {
          pushIssue(issues, movePath, 'invalid-type', 'Expected {id, x, y}.');
          return;
        }
        checkBoardIdField(move.id, childPath(movePath, 'id'), issues);
        checkNumberField(move.x, childPath(movePath, 'x'), issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
        checkNumberField(move.y, childPath(movePath, 'y'), issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
      });
      if (op.expectRev !== undefined) checkRevRecord(op.expectRev, childPath(path, 'expectRev'), issues);
      return;
    }
    case 'remove':
      checkIdArray(op.ids, childPath(path, 'ids'), issues, 1, BOARD_LIMITS.maxNodes);
      checkOptionalBoolean(op, 'cascade', path, issues);
      if (op.expectRev !== undefined) checkRevRecord(op.expectRev, childPath(path, 'expectRev'), issues);
      return;
    case 'connect':
      validateEdgeRecord(op.edge, childPath(path, 'edge'), 'draft', issues);
      checkOptionalBoolean(op, 'ifAbsent', path, issues);
      return;
    case 'disconnect':
      checkIdArray(op.ids, childPath(path, 'ids'), issues, 1, BOARD_LIMITS.maxEdges);
      return;
    case 'reorder':
      checkBoardIdField(op.id, childPath(path, 'id'), issues);
      if (op.to !== 'front' && op.to !== 'back') {
        checkNumberField(op.to, childPath(path, 'to'), issues, 0, BOARD_LIMITS.maxNodes, true);
      }
      if (op.expectRev !== undefined) checkRev(op.expectRev, childPath(path, 'expectRev'), issues);
      return;
    case 'group':
      checkIdArray(op.ids, childPath(path, 'ids'), issues, 1, BOARD_LIMITS.maxNodes);
      validateGroupDraftShape(op.group, childPath(path, 'group'), issues);
      return;
    case 'ungroup':
      checkBoardIdField(op.id, childPath(path, 'id'), issues);
      if (op.expectRev !== undefined) checkRev(op.expectRev, childPath(path, 'expectRev'), issues);
      return;
    case 'layout': {
      const targetPath = childPath(path, 'target');
      const target = op.target;
      if (!isPlainObject(target)) {
        pushIssue(issues, targetPath, 'invalid-type', 'Expected {groupId} | {ids} | {all: true}.');
      } else if (target.groupId !== undefined) {
        checkBoardIdField(target.groupId, childPath(targetPath, 'groupId'), issues);
      } else if (target.ids !== undefined) {
        checkIdArray(target.ids, childPath(targetPath, 'ids'), issues, 1, BOARD_LIMITS.maxNodes);
      } else if (target.all !== true) {
        pushIssue(issues, targetPath, 'invalid-value', 'Expected {groupId} | {ids} | {all: true}.');
      }
      checkEnumField(op.mode, childPath(path, 'mode'), issues, ['row', 'column', 'grid', 'tidy']);
      if (op.gap !== undefined) checkNumberField(op.gap, childPath(path, 'gap'), issues, 0, MAX_LAYOUT_GAP);
      if (op.columns !== undefined) checkNumberField(op.columns, childPath(path, 'columns'), issues, 1, MAX_LAYOUT_COLUMNS, true);
      return;
    }
    case 'set-meta':
      if (op.title !== undefined && op.title !== null) {
        checkStringField(op.title, childPath(path, 'title'), issues, 0, BOARD_LIMITS.maxTitleLength);
      }
      if (op.settings !== undefined) checkSettingsPatch(op.settings, childPath(path, 'settings'), issues);
      if (op.pages !== undefined) checkPages(op.pages, childPath(path, 'pages'), issues);
      return;
    case 'restore': {
      const nodesPath = childPath(path, 'nodes');
      if (!Array.isArray(op.nodes)) pushIssue(issues, nodesPath, 'invalid-type', 'Expected an array of nodes.');
      else op.nodes.forEach((node, index) => validateNodeRecord(node, childPath(nodesPath, index), 'full', issues));
      const edgesPath = childPath(path, 'edges');
      if (!Array.isArray(op.edges)) pushIssue(issues, edgesPath, 'invalid-type', 'Expected an array of edges.');
      else op.edges.forEach((edge, index) => validateEdgeRecord(edge, childPath(edgesPath, index), 'full', issues));
      checkIdArray(op.removeNodeIds, childPath(path, 'removeNodeIds'), issues, 0, BOARD_LIMITS.maxNodes * 2);
      checkIdArray(op.removeEdgeIds, childPath(path, 'removeEdgeIds'), issues, 0, BOARD_LIMITS.maxEdges * 2);
      if (op.order !== undefined) checkIdArray(op.order, childPath(path, 'order'), issues, 0, BOARD_LIMITS.maxNodes * 2);
      if (op.expectRev !== undefined) checkRevRecord(op.expectRev, childPath(path, 'expectRev'), issues);
      return;
    }
    default:
      return;
  }
}

function checkPages(value: unknown, path: string, issues: Issues): void {
  if (!Array.isArray(value)) {
    pushIssue(issues, path, 'invalid-type', 'Expected an array of pages.');
    return;
  }
  if (value.length > BOARD_LIMITS.maxPages) {
    pushIssue(issues, path, 'out-of-range', `A board has at most ${BOARD_LIMITS.maxPages} pages.`);
  }
  const seen = new Set<unknown>();
  value.forEach((page: unknown, index) => {
    const pagePath = childPath(path, index);
    if (!isPlainObject(page)) {
      pushIssue(issues, pagePath, 'invalid-type', 'Expected a page object.');
      return;
    }
    if (!isBoardId(page.id)) pushIssue(issues, childPath(pagePath, 'id'), 'invalid-value', 'Expected a board id.');
    else if (seen.has(page.id)) pushIssue(issues, childPath(pagePath, 'id'), 'duplicate-id', `Duplicate page id ${page.id}.`);
    seen.add(page.id);
    checkStringField(page.title, childPath(pagePath, 'title'), issues, 1, BOARD_LIMITS.maxPageTitleLength);
  });
}

function checkBaseRevision(value: unknown, issues: Issues): void {
  if (value === undefined) pushIssue(issues, 'baseRevision', 'required', 'baseRevision is required.');
  else checkRev(value, 'baseRevision', issues);
}

export function validateBoardPatchRequest(v: unknown): BoardValidationResult<BoardPatchRequest> {
  const issues: Issues = [];
  if (!isPlainObject(v)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected an object.' }] };
  checkBaseRevision(v.baseRevision, issues);
  if (!Array.isArray(v.ops)) {
    pushIssue(issues, 'ops', v.ops === undefined ? 'required' : 'invalid-type', 'Expected an array of ops.');
  } else if (v.ops.length === 0 || v.ops.length > BOARD_LIMITS.maxOpsPerPatch) {
    pushIssue(issues, 'ops', 'out-of-range', `Expected 1..${BOARD_LIMITS.maxOpsPerPatch} ops.`);
  } else {
    v.ops.forEach((op, index) => validateBoardOpShape(op, childPath('ops', index), issues));
  }
  if (v.actor !== undefined) checkActorField(v.actor, 'actor', issues);
  return result(issues, v as unknown as BoardPatchRequest);
}

export function validateBoardPutRequest(v: unknown): BoardValidationResult<BoardPutRequest> {
  const issues: Issues = [];
  if (!isPlainObject(v)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected an object.' }] };
  checkBaseRevision(v.baseRevision, issues);
  const board = v.board;
  if (!isPlainObject(board)) {
    pushIssue(issues, 'board', board === undefined ? 'required' : 'invalid-type', 'Expected a board object.');
  } else {
    if (!Array.isArray(board.nodes)) pushIssue(issues, 'board.nodes', 'invalid-type', 'Expected an array of nodes.');
    if (!Array.isArray(board.edges)) pushIssue(issues, 'board.edges', 'invalid-type', 'Expected an array of edges.');
    if (board.title !== undefined) checkStringField(board.title, 'board.title', issues, 0, BOARD_LIMITS.maxTitleLength);
    if (board.settings !== undefined) checkSettingsPatch(board.settings, 'board.settings', issues);
  }
  if (v.actor !== undefined) checkActorField(v.actor, 'actor', issues);
  return result(issues, v as unknown as BoardPutRequest);
}

const SYNC_REASONS = ['open', 'run-started', 'run-finished', 'focus', 'media', 'files-changed', 'manual'] as const;
const MAX_SYNC_PATHS = 500;
const MAX_FOCUS_NAMES = 100;
const MAX_FOCUS_NAME_LENGTH = 600;

export function validateBoardSyncRequest(v: unknown): BoardValidationResult<BoardSyncRequest> {
  const issues: Issues = [];
  if (!isPlainObject(v)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected an object.' }] };
  checkEnumField(v.reason, 'reason', issues, SYNC_REASONS);
  if (v.conversationId !== undefined) checkStringField(v.conversationId, 'conversationId', issues, 1, 200);
  if (v.turn !== undefined) {
    const turn = v.turn;
    if (!isPlainObject(turn)) {
      pushIssue(issues, 'turn', 'invalid-type', 'Expected a turn hint object.');
    } else {
      checkStringField(turn.conversationId, 'turn.conversationId', issues, 1, 200);
      checkStringField(turn.messageId, 'turn.messageId', issues, 1, 200);
      if (turn.runId !== undefined) checkStringField(turn.runId, 'turn.runId', issues, 1, 200);
      checkEnumField(turn.status, 'turn.status', issues, ['running', 'terminal']);
      if (turn.paths !== undefined) {
        if (!Array.isArray(turn.paths) || turn.paths.length > MAX_SYNC_PATHS) {
          pushIssue(issues, 'turn.paths', 'invalid-value', `Expected at most ${MAX_SYNC_PATHS} paths.`);
        } else {
          turn.paths.forEach((path, index) => {
            if (!isSafeBoardPath(path)) pushIssue(issues, childPath('turn.paths', index), 'unsafe-path', 'Expected a project-relative path.');
          });
        }
      }
    }
  }
  if (v.focus !== undefined) {
    const focus = v.focus;
    if (!isPlainObject(focus)) {
      pushIssue(issues, 'focus', 'invalid-type', 'Expected a focus object.');
    } else {
      if (!Array.isArray(focus.names) || focus.names.length === 0 || focus.names.length > MAX_FOCUS_NAMES) {
        pushIssue(issues, 'focus.names', 'invalid-value', `Expected 1..${MAX_FOCUS_NAMES} names.`);
      } else {
        focus.names.forEach((name, index) => checkStringField(name, childPath('focus.names', index), issues, 1, MAX_FOCUS_NAME_LENGTH));
      }
      if (focus.primary !== undefined) checkStringField(focus.primary, 'focus.primary', issues, 1, MAX_FOCUS_NAME_LENGTH);
      if (focus.near !== undefined) {
        if (!isPlainObject(focus.near)) {
          pushIssue(issues, 'focus.near', 'invalid-type', 'Expected {x, y}.');
        } else {
          checkNumberField(focus.near.x, 'focus.near.x', issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
          checkNumberField(focus.near.y, 'focus.near.y', issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
        }
      }
    }
  }
  if (v.actor !== undefined) checkActorField(v.actor, 'actor', issues);
  return result(issues, v as unknown as BoardSyncRequest);
}

/** Bounds of a saved camera. The UI clamps zoom to its own range; storage only rejects absurd values. */
export const BOARD_VIEWPORT_ZOOM_RANGE = { min: 0.01, max: 64 } as const;

/** Validates a `BoardViewport`; a `BoardViewportPutRequest` (`{viewport}`) is accepted too. */
export function validateBoardViewport(v: unknown): BoardValidationResult<BoardViewport> {
  const issues: Issues = [];
  const viewport = isPlainObject(v) && isPlainObject(v.viewport) ? v.viewport : v;
  if (!isPlainObject(viewport)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected a viewport object.' }] };
  checkNumberField(viewport.centerX, 'centerX', issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
  checkNumberField(viewport.centerY, 'centerY', issues, -BOARD_LIMITS.maxCoordinate, BOARD_LIMITS.maxCoordinate);
  checkNumberField(viewport.zoom, 'zoom', issues, BOARD_VIEWPORT_ZOOM_RANGE.min, BOARD_VIEWPORT_ZOOM_RANGE.max);
  return result(issues, {
    centerX: viewport.centerX as number,
    centerY: viewport.centerY as number,
    zoom: viewport.zoom as number,
  });
}

/** `pageId` of a `PUT /board/viewport` body; anything else saves the camera without a page. */
export function boardViewportPageId(v: unknown): string | undefined {
  return isPlainObject(v) && isBoardId(v.pageId) ? v.pageId : undefined;
}

const DESIGN_CANVAS_DOCUMENT_ID = /^[A-Za-z0-9_-]{1,80}$/;

export function validateBoardImportRequest(v: unknown): BoardValidationResult<BoardImportDesignCanvasRequest> {
  const issues: Issues = [];
  if (!isPlainObject(v)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected an object.' }] };
  const ids = v.documentIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > BOARD_LIMITS.maxImportDocuments) {
    pushIssue(issues, 'documentIds', Array.isArray(ids) ? 'out-of-range' : 'invalid-type', `Expected 1..${BOARD_LIMITS.maxImportDocuments} document ids.`);
  } else {
    const seen = new Set<string>();
    ids.forEach((id, index) => {
      const path = childPath('documentIds', index);
      if (typeof id !== 'string' || !DESIGN_CANVAS_DOCUMENT_ID.test(id)) {
        pushIssue(issues, path, 'invalid-value', 'Expected a design-canvas document id.');
      } else if (seen.has(id)) {
        pushIssue(issues, path, 'duplicate-id', `Duplicate document id ${id}.`);
      } else {
        seen.add(id);
      }
    });
  }
  if (v.placement !== undefined) checkPlacement(v.placement, 'placement', issues);
  return result(issues, v as unknown as BoardImportDesignCanvasRequest);
}

// ---- normalization (PUT) ----------------------------------------------------------

export interface BoardNormalizeOptions {
  now: number;
  actor: BoardActor;
  /** Revision every entity is stamped with (the PUT's R + 1). */
  revision: number;
}

function validTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Normalizes a PUT body's `board` into `BoardContent`: unknown keys dropped, defaults filled, every entity stamped
 * `rev = revision`, `updatedAt = now`, `updatedBy = actor`; `createdAt` / `createdBy` / `missing` kept when valid.
 * Edges are sorted canonically. Integrity (parents, edges, depth) and limits are checked by `validateBoardContent`.
 */
export function normalizeBoardContent(raw: unknown, opts: BoardNormalizeOptions): BoardValidationResult<BoardContent> {
  const issues: Issues = [];
  if (!isPlainObject(raw)) return { ok: false, issues: [{ path: '', code: 'invalid-type', message: 'Expected a board object.' }] };
  const settings: BoardSettings = defaultBoardSettings();
  if (raw.settings !== undefined) {
    checkSettingsPatch(raw.settings, 'settings', issues);
    if (isPlainObject(raw.settings)) {
      if ((BOARD_BACKGROUNDS as readonly unknown[]).includes(raw.settings.background)) {
        settings.background = raw.settings.background as BoardSettings['background'];
      }
      if (typeof raw.settings.autoPlace === 'boolean') settings.autoPlace = raw.settings.autoPlace;
    }
  }
  let title: string | undefined;
  if (raw.title !== undefined && raw.title !== null) {
    if (checkStringField(raw.title, 'title', issues, 0, BOARD_LIMITS.maxTitleLength)) title = raw.title as string;
  }
  let pages: BoardPage[] | undefined;
  if (raw.pages !== undefined && raw.pages !== null) {
    checkPages(raw.pages, 'pages', issues);
    if (Array.isArray(raw.pages) && raw.pages.length > 0) {
      pages = raw.pages.filter(isPlainObject).map((page) => ({ id: page.id as string, title: page.title as string }));
    }
  }
  const actor = buildActor(opts.actor);
  const nodes: BoardNode[] = [];
  if (!Array.isArray(raw.nodes)) {
    pushIssue(issues, 'nodes', 'invalid-type', 'Expected an array of nodes.');
  } else {
    raw.nodes.forEach((entry, index) => {
      const path = childPath('nodes', index);
      if (!validateNodeRecord(entry, path, 'normalize', issues)) return;
      const node = buildNodeRecord(entry, 'normalize', false);
      applyNodeDefaults(node);
      node.createdAt = validTimestamp(entry.createdAt) ? entry.createdAt : opts.now;
      node.createdBy = isValidActor(entry.createdBy) ? buildActor(entry.createdBy) : buildActor(actor);
      node.updatedAt = opts.now;
      node.updatedBy = buildActor(actor);
      node.rev = opts.revision;
      if (isPlainObject(entry.missing) && validTimestamp(entry.missing.since)) node.missing = { since: entry.missing.since };
      nodes.push(orderNodeKeys(entry.kind, node) as unknown as BoardNode);
    });
  }
  const edges: BoardEdge[] = [];
  if (!Array.isArray(raw.edges)) {
    pushIssue(issues, 'edges', 'invalid-type', 'Expected an array of edges.');
  } else {
    raw.edges.forEach((entry, index) => {
      if (!validateEdgeRecord(entry, childPath('edges', index), 'normalize', issues)) return;
      const edge = buildEdgeRecord(entry, false);
      edge.createdAt = validTimestamp(entry.createdAt) ? entry.createdAt : opts.now;
      edge.createdBy = isValidActor(entry.createdBy) ? buildActor(entry.createdBy) : buildActor(actor);
      edge.updatedBy = buildActor(actor);
      edge.rev = opts.revision;
      edges.push(edge as unknown as BoardEdge);
    });
  }
  edges.sort(compareBoardEdges);
  const content: BoardContent = {
    ...(title !== undefined ? { title } : {}),
    settings,
    ...(pages ? { pages } : {}),
    nodes,
    edges,
  };
  return result(issues, content);
}

// ---- whole-content validation -----------------------------------------------------

/** The first breached capacity limit (nodes, edges, serialized size), or null. These map to HTTP 413. */
export function checkBoardContentLimits(content: BoardContent): BoardLimitErrorDetails | null {
  if (content.nodes.length > BOARD_LIMITS.maxNodes) {
    return { kind: 'board-limit', limit: 'maxNodes', max: BOARD_LIMITS.maxNodes, actual: content.nodes.length };
  }
  if (content.edges.length > BOARD_LIMITS.maxEdges) {
    return { kind: 'board-limit', limit: 'maxEdges', max: BOARD_LIMITS.maxEdges, actual: content.edges.length };
  }
  const size = JSON.stringify(content).length;
  if (size > BOARD_LIMITS.maxDocumentBytes) {
    return { kind: 'board-limit', limit: 'maxDocumentBytes', max: BOARD_LIMITS.maxDocumentBytes, actual: size };
  }
  return null;
}

/** Integrity checks shared by `validateBoardContent` and the op engine (no limits, no per-field checks). */
export function collectBoardIntegrityIssues(content: BoardContent, issues: Issues): void {
  const byId = new Map<string, BoardNode>();
  content.nodes.forEach((node, index) => {
    if (byId.has(node.id)) pushIssue(issues, childPath(childPath('nodes', index), 'id'), 'duplicate-id', `Duplicate node id ${node.id}.`);
    else byId.set(node.id, node);
  });
  const treeIndex = indexBoardNodes(content.nodes);
  content.nodes.forEach((node, index) => {
    const path = childPath('nodes', index);
    if (node.parentId !== undefined) {
      const parent = byId.get(node.parentId);
      if (!parent) pushIssue(issues, childPath(path, 'parentId'), 'unknown-parent', `Parent ${node.parentId} does not exist.`);
      else if (parent.kind !== 'group') pushIssue(issues, childPath(path, 'parentId'), 'parent-not-group', `Parent ${node.parentId} is not a group.`);
      else if (node.parentId === node.id || hasParentCycle(node.id, treeIndex)) {
        pushIssue(issues, childPath(path, 'parentId'), 'parent-cycle', 'Group parents form a cycle.');
      }
    }
    if (node.kind === 'group' && boardGroupDepth(node.id, treeIndex) > BOARD_LIMITS.maxGroupDepth) {
      pushIssue(issues, path, 'group-depth', `Groups nest at most ${BOARD_LIMITS.maxGroupDepth} levels.`);
    }
    if (node.kind === 'frame' && node.ref === null && !node.liveArtifactId) {
      pushIssue(issues, childPath(path, 'ref'), 'ref-required', 'A frame needs a ref or a liveArtifactId.');
    }
    if ((node.kind === 'image' || node.kind === 'video') && node.ref === null && !node.pending && !node.generation) {
      pushIssue(issues, childPath(path, 'ref'), 'ref-required', `An ${node.kind} node needs a ref unless it is pending or generating.`);
    }
    if (node.kind === 'audio' && node.ref === null && !node.pending) {
      pushIssue(issues, childPath(path, 'ref'), 'ref-required', 'An audio node needs a ref unless it is pending.');
    }
  });
  const edgeIds = new Set<string>();
  const triples = new Set<string>();
  content.edges.forEach((edge, index) => {
    const path = childPath('edges', index);
    if (edgeIds.has(edge.id) || byId.has(edge.id)) pushIssue(issues, childPath(path, 'id'), 'duplicate-id', `Duplicate id ${edge.id}.`);
    edgeIds.add(edge.id);
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from || !to) {
      pushIssue(issues, path, 'edge-endpoint-missing', `Edge endpoint ${!from ? edge.from : edge.to} does not exist.`);
      return;
    }
    const endpointError = edgeEndpointError(edge.kind, from, to);
    if (endpointError) pushIssue(issues, path, endpointError, `Edge ${edge.kind} ${from.kind} → ${to.kind} is not allowed (${endpointError}).`);
    const triple = `${edge.from}\u0000${edge.to}\u0000${edge.kind}`;
    if (triples.has(triple)) pushIssue(issues, path, 'edge-duplicate', 'An edge with the same from/to/kind exists.');
    triples.add(triple);
  });
}

/**
 * Full validation of stored content: per-field bounds of every node and edge, unique ids, parent/edge integrity,
 * group depth, kind invariants (plan R3b ref rule) and capacity limits (issues with code 'limit').
 */
export function validateBoardContent(content: BoardContent): ApiValidationIssue[] {
  const issues: Issues = [];
  if (!isPlainObject(content)) return [{ path: '', code: 'invalid-type', message: 'Expected board content.' }];
  if (content.title !== undefined) checkStringField(content.title, 'title', issues, 0, BOARD_LIMITS.maxTitleLength);
  if (!isPlainObject(content.settings)) {
    pushIssue(issues, 'settings', 'invalid-type', 'Expected board settings.');
  } else {
    checkEnumField(content.settings.background, 'settings.background', issues, BOARD_BACKGROUNDS);
    if (typeof content.settings.autoPlace !== 'boolean') pushIssue(issues, 'settings.autoPlace', 'invalid-type', 'Expected a boolean.');
  }
  if (!Array.isArray(content.nodes) || !Array.isArray(content.edges)) {
    pushIssue(issues, '', 'invalid-type', 'Expected nodes and edges arrays.');
    return issues;
  }
  let structurallyValid = true;
  content.nodes.forEach((node, index) => {
    if (!validateNodeRecord(node, childPath('nodes', index), 'full', issues)) structurallyValid = false;
  });
  content.edges.forEach((edge, index) => {
    if (!validateEdgeRecord(edge, childPath('edges', index), 'full', issues)) structurallyValid = false;
  });
  if (structurallyValid) collectBoardIntegrityIssues(content, issues);
  const limit = checkBoardContentLimits(content);
  if (limit) pushIssue(issues, limit.limit, 'limit', `${limit.limit} exceeded: ${limit.actual} > ${limit.max}.`);
  return issues;
}
