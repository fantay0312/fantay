// SPDX-License-Identifier: Apache-2.0
// Board service behind the board routes (spec 04 §4.1, §4.3–§4.6): the PATCH and PUT pipelines, chat sync, the
// viewport, covers, and `applyOps` for server-side writers (plan R11: the W2 design-canvas import route patches
// design nodes through the service that `registerBoardRoutes` returns). Validation and op semantics come from the
// contracts (`applyBoardOps`, `validateBoard*`, `normalizeBoardContent`); this file only adds the I/O around them.
import { randomBytes } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  BOARD_LIMITS,
  applyBoardOps,
  boardCompositionDir,
  boardCoverApiPath,
  boardKindForPath,
  boardPagesOf,
  boardViewportPageId,
  checkBoardContentLimits,
  emptyBoardContent,
  emptyBoardSyncLedger,
  normalizeBoardContent,
  resolveBoardPageId,
  validateBoardContent,
  validateBoardPatchRequest,
  validateBoardPutRequest,
  validateBoardSyncRequest,
  validateBoardViewport,
  type ApiErrorCode,
  type ApiValidationIssue,
  type BoardActor,
  type BoardChangeReason,
  type BoardChangeSet,
  type BoardChangedSsePayload,
  type BoardContent,
  type BoardCoverUploadResponse,
  type BoardEdge,
  type BoardFileRef,
  type BoardGetResponse,
  type BoardLimitErrorDetails,
  type BoardNode,
  type BoardNodeKind,
  type BoardOp,
  type BoardOpConflict,
  type BoardPatchResponse,
  type BoardRefErrorDetails,
  type BoardSyncLedger,
  type BoardSyncResponse,
  type ProjectKind,
  type ProjectPlatform,
} from '@open-design/contracts';

import { ensureWorkspaceArtifactForPath, getLiveWorkspaceArtifactByPath } from '../../chat-artifacts/store.js';
import { kindForArtifactPath, mimeForArtifactPath } from '../../chat-artifacts/mime.js';
import {
  gcBoardCovers,
  gcOrphanBoardCoverDirs,
  normalizeBoardCoverContentType,
  readBoardCover,
  sniffBoardCoverMime,
  writeBoardCover,
  type BoardCoverMime,
} from './covers.js';
import { boardChangedPayload } from './events.js';
import {
  applyBoardOpsInSlices,
  boardNodeFileRefs,
  planBoardSync,
  recordBoardDismissals,
  type BoardPlannerInput,
} from './planner.js';
import {
  BoardRevisionMismatchError,
  boardCreatedAtWatermark,
  boardDocumentFromRow,
  commitBoard,
  createdIdsInOpOrder,
  readBoardDocument,
  readBoardRow,
  stampMonotonicCreatedAt,
  writeBoardLedger,
  writeBoardViewport,
  type BoardRow,
} from './store.js';
import { gatherBoardSyncInputs } from './sync-inputs.js';

type SqliteDb = Database.Database;

export interface BoardProjectRecord {
  id: string;
  metadata?: unknown;
}

export interface BoardServiceDeps {
  db: SqliteDb;
  paths: { PROJECTS_DIR: string; RUNTIME_DATA_DIR: string };
  projectFiles: {
    resolveProjectFilePath: (projectsRoot: string, projectId: string, name: string, metadata?: unknown) => Promise<{ name: string; mtime: number }>;
    listFiles: (projectsRoot: string, projectId: string, opts?: { metadata?: unknown }) => Promise<Array<{ name: string; mtime: number }>>;
  };
  getProject: (db: SqliteDb, id: string) => BoardProjectRecord | null;
  emitProjectEvent: (projectId: string, payload: BoardChangedSsePayload) => boolean;
  now?: () => number;
  newId?: (prefix: 'n' | 'e') => string;
  warn?: (message: string, detail?: unknown) => void;
}

export interface BoardServiceError {
  status: number;
  code: ApiErrorCode;
  message: string;
  details?: unknown;
}

export type BoardServiceResult<T> = { ok: true; value: T } | { ok: false; error: BoardServiceError };

export interface BoardCoverUploadInput {
  body: unknown;
  contentType: unknown;
  width: unknown;
  height: unknown;
  sourceMtime?: unknown;
}

export interface BoardServerApplyInput {
  projectId: string;
  /**
   * Ops, or a builder that runs inside the commit transaction against the current content (race-free idempotency
   * checks such as "a design node with this `migratedFrom` already exists"). Array ops get the same ref checks as
   * PATCH; a builder's file refs reuse live identities only.
   */
  ops: readonly BoardOp[] | ((content: BoardContent, revision: number) => readonly BoardOp[]);
  /** Default `{kind:'daemon'}`. Applied without per-entity conflict checks (missing targets / existing ids skip). */
  actor?: BoardActor;
  /** Reason carried by the `board-changed` SSE event, e.g. `'import'`. */
  reason: BoardChangeReason;
}

export interface BoardService {
  get(projectId: string, opts?: { includeSync?: boolean }): BoardGetResponse;
  patch(projectId: string, body: unknown): Promise<BoardServiceResult<BoardPatchResponse>>;
  put(projectId: string, body: unknown): Promise<BoardServiceResult<BoardGetResponse>>;
  sync(projectId: string, body: unknown): Promise<BoardServiceResult<BoardSyncResponse>>;
  setViewport(projectId: string, body: unknown): BoardServiceResult<{ ok: true }>;
  saveCover(projectId: string, input: BoardCoverUploadInput): Promise<BoardServiceResult<BoardCoverUploadResponse>>;
  readCover(projectId: string, digest: string): Promise<{ bytes: Buffer; mime: BoardCoverMime } | null>;
  applyOps(input: BoardServerApplyInput): Promise<BoardServiceResult<BoardPatchResponse>>;
  /** Deletes cover dirs whose project row is gone (run once, 30 s after registration). */
  collectOrphanCoverDirs(): Promise<string[]>;
}

// ---- small helpers ----------------------------------------------------------------------------------

const SYNC_ACTOR: BoardActor = { kind: 'sync' };
const PROJECT_KINDS: readonly ProjectKind[] = ['prototype', 'deck', 'template', 'other', 'brand', 'image', 'video', 'audio'];
const PROJECT_PLATFORMS: readonly ProjectPlatform[] = ['auto', 'responsive', 'web-desktop', 'mobile-ios', 'mobile-android', 'tablet', 'desktop-app'];
const NODE_STAMP_KEYS: ReadonlySet<string> = new Set(['rev', 'updatedAt', 'updatedBy']);
const EDGE_STAMP_KEYS: ReadonlySet<string> = new Set(['rev', 'updatedBy']);

function ok<T>(value: T): BoardServiceResult<T> {
  return { ok: true, value };
}

function fail<T>(status: number, code: ApiErrorCode, message: string, details?: unknown): BoardServiceResult<T> {
  return { ok: false, error: { status, code, message, ...(details !== undefined ? { details } : {}) } };
}

function validationFailed<T>(issues: ApiValidationIssue[]): BoardServiceResult<T> {
  return fail(400, 'VALIDATION_FAILED', issues[0]?.message ?? 'invalid board request', { kind: 'validation', issues });
}

function conflictFailed<T>(revision: number, conflicts: BoardOpConflict[]): BoardServiceResult<T> {
  return fail(409, 'CONFLICT', 'board changed since it was read', { kind: 'board-conflict', revision, conflicts });
}

function staleBoard<T>(revision: number): BoardServiceResult<T> {
  return conflictFailed(revision, [{ opIndex: -1, id: '*', reason: 'stale-board', currentRev: revision }]);
}

function limitFailed<T>(details: BoardLimitErrorDetails): BoardServiceResult<T> {
  return fail(413, 'PAYLOAD_TOO_LARGE', `board limit ${details.limit} exceeded (${details.actual} > ${details.max})`, details);
}

function projectNotFound<T>(): BoardServiceResult<T> {
  return fail(404, 'PROJECT_NOT_FOUND', 'project not found');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Client actors keep `user|agent|cli` (+ clientId/runId); `sync`, `daemon` or a missing actor become `{kind:'user'}`. */
export function coerceBoardActor(actor: BoardActor | undefined): BoardActor {
  const kind = actor?.kind === 'agent' || actor?.kind === 'cli' || actor?.kind === 'user' ? actor.kind : 'user';
  return {
    kind,
    ...(actor?.clientId ? { clientId: actor.clientId } : {}),
    ...(actor?.runId ? { runId: actor.runId } : {}),
  };
}

function projectInfo(metadata: unknown): BoardPlannerInput['project'] {
  const record = isRecord(metadata) ? metadata : {};
  return {
    ...((PROJECT_KINDS as readonly unknown[]).includes(record.kind) ? { kind: record.kind as ProjectKind } : {}),
    ...(typeof record.intent === 'string' ? { intent: record.intent } : {}),
    ...((PROJECT_PLATFORMS as readonly unknown[]).includes(record.platform) ? { platform: record.platform as ProjectPlatform } : {}),
  };
}

function jsonEqual(a: unknown, b: unknown, ignore?: ReadonlySet<string>): boolean {
  if (a === b) return true;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((entry, index) => jsonEqual(entry, b[index]));
  }
  if (isRecord(a)) {
    if (!isRecord(b)) return false;
    const keysA = Object.keys(a).filter((key) => a[key] !== undefined && !ignore?.has(key));
    const keysB = Object.keys(b).filter((key) => b[key] !== undefined && !ignore?.has(key));
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => jsonEqual(a[key], b[key]));
  }
  return false;
}

/** Whether two contents differ only in stamps (rev / updatedAt / updatedBy). */
function sameContentModuloStamps(a: BoardContent, b: BoardContent): boolean {
  if (a.title !== b.title || !jsonEqual(a.settings, b.settings) || !jsonEqual(a.pages, b.pages)) return false;
  if (a.nodes.length !== b.nodes.length || a.edges.length !== b.edges.length) return false;
  return a.nodes.every((node, index) => jsonEqual(node, b.nodes[index], NODE_STAMP_KEYS))
    && a.edges.every((edge, index) => jsonEqual(edge, b.edges[index], EDGE_STAMP_KEYS));
}

/** The page new content goes to on a board with several pages (where the user is), else null. */
function activeBoardPage(row: BoardRow | null): string | null {
  if (!row || (row.content.pages?.length ?? 0) < 2) return null;
  return resolveBoardPageId(boardPagesOf(row.content), row.activePageId);
}

/** Agents and the CLI add to the page the user is on; the web client stamps its own page. */
function withActivePage(ops: BoardOp[], page: string | null): void {
  if (!page) return;
  for (const op of ops) {
    if (op.op === 'add' && op.node.page === undefined) op.node.page = page;
    if (op.op === 'layout' && 'all' in op.target && op.target.page === undefined) op.target.page = page;
  }
}

function filePathsOf(content: BoardContent): Set<string> {
  const paths = new Set<string>();
  for (const node of content.nodes) for (const { field, ref } of boardNodeFileRefs(node)) if (field !== 'render') paths.add(ref.path);
  return paths;
}

function maxProvidedCreatedAt(content: BoardContent, excluded: ReadonlySet<string>): number {
  let max = 0;
  for (const node of content.nodes) if (!excluded.has(node.id) && node.createdAt > max) max = node.createdAt;
  for (const edge of content.edges) if (!excluded.has(edge.id) && edge.createdAt > max) max = edge.createdAt;
  return max;
}

function validTimestamp(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function parseCoverDimension(value: unknown): number | null {
  const text = Array.isArray(value) ? value[0] : value;
  if (typeof text !== 'string' || !/^\d{1,5}$/.test(text)) return null;
  const parsed = Number(text);
  return parsed >= 1 && parsed <= BOARD_LIMITS.maxCoverDimension ? parsed : null;
}

type RefExpectation = 'frame' | 'image' | 'video' | 'audio' | 'design' | 'composition' | 'render';
type RefFailure = 'not-found' | 'outside-project' | 'not-placeable';
type MissingFilePolicy = 'error' | 'mark-missing' | 'accept-when-missing';

interface RefSlot {
  ref: BoardFileRef;
  expectation: RefExpectation;
  primary: boolean;
  clear(): void;
}

/** File refs a node record, draft, snapshot or patch carries (mutable views into the cloned request). */
function refSlots(record: Record<string, unknown>, kind: BoardNodeKind): RefSlot[] {
  const slots: RefSlot[] = [];
  const asRef = (value: unknown): BoardFileRef | null =>
    isRecord(value) && typeof value.path === 'string' ? (value as unknown as BoardFileRef) : null;
  if (kind === 'frame' || kind === 'image' || kind === 'video' || kind === 'audio' || kind === 'design') {
    const ref = asRef(record.ref);
    if (ref) slots.push({ ref, expectation: kind, primary: true, clear: () => undefined });
  }
  if (kind === 'motion') {
    const source = record.source;
    if (isRecord(source) && source.type === 'composition') {
      const ref = asRef(source.ref);
      if (ref) slots.push({ ref, expectation: 'composition', primary: true, clear: () => undefined });
    }
    const render = asRef(record.render);
    if (render) slots.push({ ref: render, expectation: 'render', primary: false, clear: () => { delete record.render; } });
  }
  return slots;
}

// ---- service ------------------------------------------------------------------------------------------

class DaemonBoardService implements BoardService {
  private readonly db: SqliteDb;
  private readonly now: () => number;
  private readonly newId: (prefix: 'n' | 'e') => string;
  private readonly warn: (message: string, detail?: unknown) => void;

  constructor(private readonly deps: BoardServiceDeps) {
    this.db = deps.db;
    this.now = deps.now ?? (() => Date.now());
    this.newId = deps.newId ?? ((prefix) => `${prefix}_${randomBytes(10).toString('hex')}`);
    this.warn = deps.warn ?? ((message, detail) => console.warn(`[fantay-board] ${message}`, detail ?? ''));
  }

  private project(projectId: string): BoardProjectRecord | null {
    const project = this.deps.getProject(this.db, projectId);
    return project && typeof project.id === 'string' ? project : null;
  }

  private emit(projectId: string, revision: number, reason: BoardChangeReason, actor: BoardActor, now: number): void {
    try {
      this.deps.emitProjectEvent(projectId, boardChangedPayload(projectId, revision, reason, actor, now));
    } catch (error) {
      this.warn('board-changed emit failed', error);
    }
  }

  // ---- reads ----------------------------------------------------------------------------------------

  get(projectId: string, opts: { includeSync?: boolean } = {}): BoardGetResponse {
    return { board: readBoardDocument(this.db, projectId, opts) };
  }

  // ---- ref checks (spec 04 §4.4.1 step 3) -------------------------------------------------------------

  private async resolveRef(
    project: BoardProjectRecord,
    path: string,
    expectation: RefExpectation,
  ): Promise<{ ok: true; name: string; mtime: number } | { ok: false; reason: RefFailure }> {
    let file: { name: string; mtime: number };
    try {
      file = await this.deps.projectFiles.resolveProjectFilePath(this.deps.paths.PROJECTS_DIR, project.id, path, project.metadata);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException | undefined)?.code;
      return { ok: false, reason: code === 'ENOENT' || code === 'ENOTDIR' ? 'not-found' : 'outside-project' };
    }
    const name = typeof file?.name === 'string' ? file.name : path;
    const kind = boardKindForPath(name);
    const fits = expectation === 'composition'
      ? boardCompositionDir(name) !== null
      : expectation === 'render'
        ? kind === 'video'
        : kind === expectation;
    if (!fits) return { ok: false, reason: 'not-placeable' };
    return { ok: true, name, mtime: Number(file.mtime) || 0 };
  }

  /** Checks (and canonicalizes in place) the file refs of one record. Returns an error result or null. */
  private async checkRecordRefs(
    project: BoardProjectRecord,
    record: Record<string, unknown>,
    kind: BoardNodeKind,
    opIndex: number,
    mtimes: Map<string, number>,
    onMissing: MissingFilePolicy,
    now: number,
  ): Promise<BoardServiceError | null> {
    if (kind === 'motion' && isRecord(record.source) && record.source.type === 'movie') {
      const sourceProjectId = record.source.projectId;
      if (typeof sourceProjectId === 'string' && sourceProjectId !== project.id && !this.project(sourceProjectId)) {
        return { status: 404, code: 'PROJECT_NOT_FOUND', message: `movie source project ${sourceProjectId} not found` };
      }
    }
    for (const slot of refSlots(record, kind)) {
      const resolved = await this.resolveRef(project, slot.ref.path, slot.expectation);
      if (resolved.ok) {
        slot.ref.path = resolved.name;
        mtimes.set(resolved.name, resolved.mtime);
        continue;
      }
      if (resolved.reason === 'not-found' && onMissing !== 'error') {
        if (!slot.primary) {
          slot.clear();
          continue;
        }
        if (onMissing === 'mark-missing') {
          record.missing = { since: now };
          continue;
        }
        if (onMissing === 'accept-when-missing' && isRecord(record.missing)) continue;
      }
      const details: BoardRefErrorDetails = { kind: 'board-ref', opIndex, path: slot.ref.path, reason: resolved.reason };
      return resolved.reason === 'not-found'
        ? { status: 404, code: 'FILE_NOT_FOUND', message: `${slot.ref.path} is not a project file`, details }
        : { status: 400, code: 'VALIDATION_FAILED', message: `${slot.ref.path} cannot be placed on the board (${resolved.reason})`, details };
    }
    return null;
  }

  /** PATCH step 3 over add / update / restore ops (update targets resolve their kind from the stored board). */
  private async checkOpRefs(
    project: BoardProjectRecord,
    ops: BoardOp[],
    current: BoardContent,
    mtimes: Map<string, number>,
    now: number,
  ): Promise<BoardServiceError | null> {
    const kinds = new Map<string, BoardNodeKind>(current.nodes.map((node) => [node.id, node.kind]));
    for (let index = 0; index < ops.length; index += 1) {
      const op = ops[index]!;
      let error: BoardServiceError | null = null;
      if (op.op === 'add') {
        const draft = op.node as unknown as Record<string, unknown> & { kind: BoardNodeKind };
        if (typeof draft.id === 'string') kinds.set(draft.id, draft.kind);
        error = await this.checkRecordRefs(project, draft, draft.kind, index, mtimes, 'error', now);
      } else if (op.op === 'update') {
        const kind = kinds.get(op.id);
        if (kind) error = await this.checkRecordRefs(project, op.patch as unknown as Record<string, unknown>, kind, index, mtimes, 'error', now);
      } else if (op.op === 'restore') {
        for (const snapshot of op.nodes) {
          kinds.set(snapshot.id, snapshot.kind);
          error = await this.checkRecordRefs(project, snapshot as unknown as Record<string, unknown>, snapshot.kind, index, mtimes, 'mark-missing', now);
          if (error) break;
        }
      }
      if (error) return error;
    }
    return null;
  }

  // ---- identities ---------------------------------------------------------------------------------------

  /** Live workspace identity for a path; created only for files verified in this request (`mtimes`). */
  private identityFor(projectId: string, path: string, mtimes: ReadonlyMap<string, number | undefined>, now: number): string | undefined {
    try {
      const live = getLiveWorkspaceArtifactByPath(this.db, projectId, path);
      if (live) return live.id;
      if (!mtimes.has(path)) return undefined;
      const mtime = mtimes.get(path);
      return ensureWorkspaceArtifactForPath(this.db, {
        projectId,
        path,
        kind: kindForArtifactPath(path),
        mime: mimeForArtifactPath(path) ?? null,
        mtime: mtime ?? null,
        now,
      }).id;
    } catch (error) {
      // Comment-pending identities throw by design; the ref stays path-only.
      this.warn(`workspace identity for ${path} unavailable`, error instanceof Error ? error.message : error);
      return undefined;
    }
  }

  private withIdentities(projectId: string, node: BoardNode, mtimes: ReadonlyMap<string, number | undefined>, now: number): BoardNode {
    const fill = (ref: BoardFileRef): BoardFileRef => {
      if (ref.workspaceArtifactId) return ref;
      const id = this.identityFor(projectId, ref.path, mtimes, now);
      return id ? { ...ref, workspaceArtifactId: id } : ref;
    };
    switch (node.kind) {
      case 'frame':
      case 'image':
      case 'video':
      case 'audio': {
        if (!node.ref) return node;
        const ref = fill(node.ref);
        return ref === node.ref ? node : ({ ...node, ref } as BoardNode);
      }
      case 'design': {
        const ref = fill(node.ref);
        return ref === node.ref ? node : { ...node, ref };
      }
      case 'motion': {
        let next = node;
        if (node.source.type === 'composition') {
          const ref = fill(node.source.ref);
          if (ref !== node.source.ref) next = { ...next, source: { type: 'composition', ref } };
        }
        if (node.render) {
          const render = fill(node.render);
          if (render !== node.render) next = { ...next, render };
        }
        return next;
      }
      default:
        return node;
    }
  }

  /** Fills missing `workspaceArtifactId`s on the nodes in `ids` (content and change set stay consistent). */
  private fillIdentities(
    projectId: string,
    content: BoardContent,
    changes: BoardChangeSet | null,
    ids: ReadonlySet<string> | null,
    mtimes: ReadonlyMap<string, number | undefined>,
    now: number,
  ): { content: BoardContent; changes: BoardChangeSet | null } {
    const replaced = new Map<string, BoardNode>();
    for (const node of content.nodes) {
      if (ids && !ids.has(node.id)) continue;
      const updated = this.withIdentities(projectId, node, mtimes, now);
      if (updated !== node) replaced.set(node.id, updated);
    }
    if (replaced.size === 0) return { content, changes };
    return {
      content: { ...content, nodes: content.nodes.map((node) => replaced.get(node.id) ?? node) },
      changes: changes ? { ...changes, upsertNodes: changes.upsertNodes.map((node) => replaced.get(node.id) ?? node) } : null,
    };
  }

  // ---- op commits (PATCH, applyOps) -----------------------------------------------------------------------

  private commitOps(input: {
    projectId: string;
    ops: readonly BoardOp[] | ((content: BoardContent, revision: number) => readonly BoardOp[]);
    baseRevision?: number;
    actor: BoardActor;
    now: number;
    checkConflicts: boolean;
    mtimes: Map<string, number>;
  }): { result: BoardServiceResult<BoardPatchResponse>; committed: boolean } {
    const run = this.db.transaction(() => {
      const row = readBoardRow(this.db, input.projectId);
      const revision = row?.revision ?? 0;
      const content = row?.content ?? emptyBoardContent();
      const ledger = row?.ledger ?? emptyBoardSyncLedger();
      const ops = typeof input.ops === 'function' ? input.ops(content, revision) : input.ops;
      if (ops.length === 0) {
        return { result: ok(this.noopPatch(row, revision, [])), committed: false };
      }
      const outcome = applyBoardOps(content, ops, {
        baseRevision: input.baseRevision ?? revision,
        nextRevision: revision + 1,
        actor: input.actor,
        now: input.now,
        newId: this.newId,
        checkConflicts: input.checkConflicts,
      });
      if (!outcome.ok) {
        if (outcome.reason === 'conflict') return { result: conflictFailed<BoardPatchResponse>(revision, outcome.conflicts), committed: false };
        if (outcome.reason === 'limit') return { result: limitFailed<BoardPatchResponse>(outcome.details), committed: false };
        return { result: validationFailed<BoardPatchResponse>(outcome.issues), committed: false };
      }
      if (outcome.inverse.length === 0) {
        return { result: ok(this.noopPatch(row, revision, outcome.results)), committed: false };
      }
      const changedIds = new Set(outcome.changes.upsertNodes.map((node) => node.id));
      const filled = this.fillIdentities(input.projectId, outcome.content, outcome.changes, changedIds, input.mtimes, input.now);
      const stamped = stampMonotonicCreatedAt({
        content: filled.content,
        changes: filled.changes,
        createdIds: createdIdsInOpOrder(ops, outcome.results, content, filled.content),
        watermark: boardCreatedAtWatermark(row),
        clock: input.now,
      });
      const nextRevision = commitBoard(this.db, {
        projectId: input.projectId,
        expectedRevision: revision,
        content: stamped.content,
        ledger: recordBoardDismissals(ledger, outcome.removedPaths, input.now),
        now: input.now,
        actor: input.actor,
        lastCreatedAt: stamped.lastCreatedAt ?? boardCreatedAtWatermark(row),
      });
      return {
        result: ok<BoardPatchResponse>({
          revision: nextRevision,
          updatedAt: input.now,
          results: outcome.results,
          changes: stamped.changes ?? outcome.changes,
          inverse: outcome.inverse,
        }),
        committed: true,
      };
    });
    try {
      return run();
    } catch (error) {
      if (error instanceof BoardRevisionMismatchError) return { result: staleBoard(error.actual), committed: false };
      throw error;
    }
  }

  private noopPatch(row: BoardRow | null, revision: number, results: BoardPatchResponse['results']): BoardPatchResponse {
    return {
      revision,
      updatedAt: row?.updatedAt ?? 0,
      results,
      changes: { fromRevision: revision, toRevision: revision, upsertNodes: [], removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] },
      inverse: [],
    };
  }

  async patch(projectId: string, body: unknown): Promise<BoardServiceResult<BoardPatchResponse>> {
    const project = this.project(projectId);
    if (!project) return projectNotFound();
    const parsed = validateBoardPatchRequest(body);
    if (!parsed.ok) return validationFailed(parsed.issues);
    const actor = coerceBoardActor(parsed.value.actor);
    const ops = structuredClone(parsed.value.ops) as BoardOp[];
    const now = this.now();
    const mtimes = new Map<string, number>();
    const stored = readBoardRow(this.db, projectId);
    const current = stored?.content ?? emptyBoardContent();
    withActivePage(ops, activeBoardPage(stored));
    const refError = await this.checkOpRefs(project, ops, current, mtimes, now);
    if (refError) return { ok: false, error: refError };
    const { result, committed } = this.commitOps({
      projectId,
      ops,
      baseRevision: parsed.value.baseRevision,
      actor,
      now,
      checkConflicts: true,
      mtimes,
    });
    if (committed && result.ok) this.emit(projectId, result.value.revision, 'patch', actor, now);
    return result;
  }

  async applyOps(input: BoardServerApplyInput): Promise<BoardServiceResult<BoardPatchResponse>> {
    const project = this.project(input.projectId);
    if (!project) return projectNotFound();
    const actor: BoardActor = input.actor ?? { kind: 'daemon' };
    const now = this.now();
    const mtimes = new Map<string, number>();
    let ops = input.ops;
    if (typeof ops !== 'function') {
      const cloned = structuredClone([...ops]) as BoardOp[];
      const current = readBoardRow(this.db, input.projectId)?.content ?? emptyBoardContent();
      const refError = await this.checkOpRefs(project, cloned, current, mtimes, now);
      if (refError) return { ok: false, error: refError };
      ops = cloned;
    }
    const { result, committed } = this.commitOps({ projectId: input.projectId, ops, actor, now, checkConflicts: false, mtimes });
    if (committed && result.ok) this.emit(input.projectId, result.value.revision, input.reason, actor, now);
    return result;
  }

  // ---- PUT (strict whole-document CAS) -------------------------------------------------------------------

  async put(projectId: string, body: unknown): Promise<BoardServiceResult<BoardGetResponse>> {
    const project = this.project(projectId);
    if (!project) return projectNotFound();
    const parsed = validateBoardPutRequest(body);
    if (!parsed.ok) return validationFailed(parsed.issues);
    const actor = coerceBoardActor(parsed.value.actor);
    const now = this.now();
    const normalized = normalizeBoardContent(parsed.value.board, { now, actor, revision: 0 });
    if (!normalized.ok) return validationFailed(normalized.issues);
    const content = normalized.value;
    // B13: entities the request sent without a valid createdAt are "created" by this PUT.
    const rawNodes = parsed.value.board.nodes;
    const rawEdges = parsed.value.board.edges;
    const createdIds: string[] = [];
    content.nodes.forEach((node, index) => {
      const raw = rawNodes[index];
      if (!isRecord(raw) || !validTimestamp(raw.createdAt)) createdIds.push(node.id);
    });
    for (const raw of rawEdges) {
      if (isRecord(raw) && typeof raw.id === 'string' && !validTimestamp(raw.createdAt)) createdIds.push(raw.id);
    }
    const mtimes = new Map<string, number>();
    for (let index = 0; index < content.nodes.length; index += 1) {
      const node = content.nodes[index]!;
      const error = await this.checkRecordRefs(project, node as unknown as Record<string, unknown>, node.kind, index, mtimes, 'accept-when-missing', now);
      if (error) return { ok: false, error };
    }
    const limit = checkBoardContentLimits(content);
    if (limit) return limitFailed(limit);
    const issues = validateBoardContent(content);
    if (issues.length > 0) return validationFailed(issues);

    const run = this.db.transaction((): { result: BoardServiceResult<BoardGetResponse>; revision: number | null } => {
      const row = readBoardRow(this.db, projectId);
      const revision = row?.revision ?? 0;
      if (parsed.value.baseRevision !== revision) return { result: staleBoard(revision), revision: null };
      const current = row?.content ?? emptyBoardContent();
      if (sameContentModuloStamps(current, content)) {
        return { result: ok({ board: row ? boardDocumentFromRow(row) : readBoardDocument(this.db, projectId) }), revision: null };
      }
      const nextRevision = revision + 1;
      const restamped: BoardContent = {
        ...content,
        nodes: content.nodes.map((node) => ({ ...node, rev: nextRevision }) as BoardNode),
        edges: content.edges.map((edge): BoardEdge => ({ ...edge, rev: nextRevision })),
      };
      const filled = this.fillIdentities(projectId, restamped, null, null, mtimes, now);
      const created = new Set(createdIds);
      const stamped = stampMonotonicCreatedAt({
        content: filled.content,
        createdIds,
        watermark: Math.max(boardCreatedAtWatermark(row), maxProvidedCreatedAt(filled.content, created)),
        clock: now,
      });
      const nextPaths = filePathsOf(stamped.content);
      const removedPaths = [...filePathsOf(current)].filter((path) => !nextPaths.has(path));
      const committedRevision = commitBoard(this.db, {
        projectId,
        expectedRevision: revision,
        content: stamped.content,
        ledger: recordBoardDismissals(row?.ledger ?? emptyBoardSyncLedger(), removedPaths, now),
        now,
        actor,
        lastCreatedAt: stamped.lastCreatedAt ?? boardCreatedAtWatermark(row),
      });
      return { result: ok({ board: readBoardDocument(this.db, projectId) }), revision: committedRevision };
    });
    let outcome: { result: BoardServiceResult<BoardGetResponse>; revision: number | null };
    try {
      outcome = run();
    } catch (error) {
      if (error instanceof BoardRevisionMismatchError) return staleBoard(error.actual);
      throw error;
    }
    if (outcome.revision !== null) this.emit(projectId, outcome.revision, 'put', actor, now);
    return outcome.result;
  }

  // ---- sync (spec 04 §4.5) --------------------------------------------------------------------------------

  async sync(projectId: string, body: unknown): Promise<BoardServiceResult<BoardSyncResponse>> {
    const project = this.project(projectId);
    if (!project) return projectNotFound();
    const parsed = validateBoardSyncRequest(body);
    if (!parsed.ok) return validationFailed(parsed.issues);
    const request = parsed.value;
    const requester = request.actor ? coerceBoardActor(request.actor) : null;
    const now = this.now();
    const before = readBoardRow(this.db, projectId);
    const gathered = await gatherBoardSyncInputs(
      {
        db: this.db,
        projectsRoot: this.deps.paths.PROJECTS_DIR,
        resolveProjectFilePath: this.deps.projectFiles.resolveProjectFilePath,
        listFiles: this.deps.projectFiles.listFiles,
        getProject: this.deps.getProject,
      },
      {
        projectId,
        metadata: project.metadata,
        request,
        content: before?.content ?? emptyBoardContent(),
        ledger: before?.ledger ?? emptyBoardSyncLedger(),
        now,
      },
    );
    const run = this.db.transaction((): { result: BoardServiceResult<BoardSyncResponse>; revision: number | null } => {
      const row = readBoardRow(this.db, projectId);
      const revision = row?.revision ?? 0;
      const content = row?.content ?? emptyBoardContent();
      const ledger: BoardSyncLedger = row?.ledger ?? emptyBoardSyncLedger();
      const identities = new Map<string, string>();
      for (const path of gathered.candidatePaths.keys()) {
        const id = this.identityFor(projectId, path, gathered.candidatePaths, now);
        if (id) identities.set(path, id);
      }
      const plan = planBoardSync({
        projectId,
        now,
        content,
        ledger,
        pageId: activeBoardPage(row),
        project: projectInfo(project.metadata),
        seedFiles: gathered.seedFiles,
        turns: gathered.turns,
        mediaTasks: gathered.mediaTasks,
        refStatuses: gathered.refStatuses,
        identities,
        snapshotCovers: gathered.snapshotCovers,
        focus: request.focus
          ? {
              names: request.focus.names,
              primary: request.focus.primary ?? null,
              turnMessageId: request.turn?.messageId ?? null,
              near: request.focus.near ?? null,
            }
          : null,
        focusTargets: gathered.focusTargets,
      });
      if (plan.rejected.length > 0) this.warn('board sync planner steps were refused', plan.rejected);
      const tail = { placements: plan.placements, focus: plan.focus, unplaceable: plan.unplaceable };
      const unchanged = (): { result: BoardServiceResult<BoardSyncResponse>; revision: number | null } => {
        writeBoardLedger(this.db, projectId, plan.ledger);
        return { result: ok({ revision, changed: false, changes: null, ...tail }), revision: null };
      };
      if (plan.ops.length === 0) return unchanged();
      // A plan can exceed the per-batch op cap (first sync over a long history): applied in slices, one commit.
      const outcome = applyBoardOpsInSlices(content, plan.ops, {
        baseRevision: revision,
        nextRevision: revision + 1,
        actor: SYNC_ACTOR,
        now,
        newId: this.newId,
        checkConflicts: false,
      });
      if (!outcome.ok) {
        this.warn('board sync plan could not be applied', outcome);
        return { result: fail(500, 'INTERNAL_ERROR', 'board sync could not be applied', { reason: outcome.reason }), revision: null };
      }
      if (!outcome.changes) return unchanged();
      const stamped = stampMonotonicCreatedAt({
        content: outcome.content,
        changes: outcome.changes,
        createdIds: createdIdsInOpOrder(plan.ops, outcome.results, content, outcome.content),
        watermark: boardCreatedAtWatermark(row),
        clock: now,
      });
      const nextRevision = commitBoard(this.db, {
        projectId,
        expectedRevision: revision,
        content: stamped.content,
        ledger: recordBoardDismissals(plan.ledger, outcome.removedPaths, now),
        now,
        actor: SYNC_ACTOR,
        lastCreatedAt: stamped.lastCreatedAt ?? boardCreatedAtWatermark(row),
      });
      return {
        result: ok({ revision: nextRevision, changed: true, changes: stamped.changes ?? outcome.changes, ...tail }),
        revision: nextRevision,
      };
    });
    let outcome: { result: BoardServiceResult<BoardSyncResponse>; revision: number | null };
    try {
      outcome = run();
    } catch (error) {
      if (error instanceof BoardRevisionMismatchError) return staleBoard(error.actual);
      throw error;
    }
    if (outcome.revision !== null) {
      this.emit(projectId, outcome.revision, 'sync', { kind: 'sync', ...(requester?.clientId ? { clientId: requester.clientId } : {}) }, now);
    }
    return outcome.result;
  }

  // ---- viewport ---------------------------------------------------------------------------------------------

  setViewport(projectId: string, body: unknown): BoardServiceResult<{ ok: true }> {
    if (!this.project(projectId)) return projectNotFound();
    const parsed = validateBoardViewport(body);
    if (!parsed.ok) return validationFailed(parsed.issues);
    writeBoardViewport(this.db, projectId, parsed.value, this.now(), boardViewportPageId(body));
    return ok({ ok: true as const });
  }

  // ---- covers -----------------------------------------------------------------------------------------------

  async saveCover(projectId: string, input: BoardCoverUploadInput): Promise<BoardServiceResult<BoardCoverUploadResponse>> {
    if (!this.project(projectId)) return projectNotFound();
    const width = parseCoverDimension(input.width);
    const height = parseCoverDimension(input.height);
    const issues: ApiValidationIssue[] = [];
    if (width === null) issues.push({ path: 'width', code: 'out-of-range', message: `width must be an integer in 1..${BOARD_LIMITS.maxCoverDimension}` });
    if (height === null) issues.push({ path: 'height', code: 'out-of-range', message: `height must be an integer in 1..${BOARD_LIMITS.maxCoverDimension}` });
    let sourceMtime: number | undefined;
    const rawMtime = Array.isArray(input.sourceMtime) ? input.sourceMtime[0] : input.sourceMtime;
    if (rawMtime !== undefined && rawMtime !== '') {
      const parsedMtime = typeof rawMtime === 'string' ? Number(rawMtime) : NaN;
      if (!Number.isFinite(parsedMtime) || parsedMtime < 0) {
        issues.push({ path: 'sourceMtime', code: 'invalid-value', message: 'sourceMtime must be a non-negative number' });
      } else {
        sourceMtime = parsedMtime;
      }
    }
    if (issues.length > 0 || width === null || height === null) return validationFailed(issues);
    const declared = normalizeBoardCoverContentType(input.contentType);
    if (!declared) {
      return fail(415, 'UNSUPPORTED_MEDIA_TYPE', 'covers must be image/webp, image/png or image/jpeg');
    }
    if (!Buffer.isBuffer(input.body) || input.body.length === 0) {
      return fail(400, 'BAD_REQUEST', 'cover image body is empty');
    }
    if (input.body.length > BOARD_LIMITS.maxCoverBytes) {
      return limitFailed({ kind: 'board-limit', limit: 'maxCoverBytes', max: BOARD_LIMITS.maxCoverBytes, actual: input.body.length });
    }
    const sniffed = sniffBoardCoverMime(input.body);
    if (sniffed !== declared) {
      return fail(415, 'UNSUPPORTED_MEDIA_TYPE', `cover bytes are ${sniffed ?? 'not an image'}, declared ${declared}`);
    }
    const { digest } = await writeBoardCover(this.deps.paths.RUNTIME_DATA_DIR, projectId, input.body, declared);
    const now = this.now();
    try {
      const referenced = new Set<string>();
      for (const node of readBoardRow(this.db, projectId)?.content.nodes ?? []) {
        const cover = 'cover' in node ? node.cover : undefined;
        if (cover?.source === 'board-cover') referenced.add(cover.digest);
      }
      referenced.add(digest);
      await gcBoardCovers(this.deps.paths.RUNTIME_DATA_DIR, projectId, referenced, { now });
    } catch (error) {
      this.warn('board cover collection failed', error instanceof Error ? error.message : error);
    }
    return ok<BoardCoverUploadResponse>({
      cover: {
        source: 'board-cover',
        digest,
        mime: declared,
        width,
        height,
        capturedAt: now,
        ...(sourceMtime !== undefined ? { sourceMtime } : {}),
      },
      url: boardCoverApiPath(projectId, digest),
    });
  }

  readCover(projectId: string, digest: string): Promise<{ bytes: Buffer; mime: BoardCoverMime } | null> {
    return readBoardCover(this.deps.paths.RUNTIME_DATA_DIR, projectId, digest);
  }

  collectOrphanCoverDirs(): Promise<string[]> {
    return gcOrphanBoardCoverDirs(this.deps.paths.RUNTIME_DATA_DIR, (id) => this.project(id) !== null);
  }
}

export function createBoardService(deps: BoardServiceDeps): BoardService {
  return new DaemonBoardService(deps);
}
