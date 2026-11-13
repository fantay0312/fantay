// SPDX-License-Identifier: Apache-2.0
// Chat-sync planner (spec 04 §4.5.3): a pure function from the stored board plus gathered turn, media-task, file
// and identity facts to contract ops. It reads no clock and generates no random ids (every created entity has a
// `stableBoardId`), so the same input always yields the same plan, and running it again on its own result yields no
// ops. Rules P1–P6 run in order on a working copy, which is advanced with `applyBoardOps` after each step so every
// placement sees the earlier ones. The service applies the returned ops once more, atomically, on the same content.
import {
  BOARD_GROUP_MIN_SIZE,
  BOARD_LAYOUT,
  BOARD_LIMITS,
  MEDIA_FAILURE_NEXT_STEPS,
  applyBoardOps,
  boardCompositionDir,
  boardKindForPath,
  boardNodesBounds,
  boardVariantBasePath,
  defaultBoardNodeSize,
  deviceForFramePath,
  isBoardMovieDocumentPath,
  isBoardMovieRenderPath,
  layoutRow,
  parseBoardVariantPath,
  placeBoardItems,
  boardNodesOnPage,
  boardPagesOf,
  resolveBoardPageId,
  refitGroupRect,
  sortBoardLayoutItems,
  stableBoardId,
  topLevelAncestorId,
  type BoardActor,
  type BoardApplyContext,
  type BoardApplyOutcome,
  type BoardChangeSet,
  type BoardContent,
  type BoardCoverRef,
  type BoardFileRef,
  type BoardNode,
  type BoardNodeDraft,
  type BoardNodeOrigin,
  type BoardNodePatch,
  type BoardOp,
  type BoardOpResult,
  type BoardPendingMedia,
  type BoardPlaceableKind,
  type BoardPlacement,
  type BoardSectionKind,
  type BoardSyncLedger,
  type BoardSyncPlacement,
  type BoardTurnLedgerEntry,
  type BoardVariantPath,
  type MediaFailureNextStep,
  type MediaSurface,
  type MediaTaskStatus,
  type ProjectKind,
  type ProjectPlatform,
} from '@open-design/contracts';

// ---- constants -------------------------------------------------------------------------------

/** Turns are re-read from `cursor - BOARD_SYNC_LOOKBACK_MS` (late `producedFiles` writes, running turns). */
export const BOARD_SYNC_LOOKBACK_MS = 600_000;
export const BOARD_SEED_LIMIT = 48;
export const BOARD_TURN_OUTPUT_LIMIT = 12;
export const BOARD_TURN_EXCERPT_LENGTH = 60;
export const BOARD_LEDGER_LIMITS = { turns: 200, mediaTasks: 300, dismissed: 500 } as const;
const SEED_KIND_ORDER: readonly BoardSectionKind[] = ['frame', 'design', 'motion', 'image', 'video', 'audio'];
const PRIMARY_OUTPUT_KINDS: ReadonlySet<BoardPlaceableKind> = new Set(['frame', 'design', 'motion']);
const MEDIA_SURFACE_KINDS: ReadonlySet<string> = new Set(['image', 'video', 'audio']);
const SYNC_ACTOR: BoardActor = { kind: 'sync' };
const PENDING_PROGRESS_LIMIT = 200;
const PENDING_ERROR_LIMIT = 4000;

// ---- daemon-internal planner types (spec 04 §4.5.3, extended where noted) ----------------------

/** Which file reference of a node a status describes (`render` and `source` are motion fields). */
export type BoardRefField = 'ref' | 'source' | 'render';

export interface BoardRefStatus {
  nodeId: string;
  /** Extension of the spec type: a motion node can have a composition `source` and a `render` at once. */
  field: BoardRefField;
  status: 'present' | 'renamed' | 'deleted' | 'missing';
  path?: string;
  workspaceArtifactId?: string;
  mtime?: number;
}

export function boardRefStatusKey(nodeId: string, field: BoardRefField): string {
  return `${nodeId}:${field}`;
}

export interface BoardPlannerTurn {
  messageId: string;
  conversationId: string;
  runId?: string;
  createdAt: number;
  terminal: boolean;
  prompt?: string;
  outputs: Array<{ path: string; mtime?: number }>;
}

export interface BoardPlannerMediaTask {
  taskId: string;
  runId: string;
  messageId?: string;
  conversationId?: string;
  surface: MediaSurface;
  status: MediaTaskStatus;
  batchId: string;
  batchIndex: number;
  batchSize: number;
  sequence: number;
  filePath?: string;
  progress?: string;
  error?: { message: string; nextStep?: MediaFailureNextStep };
}

/** Resolution of one focus name by the gatherer (extension of the spec type). */
export type BoardFocusTarget =
  | { kind: 'live'; liveArtifactId: string }
  | { kind: 'file'; path: string; mtime?: number };

export interface BoardPlannerInput {
  projectId: string;
  now: number;
  content: BoardContent;
  ledger: BoardSyncLedger;
  /** Page new outputs land on (the one the user is on); null on a board with one page. */
  pageId?: string | null;
  project: { kind?: ProjectKind; intent?: string; platform?: ProjectPlatform };
  seedFiles: Array<{ path: string; mtime: number }> | null;
  turns: BoardPlannerTurn[];
  mediaTasks: BoardPlannerMediaTask[];
  /** Keyed by `boardRefStatusKey(nodeId, field)`. */
  refStatuses: Map<string, BoardRefStatus>;
  /** path → workspaceArtifactId */
  identities: Map<string, string>;
  /** path → snapshot cover */
  snapshotCovers: Map<string, { snapshotId: string; sourceMtime?: number }>;
  focus: { names: string[]; primary: string | null; turnMessageId: string | null; near: { x: number; y: number } | null } | null;
  /** Focus name → resolved target; a name that is absent or null is unplaceable. */
  focusTargets?: Map<string, BoardFocusTarget | null>;
}

export interface BoardPlanRejection {
  step: string;
  reason: 'conflict' | 'invalid' | 'limit' | 'error';
  detail: unknown;
}

export interface BoardSyncPlan {
  ops: BoardOp[];
  ledger: BoardSyncLedger;
  placements: BoardSyncPlacement[];
  focus: { nodeIds: string[]; primaryNodeId: string | null } | null;
  unplaceable: string[];
  /** Planner steps whose ops the op engine refused (always empty unless the planner has a bug). */
  rejected: BoardPlanRejection[];
}

// ---- pure helpers shared with the gatherer and the service --------------------------------------

/** File references held by a node, by field. */
export function boardNodeFileRefs(node: BoardNode): Array<{ field: BoardRefField; ref: BoardFileRef }> {
  switch (node.kind) {
    case 'frame':
    case 'image':
    case 'video':
    case 'audio':
      return node.ref ? [{ field: 'ref', ref: node.ref }] : [];
    case 'design':
      return [{ field: 'ref', ref: node.ref }];
    case 'motion': {
      const refs: Array<{ field: BoardRefField; ref: BoardFileRef }> = [];
      if (node.source.type === 'composition') refs.push({ field: 'source', ref: node.source.ref });
      if (node.render) refs.push({ field: 'render', ref: node.render });
      return refs;
    }
    default:
      return [];
  }
}

/**
 * Turn-group title from the preceding user message: its first line that does not start with `<`, with the
 * markdown markers `#`, `*`, `>` and backticks stripped and whitespace collapsed, at most 60 characters plus `…`.
 */
export function excerptBoardTurnPrompt(content: unknown): string | undefined {
  if (typeof content !== 'string') return undefined;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('<')) continue;
    const cleaned = line.replace(/[#*>`]/g, '').replace(/\s+/g, ' ').trim();
    if (!cleaned) continue;
    const chars = Array.from(cleaned);
    return chars.length > BOARD_TURN_EXCERPT_LENGTH ? `${chars.slice(0, BOARD_TURN_EXCERPT_LENGTH).join('')}…` : cleaned;
  }
  return undefined;
}

function isSvgPath(path: string): boolean {
  return path.toLowerCase().endsWith('.svg');
}

function pathDepth(path: string): number {
  return path.split('/').length - 1;
}

function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isSeedLocation(path: string): boolean {
  return !path.includes('/')
    || path.startsWith('designs/')
    || isBoardMovieDocumentPath(path)
    || boardCompositionDir(path) !== null;
}

/**
 * P2 seed candidates: placeable files (no `.svg`, not dismissed) at the project root, under `designs/`, the
 * `movie-studio.json` and `motion-source/<id>/index.html` entries; newest first (ties by path), at most 48.
 */
export function boardSeedCandidates(
  files: ReadonlyArray<{ path: string; mtime: number }>,
  dismissed: Readonly<Record<string, number>>,
): Array<{ path: string; mtime: number; kind: BoardPlaceableKind }> {
  const seen = new Set<string>();
  const out: Array<{ path: string; mtime: number; kind: BoardPlaceableKind }> = [];
  for (const file of files) {
    const path = file.path;
    if (seen.has(path)) continue;
    const kind = boardKindForPath(path);
    if (!kind || isSvgPath(path) || dismissed[path] !== undefined || !isSeedLocation(path)) continue;
    seen.add(path);
    out.push({ path, mtime: Number.isFinite(file.mtime) ? file.mtime : 0, kind });
  }
  out.sort((a, b) => b.mtime - a.mtime || comparePaths(a.path, b.path));
  return out.slice(0, BOARD_SEED_LIMIT);
}

function cloneLedger(ledger: BoardSyncLedger): BoardSyncLedger {
  const turns: Record<string, BoardTurnLedgerEntry> = {};
  for (const [id, entry] of Object.entries(ledger.turns)) turns[id] = { ...entry, placed: { ...entry.placed } };
  return {
    version: 1,
    seededAt: ledger.seededAt,
    cursor: ledger.cursor,
    turns,
    mediaTasks: { ...ledger.mediaTasks },
    dismissed: { ...ledger.dismissed },
  };
}

/** P6: turns ≤ 200 (oldest `updatedAt` dropped), mediaTasks ≤ 300 (oldest entries), dismissed ≤ 500 (oldest). */
export function trimBoardSyncLedger(ledger: BoardSyncLedger): BoardSyncLedger {
  let { turns, mediaTasks, dismissed } = ledger;
  const turnIds = Object.keys(turns);
  if (turnIds.length > BOARD_LEDGER_LIMITS.turns) {
    const keep = new Set(
      [...turnIds]
        .sort((a, b) => turns[b]!.updatedAt - turns[a]!.updatedAt || comparePaths(a, b))
        .slice(0, BOARD_LEDGER_LIMITS.turns),
    );
    turns = Object.fromEntries(turnIds.filter((id) => keep.has(id)).map((id) => [id, turns[id]!]));
  }
  const taskIds = Object.keys(mediaTasks);
  if (taskIds.length > BOARD_LEDGER_LIMITS.mediaTasks) {
    mediaTasks = Object.fromEntries(taskIds.slice(-BOARD_LEDGER_LIMITS.mediaTasks).map((id) => [id, mediaTasks[id]!]));
  }
  const paths = Object.keys(dismissed);
  if (paths.length > BOARD_LEDGER_LIMITS.dismissed) {
    const keep = new Set(
      [...paths]
        .sort((a, b) => dismissed[b]! - dismissed[a]! || comparePaths(a, b))
        .slice(0, BOARD_LEDGER_LIMITS.dismissed),
    );
    dismissed = Object.fromEntries(paths.filter((path) => keep.has(path)).map((path) => [path, dismissed[path]!]));
  }
  return { ...ledger, turns, mediaTasks, dismissed };
}

/** Records paths that left the board (`dismissed[path] = now`, trimmed to 500 by oldest). */
export function recordBoardDismissals(ledger: BoardSyncLedger, paths: readonly string[], now: number): BoardSyncLedger {
  if (paths.length === 0) return ledger;
  const dismissed = { ...ledger.dismissed };
  for (const path of paths) dismissed[path] = now;
  return trimBoardSyncLedger({ ...ledger, dismissed });
}

export type BoardSlicedApplyOutcome =
  | {
      ok: true;
      content: BoardContent;
      /** Indexes refer to the whole `ops` list. */
      results: BoardOpResult[];
      /** Net change from the input content; null when nothing changed. */
      changes: BoardChangeSet | null;
      removedPaths: string[];
    }
  | Exclude<BoardApplyOutcome, { ok: true }>;

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Net change set from `before` to `after`; `applyBoardOps` keeps the object identity of unchanged entities. */
function netBoardChangeSet(before: BoardContent, after: BoardContent, fromRevision: number, toRevision: number): BoardChangeSet | null {
  const beforeNodes = new Map(before.nodes.map((node) => [node.id, node]));
  const beforeEdges = new Map(before.edges.map((edge) => [edge.id, edge]));
  const afterNodeIds = new Set(after.nodes.map((node) => node.id));
  const afterEdgeIds = new Set(after.edges.map((edge) => edge.id));
  const upsertNodes = after.nodes.filter((node) => beforeNodes.get(node.id) !== node);
  const removeNodeIds = before.nodes.map((node) => node.id).filter((id) => !afterNodeIds.has(id));
  const upsertEdges = after.edges.filter((edge) => beforeEdges.get(edge.id) !== edge);
  const removeEdgeIds = before.edges.map((edge) => edge.id).filter((id) => !afterEdgeIds.has(id));
  const order = after.nodes.map((node) => node.id);
  const appendedOrder = [
    ...before.nodes.map((node) => node.id).filter((id) => afterNodeIds.has(id)),
    ...upsertNodes.filter((node) => !beforeNodes.has(node.id)).map((node) => node.id),
  ];
  const orderChanged = !sameIds(appendedOrder, order);
  const metaChanged = before.title !== after.title
    || before.settings.background !== after.settings.background
    || before.settings.autoPlace !== after.settings.autoPlace;
  if (upsertNodes.length === 0 && removeNodeIds.length === 0 && upsertEdges.length === 0 && removeEdgeIds.length === 0
    && !orderChanged && !metaChanged) {
    return null;
  }
  return {
    fromRevision,
    toRevision,
    upsertNodes,
    removeNodeIds,
    upsertEdges,
    removeEdgeIds,
    ...(orderChanged ? { order } : {}),
    ...(metaChanged ? { meta: { title: after.title ?? null, settings: after.settings } } : {}),
  };
}

/**
 * `applyBoardOps` for op lists of any length. The op engine refuses batches above `BOARD_LIMITS.maxOpsPerPatch`
 * (the PATCH request bound), while one sync can need more: a first sync over a long chat history, or reconciling
 * many renamed or deleted files. Slices run in order on the previous slice's result; the engine flushes layouts
 * after every op, so this yields the same content as one batch. All slices succeed or the outcome is the failure.
 */
export function applyBoardOpsInSlices(content: BoardContent, ops: readonly BoardOp[], ctx: BoardApplyContext): BoardSlicedApplyOutcome {
  const sliceSize = BOARD_LIMITS.maxOpsPerPatch;
  if (ops.length <= sliceSize) {
    const outcome = applyBoardOps(content, ops, ctx);
    if (!outcome.ok) return outcome;
    const changed = outcome.inverse.length > 0;
    return { ok: true, content: outcome.content, results: outcome.results, changes: changed ? outcome.changes : null, removedPaths: outcome.removedPaths };
  }
  let current = content;
  const results: BoardOpResult[] = [];
  const removed = new Set<string>();
  for (let start = 0; start < ops.length; start += sliceSize) {
    const outcome = applyBoardOps(current, ops.slice(start, start + sliceSize), ctx);
    if (!outcome.ok) return outcome;
    for (const result of outcome.results) results.push({ ...result, index: result.index + start });
    for (const path of outcome.removedPaths) removed.add(path);
    current = outcome.content;
  }
  // Same rule as the engine: a path a surviving node still shows is not reported as removed.
  const surviving = new Set(current.nodes.flatMap((node) =>
    boardNodeFileRefs(node).filter((entry) => entry.field !== 'render').map((entry) => entry.ref.path)));
  return {
    ok: true,
    content: current,
    results,
    changes: netBoardChangeSet(content, current, ctx.nextRevision - 1, ctx.nextRevision),
    removedPaths: [...removed].filter((path) => !surviving.has(path)),
  };
}

interface Size { w: number; h: number }

/** Size of a `row` group laid out from its children (same math as the op engine's re-layout + refit). */
function rowGroupSize(sizes: readonly Size[], gap: number): Size {
  if (sizes.length === 0) return { ...BOARD_GROUP_MIN_SIZE };
  const items = sizes.map((size, index) => ({ id: String(index).padStart(6, '0'), x: 0, y: 0, w: size.w, h: size.h }));
  const positions = layoutRow(
    items,
    { x: BOARD_LAYOUT.groupPad, y: BOARD_LAYOUT.groupHeader },
    gap,
    BOARD_LAYOUT.rowWrapWidth,
    'input',
  );
  const rects = positions.map((position, index) => ({ x: position.x, y: position.y, w: items[index]!.w, h: items[index]!.h }));
  const rect = refitGroupRect({ x: 0, y: 0, w: 0, h: 0 }, rects);
  return { w: rect.w, h: rect.h };
}

function pickNewest<T extends { path: string; mtime?: number }>(entries: readonly T[]): T | null {
  let best: T | null = null;
  for (const entry of entries) {
    if (!best) {
      best = entry;
      continue;
    }
    const a = entry.mtime ?? 0;
    const b = best.mtime ?? 0;
    if (a > b || (a === b && comparePaths(entry.path, best.path) > 0)) best = entry;
  }
  return best;
}

function truncate(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

// ---- planner ---------------------------------------------------------------------------------------

type NodeDraft = BoardNodeDraft & { id: string };

interface Draft {
  id: string;
  path: string;
  draft: NodeDraft;
  size: Size;
}

interface PlannerIndex {
  byId: Map<string, BoardNode>;
  edgeIds: Set<string>;
  byPath: Map<string, string>;
  byIdentity: Map<string, string>;
  movieNodeId: string | null;
  liveFrames: Map<string, string>;
}

interface VariantSet {
  groupKey: string;
  variant: BoardVariantPath;
  members: Draft[];
}

class BoardSyncPlanner {
  private content: BoardContent;
  private readonly ops: BoardOp[] = [];
  private readonly ledger: BoardSyncLedger;
  private readonly placements = new Map<string, BoardSyncPlacement>();
  private readonly created = new Set<string>();
  private readonly reserved = new Set<string>();
  private readonly rejected: BoardPlanRejection[] = [];
  private readonly unplaceable: string[] = [];
  /** runId → batch groups created by P3 in this sync (joined to that run's turn cluster by P4). */
  private readonly batchGroupsByRun = new Map<string, string[]>();
  private focusResult: BoardSyncPlan['focus'] = null;
  private index: PlannerIndex;
  private readonly autoPlace: boolean;

  constructor(private readonly input: BoardPlannerInput) {
    this.content = input.content;
    this.ledger = cloneLedger(input.ledger);
    this.index = this.buildIndex();
    this.autoPlace = input.content.settings.autoPlace !== false;
  }

  run(): BoardSyncPlan {
    this.reconcile();
    this.seed();
    if (this.autoPlace) this.mediaTasks();
    this.turns();
    this.focus();
    return this.result();
  }

  // ---- working copy ------------------------------------------------------------------------------

  private buildIndex(): PlannerIndex {
    const index: PlannerIndex = {
      byId: new Map(),
      edgeIds: new Set(this.content.edges.map((edge) => edge.id)),
      byPath: new Map(),
      byIdentity: new Map(),
      movieNodeId: null,
      liveFrames: new Map(),
    };
    for (const node of this.content.nodes) {
      index.byId.set(node.id, node);
      for (const { ref } of boardNodeFileRefs(node)) {
        if (!index.byPath.has(ref.path)) index.byPath.set(ref.path, node.id);
        if (ref.workspaceArtifactId && !index.byIdentity.has(ref.workspaceArtifactId)) {
          index.byIdentity.set(ref.workspaceArtifactId, node.id);
        }
      }
      if (node.kind === 'motion' && node.source.type === 'movie' && node.source.projectId === this.input.projectId) {
        index.movieNodeId ??= node.id;
      }
      if (node.kind === 'frame' && node.liveArtifactId && !index.liveFrames.has(node.liveArtifactId)) {
        index.liveFrames.set(node.liveArtifactId, node.id);
      }
    }
    return index;
  }

  /** Applies `ops` to the working copy; keeps the ops that changed something. False when the engine refused them. */
  private apply(ops: BoardOp[], step: string): boolean {
    if (ops.length === 0) return true;
    let outcome: BoardSlicedApplyOutcome;
    try {
      outcome = applyBoardOpsInSlices(this.content, ops, {
        baseRevision: 0,
        nextRevision: 1,
        actor: SYNC_ACTOR,
        now: this.input.now,
        newId: () => {
          throw new Error('board planner ops always carry explicit ids');
        },
        checkConflicts: false,
      });
    } catch (error) {
      this.rejected.push({ step, reason: 'error', detail: error instanceof Error ? error.message : String(error) });
      return false;
    }
    if (!outcome.ok) {
      const detail = outcome.reason === 'conflict' ? outcome.conflicts : outcome.reason === 'invalid' ? outcome.issues : outcome.details;
      this.rejected.push({ step, reason: outcome.reason, detail });
      return false;
    }
    for (const result of outcome.results) {
      if (result.status === 'applied') this.ops.push(ops[result.index]!);
    }
    this.content = outcome.content;
    this.index = this.buildIndex();
    return true;
  }

  private node(id: string | undefined): BoardNode | undefined {
    return id === undefined ? undefined : this.index.byId.get(id);
  }

  private nodeForFile(path: string): BoardNode | undefined {
    const byPath = this.node(this.index.byPath.get(path));
    if (byPath) return byPath;
    const identity = this.input.identities.get(path);
    return identity ? this.node(this.index.byIdentity.get(identity)) : undefined;
  }

  private isTaken(id: string): boolean {
    return this.index.byId.has(id) || this.index.edgeIds.has(id) || this.reserved.has(id);
  }

  /** `stableBoardId('n', seed)`, or a deterministic `seed#k` variant when that id is already used by something else. */
  private allocateId(seed: string): string {
    let id = stableBoardId('n', seed);
    for (let attempt = 2; this.isTaken(id); attempt += 1) id = stableBoardId('n', `${seed}#${attempt}`);
    this.reserved.add(id);
    return id;
  }

  private fileRef(path: string): BoardFileRef {
    const identity = this.input.identities.get(path);
    return identity ? { path, workspaceArtifactId: identity } : { path };
  }

  private place(nodeId: string, status: BoardSyncPlacement['status'], extra: Omit<Partial<BoardSyncPlacement>, 'nodeId' | 'status'> = {}): void {
    const current = this.placements.get(nodeId);
    // created / removed are sticky against later lookups; an update is not downgraded to a mere reuse.
    const keep = current && status !== 'removed'
      && (current.status === 'created' || (current.status === 'updated' && status === 'existing'));
    this.placements.set(nodeId, { ...(current ?? {}), ...extra, nodeId, status: keep ? current.status : status });
  }

  private markCreated(drafts: readonly Draft[]): void {
    for (const draft of drafts) {
      if (!this.index.byId.has(draft.id)) continue;
      this.created.add(draft.id);
      this.place(draft.id, 'created', { path: draft.path });
    }
  }

  // ---- drafts ---------------------------------------------------------------------------------------

  private snapshotCover(path: string): BoardCoverRef | undefined {
    const cover = this.input.snapshotCovers.get(path);
    if (!cover) return undefined;
    return {
      source: 'chat-artifact-snapshot',
      snapshotId: cover.snapshotId,
      ...(cover.sourceMtime !== undefined ? { sourceMtime: cover.sourceMtime } : {}),
    };
  }

  private movieDraft(origin: BoardNodeOrigin, render?: string): Draft {
    const id = this.allocateId(`movie:${this.input.projectId}`);
    const size = defaultBoardNodeSize('motion');
    const draft = {
      id,
      kind: 'motion',
      source: { type: 'movie', projectId: this.input.projectId },
      ...(render ? { render: this.fileRef(render) } : {}),
      w: size.w,
      h: size.h,
      origin,
    } as NodeDraft;
    return { id, path: 'movie-studio.json', draft, size };
  }

  /** A node for a project file of a placeable kind (`movie-studio.json` becomes the movie node). */
  private fileDraft(
    path: string,
    kind: BoardPlaceableKind,
    origin: BoardNodeOrigin,
    extra: { variantLabel?: string; render?: string; withCover?: boolean } = {},
  ): Draft {
    if (kind === 'motion' && isBoardMovieDocumentPath(path)) {
      const movie = this.movieDraft(origin, extra.render);
      return { ...movie, path };
    }
    const ref = this.fileRef(path);
    const id = this.allocateId(`path:${ref.workspaceArtifactId ?? path}`);
    const common = {
      id,
      ...(extra.variantLabel ? { variantLabel: extra.variantLabel } : {}),
      origin,
    };
    const cover = extra.withCover ? this.snapshotCover(path) : undefined;
    let size: Size;
    let draft: NodeDraft;
    switch (kind) {
      case 'frame': {
        const device = deviceForFramePath(path, this.input.project.platform ?? null, this.input.project.kind ?? null);
        const sized = defaultBoardNodeSize('frame', { device, projectKind: this.input.project.kind });
        size = { w: sized.w, h: sized.h };
        draft = { ...common, kind: 'frame', ref, device: sized.device ?? device, w: size.w, h: size.h, ...(cover ? { cover } : {}) } as NodeDraft;
        break;
      }
      case 'image':
        size = defaultBoardNodeSize('image');
        draft = { ...common, kind: 'image', ref, w: size.w, h: size.h, autoSize: true } as NodeDraft;
        break;
      case 'video':
        size = defaultBoardNodeSize('video');
        draft = { ...common, kind: 'video', ref, w: size.w, h: size.h, autoSize: true, ...(cover ? { cover } : {}) } as NodeDraft;
        break;
      case 'audio':
        size = defaultBoardNodeSize('audio');
        draft = { ...common, kind: 'audio', ref, w: size.w, h: size.h } as NodeDraft;
        break;
      case 'design':
        size = defaultBoardNodeSize('design');
        draft = { ...common, kind: 'design', ref, format: path.toLowerCase().endsWith('.op') ? 'op' : 'fig', w: size.w, h: size.h } as NodeDraft;
        break;
      case 'motion':
      default:
        size = defaultBoardNodeSize('motion');
        draft = {
          ...common,
          kind: 'motion',
          source: { type: 'composition', ref },
          ...(extra.render ? { render: this.fileRef(extra.render) } : {}),
          w: size.w,
          h: size.h,
        } as NodeDraft;
        break;
    }
    return { id, path, draft, size };
  }

  private groupDraft(
    id: string,
    fields: { role: 'section' | 'turn' | 'variants'; sectionKind?: BoardSectionKind; variantKey?: string; baseNodeId?: string; title?: string },
    size: Size,
    position?: { x: number; y: number },
  ): NodeDraft {
    return {
      id,
      kind: 'group',
      role: fields.role,
      layout: 'row',
      ...(fields.sectionKind ? { sectionKind: fields.sectionKind } : {}),
      ...(fields.variantKey ? { variantKey: fields.variantKey } : {}),
      ...(fields.baseNodeId ? { baseNodeId: fields.baseNodeId } : {}),
      ...(fields.title ? { title: fields.title } : {}),
      w: size.w,
      h: size.h,
      ...(position ? { x: position.x, y: position.y } : {}),
    } as NodeDraft;
  }

  private addOp(draft: NodeDraft, where: { parentId?: string; placement?: BoardPlacement; at?: { x: number; y: number } }): BoardOp {
    const node = {
      ...draft,
      ...(this.input.pageId ? { page: this.input.pageId } : {}),
      ...(where.parentId ? { parentId: where.parentId } : {}),
      ...(where.at ? { x: where.at.x, y: where.at.y } : {}),
    } as BoardNodeDraft;
    return { op: 'add', node, ifAbsent: true, ...(where.placement && !where.parentId && !where.at ? { placement: where.placement } : {}) };
  }

  /** What placement looks at: the page new outputs land on. */
  private pageContent(): { nodes: readonly BoardNode[] } {
    const pages = boardPagesOf(this.content);
    return { nodes: boardNodesOnPage(this.content.nodes, pages, resolveBoardPageId(pages, this.input.pageId)) };
  }

  private topLevelOf(id: string): string {
    return topLevelAncestorId(id, this.index.byId);
  }

  // ---- P1 reconcile ---------------------------------------------------------------------------------

  private reconcile(): void {
    const { refStatuses, now } = this.input;
    const ops: BoardOp[] = [];
    for (const node of this.content.nodes) {
      const primaryField: BoardRefField | null =
        node.kind === 'motion' ? 'source' : boardNodeFileRefs(node).some((entry) => entry.field === 'ref') ? 'ref' : null;
      const primary = primaryField ? refStatuses.get(boardRefStatusKey(node.id, primaryField)) : undefined;
      const render = node.kind === 'motion' ? refStatuses.get(boardRefStatusKey(node.id, 'render')) : undefined;
      if (!primary && !render) continue;
      const currentRef = boardNodeFileRefs(node).find((entry) => entry.field === primaryField)?.ref;
      if (primary?.status === 'deleted' && primaryField !== null) {
        ops.push({ op: 'remove', ids: [node.id] });
        this.place(node.id, 'removed', currentRef ? { path: currentRef.path } : {});
        continue;
      }
      const patch: BoardNodePatch = {};
      let placementPath = currentRef?.path;
      if (primary) {
        if (primary.status === 'renamed' && primary.path) {
          const renamed = { path: primary.path, ...(primary.workspaceArtifactId ? { workspaceArtifactId: primary.workspaceArtifactId } : {}) };
          if (this.renameFits(node, primary.path)) {
            if (node.kind === 'motion') patch.source = { type: 'composition', ref: renamed };
            else patch.ref = renamed;
            if (node.missing) patch.missing = null;
            placementPath = primary.path;
          } else if (!node.missing) {
            patch.missing = { since: now };
          }
        } else if (primary.status === 'missing') {
          if (!node.missing) patch.missing = { since: now };
        } else if (primary.status === 'present') {
          if (node.missing) patch.missing = null;
        }
      }
      if (render && node.kind === 'motion' && node.render) {
        if (render.status === 'renamed' && render.path) {
          patch.render = boardKindForPath(render.path) === 'video'
            ? { path: render.path, ...(render.workspaceArtifactId ? { workspaceArtifactId: render.workspaceArtifactId } : {}) }
            : null;
        } else if (render.status === 'deleted' || render.status === 'missing') {
          patch.render = null;
        }
      }
      if (Object.keys(patch).length === 0) continue;
      ops.push({ op: 'update', id: node.id, patch });
      this.place(node.id, 'updated', placementPath ? { path: placementPath } : {});
    }
    this.apply(ops, 'P1 reconcile');
  }

  /** A renamed file keeps its node only when the new name still is that node's kind. */
  private renameFits(node: BoardNode, path: string): boolean {
    const kind = boardKindForPath(path);
    if (node.kind === 'motion') return node.source.type === 'composition' && boardCompositionDir(path) !== null;
    return kind === node.kind;
  }

  // ---- P2 seed --------------------------------------------------------------------------------------

  private seed(): void {
    if (this.ledger.seededAt !== null) return;
    const { now } = this.input;
    if (this.autoPlace && this.input.seedFiles) {
      const candidates = boardSeedCandidates(this.input.seedFiles, this.ledger.dismissed)
        .filter((candidate) => !this.nodeForFile(candidate.path));
      const movieDocument = candidates.find((candidate) => isBoardMovieDocumentPath(candidate.path));
      const movieNodeExisted = this.index.movieNodeId !== null;
      let seeded = candidates;
      let newestRender: { path: string; mtime: number } | null = null;
      if (movieNodeExisted || movieDocument) {
        newestRender = pickNewest(candidates.filter((candidate) => isBoardMovieRenderPath(candidate.path)));
        seeded = candidates.filter((candidate) => !isBoardMovieRenderPath(candidate.path));
      }
      for (const kind of SEED_KIND_ORDER) {
        const bucket = seeded.filter((candidate) => candidate.kind === kind);
        if (bucket.length === 0) continue;
        if (kind === 'motion' && movieNodeExisted) {
          // The project already has its movie node: never seed a second one.
          const withoutMovie = bucket.filter((candidate) => !isBoardMovieDocumentPath(candidate.path));
          if (withoutMovie.length === 0) continue;
          bucket.splice(0, bucket.length, ...withoutMovie);
        }
        const drafts = bucket.map((candidate) => this.fileDraft(candidate.path, kind, { source: 'seed' }, {
          ...(isBoardMovieDocumentPath(candidate.path) && newestRender ? { render: newestRender.path } : {}),
        }));
        const sectionSeed = `section:${kind}`;
        const existing = this.node(stableBoardId('n', sectionSeed));
        const ops: BoardOp[] = [];
        let parentId: string | null = null;
        if (existing?.kind === 'group') {
          parentId = existing.id;
        } else {
          parentId = this.allocateId(sectionSeed);
          const size = rowGroupSize(drafts.map((draft) => draft.size), BOARD_LAYOUT.itemGap);
          ops.push(this.addOp(this.groupDraft(parentId, { role: 'section', sectionKind: kind }, size), { placement: { mode: 'auto' } }));
        }
        for (const draft of drafts) ops.push(this.addOp(draft.draft, { parentId }));
        if (this.apply(ops, `P2 seed ${kind}`)) this.markCreated(drafts);
      }
      if (movieNodeExisted && newestRender) this.attachMovieRender(newestRender.path, 'P2 movie render');
    }
    this.ledger.seededAt = now;
    this.ledger.cursor = Math.max(this.ledger.cursor, now - BOARD_SYNC_LOOKBACK_MS);
  }

  private attachMovieRender(path: string, step: string): void {
    const movie = this.node(this.index.movieNodeId ?? undefined);
    if (!movie || movie.kind !== 'motion' || movie.render?.path === path) return;
    if (this.apply([{ op: 'update', id: movie.id, patch: { render: this.fileRef(path) } }], step)) {
      this.place(movie.id, 'updated', { path });
    }
  }

  // ---- P3 media tasks -------------------------------------------------------------------------------

  private mediaTasks(): void {
    const kindEligible = MEDIA_SURFACE_KINDS.has(this.input.project.kind ?? '');
    const tasks = [...this.input.mediaTasks].sort((a, b) => a.sequence - b.sequence);
    for (const task of tasks) {
      if (!MEDIA_SURFACE_KINDS.has(task.surface)) continue;
      if (!kindEligible && task.batchSize < 2) continue;
      const ledgerNodeId = this.ledger.mediaTasks[task.taskId];
      const existing = ledgerNodeId !== undefined
        ? this.node(ledgerNodeId)
        : this.node(stableBoardId('n', `media:${task.taskId}`));
      if (ledgerNodeId !== undefined && !existing) continue; // the user removed the placeholder
      if (existing) {
        this.syncMediaNode(existing, task);
        continue;
      }
      this.createMediaNode(task);
    }
  }

  private pendingFor(task: BoardPlannerMediaTask): BoardPendingMedia {
    const status: BoardPendingMedia['status'] =
      task.status === 'queued' || task.status === 'running' || task.status === 'failed' || task.status === 'interrupted'
        ? task.status
        : 'running';
    const pending: BoardPendingMedia = { mediaTaskId: task.taskId, status };
    if ((status === 'queued' || status === 'running') && task.progress) pending.progress = truncate(task.progress, PENDING_PROGRESS_LIMIT);
    if ((status === 'failed' || status === 'interrupted') && task.error) {
      const nextStep = task.error.nextStep;
      pending.error = {
        message: truncate(task.error.message, PENDING_ERROR_LIMIT),
        // Only the contract's vocabulary is stored; anything else would make the op invalid.
        ...(nextStep && (MEDIA_FAILURE_NEXT_STEPS as readonly string[]).includes(nextStep) ? { nextStep } : {}),
      };
    }
    return pending;
  }

  private syncMediaNode(node: BoardNode, task: BoardPlannerMediaTask): void {
    this.ledger.mediaTasks[task.taskId] = node.id;
    if (node.kind !== 'image' && node.kind !== 'video' && node.kind !== 'audio') return;
    if (task.status === 'done') {
      if (!task.filePath) return; // done without a file: stays as it is
      const other = this.nodeForFile(task.filePath);
      if (other && other.id !== node.id) {
        if (this.apply([{ op: 'remove', ids: [node.id] }], `P3 media remap ${task.taskId}`)) {
          this.ledger.mediaTasks[task.taskId] = other.id;
          this.place(node.id, 'removed', { mediaTaskId: task.taskId });
          this.place(other.id, 'existing', { path: task.filePath, mediaTaskId: task.taskId });
        }
        return;
      }
      if (node.ref?.path === task.filePath && !node.pending) return;
      const patch: BoardNodePatch = { ref: this.fileRef(task.filePath), pending: null, autoSize: true };
      if (this.apply([{ op: 'update', id: node.id, patch }], `P3 media done ${task.taskId}`)) {
        this.place(node.id, 'updated', { path: task.filePath, mediaTaskId: task.taskId });
      }
      return;
    }
    if (node.ref && !node.pending) return; // already converted
    const pending = this.pendingFor(task);
    if (node.pending && JSON.stringify(node.pending) === JSON.stringify(pending)) return;
    if (this.apply([{ op: 'update', id: node.id, patch: { pending } }], `P3 media status ${task.taskId}`)) {
      this.place(node.id, 'updated', { mediaTaskId: task.taskId });
    }
  }

  private createMediaNode(task: BoardPlannerMediaTask): void {
    const done = task.status === 'done' && task.filePath !== undefined;
    if (done && task.filePath) {
      const other = this.nodeForFile(task.filePath);
      if (other) {
        this.ledger.mediaTasks[task.taskId] = other.id;
        this.place(other.id, 'existing', { path: task.filePath, mediaTaskId: task.taskId });
        return;
      }
    }
    const kind = task.surface as 'image' | 'video' | 'audio';
    const id = this.allocateId(`media:${task.taskId}`);
    const size = defaultBoardNodeSize(kind);
    const origin: BoardNodeOrigin = {
      source: 'media-task',
      mediaTaskId: task.taskId,
      runId: task.runId,
      ...(task.messageId ? { messageId: task.messageId } : {}),
      ...(task.conversationId ? { conversationId: task.conversationId } : {}),
      batchId: task.batchId,
      batchIndex: task.batchIndex,
    };
    const draft = {
      id,
      kind,
      ref: done && task.filePath ? this.fileRef(task.filePath) : null,
      ...(done ? {} : { pending: this.pendingFor(task) }),
      ...(task.batchSize >= 2 ? { variantLabel: String(task.batchIndex) } : {}),
      w: size.w,
      h: size.h,
      autoSize: true,
      origin,
    } as NodeDraft;
    const ops: BoardOp[] = [];
    let parentId: string | undefined;
    let createdGroup: string | null = null;
    if (task.batchSize >= 2) {
      const groupSeed = `batch:${task.batchId}`;
      const group = this.node(stableBoardId('n', groupSeed));
      if (group?.kind === 'group') {
        parentId = group.id;
      } else {
        parentId = this.allocateId(groupSeed);
        createdGroup = parentId;
        const groupSize = rowGroupSize([size], BOARD_LAYOUT.variantGap);
        ops.push(this.addOp(this.groupDraft(parentId, { role: 'variants', variantKey: groupSeed }, groupSize), { placement: { mode: 'auto' } }));
      }
    }
    ops.push(this.addOp(draft, parentId ? { parentId } : { placement: { mode: 'auto' } }));
    if (!this.apply(ops, `P3 media create ${task.taskId}`)) return;
    this.ledger.mediaTasks[task.taskId] = id;
    this.created.add(id);
    this.place(id, 'created', { mediaTaskId: task.taskId, ...(done && task.filePath ? { path: task.filePath } : {}) });
    if (createdGroup) {
      this.created.add(createdGroup);
      const list = this.batchGroupsByRun.get(task.runId) ?? [];
      list.push(createdGroup);
      this.batchGroupsByRun.set(task.runId, list);
    }
  }

  // ---- P4 turns ---------------------------------------------------------------------------------------

  private turns(): void {
    const hinted = this.input.focus?.turnMessageId ?? null;
    const focusPaths = new Set<string>();
    for (const target of this.input.focusTargets?.values() ?? []) if (target?.kind === 'file') focusPaths.add(target.path);
    const turns = [...this.input.turns].sort((a, b) => a.createdAt - b.createdAt || comparePaths(a.messageId, b.messageId));
    for (const turn of turns) {
      const onlyFocus = !this.autoPlace;
      if (onlyFocus && turn.messageId !== hinted) {
        if (turn.terminal) this.ledger.cursor = Math.max(this.ledger.cursor, turn.createdAt);
        continue;
      }
      this.planTurn(turn, onlyFocus ? focusPaths : null);
    }
  }

  private turnOrigin(turn: BoardPlannerTurn): BoardNodeOrigin {
    return {
      source: 'chat-turn',
      conversationId: turn.conversationId,
      messageId: turn.messageId,
      ...(turn.runId ? { runId: turn.runId } : {}),
    };
  }

  private planTurn(turn: BoardPlannerTurn, onlyPaths: ReadonlySet<string> | null): void {
    const { now } = this.input;
    const previous = this.ledger.turns[turn.messageId];
    const placedNow: Record<string, string> = {};
    const origin = this.turnOrigin(turn);

    // 1. Placeable outputs: not svg, not dismissed after the turn (a newer turn clears the dismissal), and not a path
    //    this turn already placed whose node is gone. The user removed that node, and the turn is re-read until the
    //    cursor passes it; the movie node (and a render attached to it) has no file ref, so no dismissal records it.
    const unique = new Map<string, { path: string; mtime?: number }>();
    for (const output of turn.outputs) if (!unique.has(output.path)) unique.set(output.path, output);
    let outputs = [...unique.values()].filter((output) => {
      if (!boardKindForPath(output.path) || isSvgPath(output.path)) return false;
      if (onlyPaths && !onlyPaths.has(output.path)) return false;
      const placedId = previous?.placed[output.path];
      if (placedId !== undefined && !this.index.byId.has(placedId)) return false;
      const dismissedAt = this.ledger.dismissed[output.path];
      if (dismissedAt === undefined) return true;
      if (dismissedAt >= turn.createdAt) return false;
      delete this.ledger.dismissed[output.path];
      return true;
    });

    // 3. Movie document, movie renders and a composition's render.
    const updates: BoardOp[] = [];
    let movieNew: Draft | null = null;
    const movieDocument = outputs.find((output) => isBoardMovieDocumentPath(output.path));
    if (movieDocument && this.index.movieNodeId === null) {
      movieNew = this.movieDraft(origin);
      movieNew = { ...movieNew, path: movieDocument.path };
    }
    const movieNodeId = this.index.movieNodeId ?? movieNew?.id ?? null;
    if (movieNodeId) {
      const renders = outputs.filter((output) => isBoardMovieRenderPath(output.path));
      const newest = pickNewest(renders);
      if (newest) {
        outputs = outputs.filter((output) => !isBoardMovieRenderPath(output.path));
        placedNow[newest.path] = movieNodeId;
        if (movieNew) {
          movieNew.draft = { ...movieNew.draft, render: this.fileRef(newest.path) } as NodeDraft;
        } else {
          const movie = this.node(movieNodeId);
          if (movie?.kind === 'motion' && movie.render?.path !== newest.path) {
            updates.push({ op: 'update', id: movie.id, patch: { render: this.fileRef(newest.path) } });
          }
        }
      }
    }
    let compositionRender: { compositionPath: string; videoPath: string } | null = null;
    const compositions = outputs.filter((output) => boardCompositionDir(output.path) !== null);
    const videos = outputs.filter((output) => boardKindForPath(output.path) === 'video');
    if (compositions.length === 1 && videos.length >= 1) {
      const newest = pickNewest(videos)!;
      compositionRender = { compositionPath: compositions[0]!.path, videoPath: newest.path };
      outputs = outputs.filter((output) => boardKindForPath(output.path) !== 'video');
    }

    // 2. Rank: frames/designs/motion when present, else media; web-clone keeps one entry html; cap 12.
    const kindOf = (path: string) => boardKindForPath(path)!;
    const primaryOutputs = outputs.filter((output) => PRIMARY_OUTPUT_KINDS.has(kindOf(output.path)));
    let ranked = primaryOutputs.length > 0 ? primaryOutputs : outputs;
    if (this.input.project.intent === 'web-clone') {
      const frames = ranked
        .filter((output) => kindOf(output.path) === 'frame')
        .sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || comparePaths(a.path, b.path));
      const entry = frames.find((output) => output.path.split('/').pop()?.toLowerCase() === 'index.html') ?? frames[0];
      if (entry) ranked = ranked.filter((output) => kindOf(output.path) !== 'frame' || output.path === entry.path);
    }
    ranked = [...ranked]
      .sort((a, b) => pathDepth(a.path) - pathDepth(b.path) || comparePaths(a.path, b.path))
      .slice(0, BOARD_TURN_OUTPUT_LIMIT);

    // 4. Reuse or create one node per path.
    const fresh: Draft[] = [];
    for (const output of ranked) {
      if (isBoardMovieDocumentPath(output.path)) {
        if (movieNew) {
          if (!fresh.includes(movieNew)) fresh.push(movieNew);
          placedNow[output.path] = movieNew.id;
        } else if (movieNodeId) {
          placedNow[output.path] = movieNodeId;
          this.place(movieNodeId, 'existing', { path: output.path });
        }
        continue;
      }
      const isComposition = compositionRender?.compositionPath === output.path;
      const existing = this.nodeForFile(output.path);
      if (existing) {
        placedNow[output.path] = existing.id;
        this.place(existing.id, 'existing', { path: output.path });
        if (isComposition && existing.kind === 'motion' && existing.render?.path !== compositionRender!.videoPath) {
          updates.push({ op: 'update', id: existing.id, patch: { render: this.fileRef(compositionRender!.videoPath) } });
        }
        if (isComposition) placedNow[compositionRender!.videoPath] = existing.id;
        continue;
      }
      const kind = kindOf(output.path);
      const draft = this.fileDraft(output.path, kind, origin, {
        withCover: kind === 'frame' || kind === 'video',
        ...(isComposition ? { render: compositionRender!.videoPath } : {}),
      });
      fresh.push(draft);
      placedNow[output.path] = draft.id;
      if (isComposition) placedNow[compositionRender!.videoPath] = draft.id;
    }
    if (updates.length > 0) this.apply(updates, `P4 renders ${turn.messageId}`);

    // 5. Variant rows.
    const keyCounts = new Map<string, number>();
    for (const output of ranked) {
      const variant = parseBoardVariantPath(output.path);
      if (variant) keyCounts.set(variant.groupKey, (keyCounts.get(variant.groupKey) ?? 0) + 1);
    }
    const sets = new Map<string, VariantSet>();
    for (const draft of fresh) {
      const variant = parseBoardVariantPath(draft.path);
      if (!variant) continue;
      if (!variant.explicit && (keyCounts.get(variant.groupKey) ?? 0) < 2) continue;
      const set = sets.get(variant.groupKey) ?? { groupKey: variant.groupKey, variant, members: [] };
      set.members.push(draft);
      sets.set(variant.groupKey, set);
    }
    const memberIds = new Set<string>();
    const appendToExisting: Array<{ groupId: string; members: Draft[]; baseId: string | null }> = [];
    const anchored: Array<{ groupId: string; groupDraft: NodeDraft; members: Draft[]; baseId: string; anchorId: string }> = [];
    const unanchored: Array<{ groupId: string; groupDraft: NodeDraft; members: Draft[]; baseId: string | null; size: Size }> = [];
    for (const set of sets.values()) {
      for (const member of set.members) {
        const label = parseBoardVariantPath(member.path)?.label;
        if (label) member.draft = { ...member.draft, variantLabel: label } as NodeDraft;
        memberIds.add(member.id);
      }
      const basePath = boardVariantBasePath(set.variant);
      const baseExisting = this.nodeForFile(basePath);
      const baseFresh = fresh.find((draft) => draft.path === basePath && !memberIds.has(draft.id));
      const baseId = baseExisting && baseExisting.kind !== 'group' ? baseExisting.id : baseFresh?.id ?? null;
      const groupSeed = `variants:${set.groupKey}`;
      const existingGroup = this.node(stableBoardId('n', groupSeed));
      if (existingGroup?.kind === 'group') {
        appendToExisting.push({ groupId: existingGroup.id, members: set.members, baseId });
        continue;
      }
      const groupId = this.allocateId(groupSeed);
      const size = rowGroupSize(
        sortBoardLayoutItems(set.members.map((member) => ({
          id: member.id,
          x: 0,
          y: 0,
          w: member.size.w,
          h: member.size.h,
          variantLabel: parseBoardVariantPath(member.path)?.label,
        })), 'variant'),
        BOARD_LAYOUT.variantGap,
      );
      const groupDraft = this.groupDraft(groupId, { role: 'variants', variantKey: set.groupKey, ...(baseId ? { baseNodeId: baseId } : {}) }, size);
      if (baseExisting && baseExisting.kind !== 'group') {
        anchored.push({ groupId, groupDraft, members: set.members, baseId: baseExisting.id, anchorId: this.topLevelOf(baseExisting.id) });
      } else {
        unanchored.push({ groupId, groupDraft, members: set.members, baseId, size });
      }
    }
    const standalone = fresh.filter((draft) => !memberIds.has(draft.id));

    // 6. Turn cluster.
    const batchGroups = (turn.runId ? this.batchGroupsByRun.get(turn.runId) ?? [] : [])
      .map((id) => this.node(id))
      .filter((node): node is BoardNode => Boolean(node && node.kind === 'group' && node.parentId === undefined));
    const itemCount = standalone.length + unanchored.length + batchGroups.length;
    // Rows count by their nodes: one new variant row of three files forms a turn group (spec 04 §11 board-sync).
    const clusterWeight = standalone.length
      + unanchored.reduce((sum, group) => sum + group.members.length, 0)
      + batchGroups.reduce((sum, group) => sum + this.content.nodes.filter((node) => node.parentId === group.id).length, 0);
    const clusterOps: BoardOp[] = [];
    const clusterDrafts: Draft[] = [...standalone, ...unanchored.flatMap((group) => group.members)];
    let turnGroupId: string | null = null;
    const ledgerGroup = previous?.groupId ? this.node(previous.groupId) : undefined;
    const pushGroupedItems = (parentId: string) => {
      // A turn group the user nested into another group cannot take groups (maxGroupDepth): new variant rows
      // then go below the content and batch rows stay where P3 put them.
      const nestable = this.node(parentId)?.parentId === undefined;
      for (const draft of standalone) clusterOps.push(this.addOp(draft.draft, { parentId }));
      for (const group of unanchored) {
        clusterOps.push(this.addOp(group.groupDraft, nestable ? { parentId } : { placement: { mode: 'auto' } }));
        for (const member of group.members) clusterOps.push(this.addOp(member.draft, { parentId: group.groupId }));
      }
      if (nestable) for (const group of batchGroups) clusterOps.push({ op: 'update', id: group.id, patch: { parentId } });
    };
    if (itemCount > 0 && ledgerGroup?.kind === 'group') {
      turnGroupId = ledgerGroup.id;
      pushGroupedItems(ledgerGroup.id);
    } else if (itemCount > 0) {
      const earlier = previous?.groupId
        ? [] // the user dissolved this turn's group: do not regroup its nodes
        : sortBoardLayoutItems(
            this.content.nodes.filter((node) => node.parentId === undefined
              && !this.created.has(node.id)
              && node.origin?.source === 'chat-turn'
              && node.origin.messageId === turn.messageId),
            'position',
          );
      if (!previous?.groupId && clusterWeight + earlier.length >= 2) {
        turnGroupId = this.allocateId(`turn:${turn.messageId}`);
        const sizes: Size[] = [
          ...earlier.map((node) => ({ w: node.w, h: node.h })),
          ...standalone.map((draft) => draft.size),
          ...unanchored.map((group) => group.size),
          ...batchGroups.map((group) => ({ w: group.w, h: group.h })),
        ];
        const size = rowGroupSize(sizes, BOARD_LAYOUT.itemGap);
        const bounds = boardNodesBounds(earlier);
        const position = bounds ? { x: bounds.x - BOARD_LAYOUT.groupPad, y: bounds.y - BOARD_LAYOUT.groupHeader } : undefined;
        const title = turn.prompt ? truncate(turn.prompt, 200) : undefined;
        clusterOps.push(this.addOp(
          this.groupDraft(turnGroupId, { role: 'turn', ...(title ? { title } : {}) }, size, position),
          position ? {} : { placement: { mode: 'auto' } },
        ));
        for (const node of earlier) clusterOps.push({ op: 'update', id: node.id, patch: { parentId: turnGroupId } });
        pushGroupedItems(turnGroupId);
      } else {
        // One item (or a dissolved cluster): place the new items as one row block below the content.
        const blockItems: Array<{ draft: NodeDraft; size: Size; members?: Draft[]; groupId?: string }> = [
          ...standalone.map((draft) => ({ draft: draft.draft, size: draft.size })),
          ...unanchored.map((group) => ({ draft: group.groupDraft, size: group.size, members: group.members, groupId: group.groupId })),
        ];
        const positions = blockItems.length > 1
          ? placeBoardItems(this.pageContent(), blockItems.map((item) => item.size), { mode: 'auto' })
          : [];
        blockItems.forEach((item, index) => {
          const at = positions[index];
          clusterOps.push(this.addOp(item.draft, at ? { at } : { placement: { mode: 'auto' } }));
          for (const member of item.members ?? []) clusterOps.push(this.addOp(member.draft, { parentId: item.groupId! }));
        });
      }
    }
    if (movieNew && !fresh.includes(movieNew) && !clusterDrafts.includes(movieNew)) {
      // movie-studio.json was ranked out of this turn's outputs: the movie node still has to exist.
      clusterOps.unshift(this.addOp(movieNew.draft, { placement: { mode: 'auto' } }));
      clusterDrafts.push(movieNew);
      placedNow[movieNew.path] = movieNew.id;
    }
    if (this.apply(clusterOps, `P4 cluster ${turn.messageId}`)) {
      this.markCreated(clusterDrafts);
      for (const group of unanchored) if (this.index.byId.has(group.groupId)) this.created.add(group.groupId);
      if (turnGroupId && this.index.byId.has(turnGroupId)) this.created.add(turnGroupId);
    } else {
      turnGroupId = ledgerGroup?.kind === 'group' ? ledgerGroup.id : null;
      for (const draft of clusterDrafts) delete placedNow[draft.path];
    }

    // 5b. Anchored variant rows (next to their base's top-level container) and appends to existing rows.
    const variantOps: BoardOp[] = [];
    const variantDrafts: Draft[] = [];
    for (const group of anchored) {
      variantOps.push(this.addOp(group.groupDraft, { placement: { mode: 'near', nodeId: group.anchorId, side: 'right' } }));
      for (const member of group.members) variantOps.push(this.addOp(member.draft, { parentId: group.groupId }));
      variantDrafts.push(...group.members);
    }
    for (const group of appendToExisting) {
      for (const member of group.members) variantOps.push(this.addOp(member.draft, { parentId: group.groupId }));
      variantDrafts.push(...group.members);
    }
    if (variantOps.length > 0) {
      if (this.apply(variantOps, `P4 variants ${turn.messageId}`)) {
        this.markCreated(variantDrafts);
        for (const group of anchored) if (this.index.byId.has(group.groupId)) this.created.add(group.groupId);
      } else {
        for (const draft of variantDrafts) delete placedNow[draft.path];
      }
    }

    // Lineage edges base → variant, and 7. snapshot covers for this turn's nodes.
    const tailOps: BoardOp[] = [];
    const lineage = [
      ...anchored.map((group) => ({ baseId: group.baseId as string | null, members: group.members })),
      ...unanchored.map((group) => ({ baseId: group.baseId, members: group.members })),
      ...appendToExisting.map((group) => ({ baseId: group.baseId, members: group.members })),
    ];
    for (const { baseId, members } of lineage) {
      if (!baseId || !this.index.byId.has(baseId)) continue;
      for (const member of members) {
        if (!this.index.byId.has(member.id)) continue;
        tailOps.push({
          op: 'connect',
          edge: { id: stableBoardId('e', `lineage:${baseId}:${member.id}`), kind: 'lineage', from: baseId, to: member.id },
          ifAbsent: true,
        });
      }
    }
    for (const node of this.content.nodes) {
      if ((node.kind !== 'frame' && node.kind !== 'video') || node.cover || !node.ref) continue;
      if (node.origin?.messageId !== turn.messageId) continue;
      const cover = this.snapshotCover(node.ref.path);
      if (cover) tailOps.push({ op: 'update', id: node.id, patch: { cover } });
    }
    this.apply(tailOps, `P4 lineage+covers ${turn.messageId}`);

    // 8. Ledger.
    const aliveGroup = turnGroupId && this.node(turnGroupId)?.kind === 'group' ? turnGroupId : null;
    const placedIds = Object.fromEntries(Object.entries(placedNow).filter(([, id]) => this.index.byId.has(id)));
    if (previous || Object.keys(placedIds).length > 0 || aliveGroup) {
      const groupId = aliveGroup ?? previous?.groupId;
      this.ledger.turns[turn.messageId] = {
        conversationId: turn.conversationId,
        status: turn.terminal ? 'terminal' : 'running',
        ...(groupId ? { groupId } : {}),
        placed: { ...(previous?.placed ?? {}), ...placedIds },
        updatedAt: now,
      };
    }
    if (turn.terminal) this.ledger.cursor = Math.max(this.ledger.cursor, turn.createdAt);
  }

  // ---- P5 focus ---------------------------------------------------------------------------------------

  private focus(): void {
    const focus = this.input.focus;
    if (!focus) return;
    const turn = focus.turnMessageId
      ? this.input.turns.find((entry) => entry.messageId === focus.turnMessageId) ?? null
      : null;
    const nodeIds: string[] = [];
    let primaryNodeId: string | null = null;
    const seen = new Set<string>();
    for (const name of focus.names) {
      if (seen.has(name)) continue;
      seen.add(name);
      const target = this.input.focusTargets?.get(name) ?? null;
      const nodeId = target ? this.ensureFocusNode(target, turn) : null;
      if (!nodeId) {
        this.unplaceable.push(name);
        continue;
      }
      if (!nodeIds.includes(nodeId)) nodeIds.push(nodeId);
      if (focus.primary !== null && name === focus.primary) primaryNodeId = nodeId;
    }
    this.focusResult = { nodeIds, primaryNodeId: primaryNodeId ?? nodeIds[0] ?? null };
  }

  private focusPlacement(turn: BoardPlannerTurn | null): { parentId?: string; placement?: BoardPlacement } {
    if (turn) {
      const entry = this.ledger.turns[turn.messageId];
      const group = this.node(entry?.groupId);
      if (group?.kind === 'group') return { parentId: group.id };
      const first = Object.values(entry?.placed ?? {}).map((id) => this.node(id)).find(Boolean);
      if (first) return { placement: { mode: 'near', nodeId: this.topLevelOf(first.id), side: 'right' } };
    }
    const near = this.input.focus?.near;
    if (near) return { placement: { mode: 'viewport', centerX: near.x, centerY: near.y } };
    return { placement: { mode: 'auto' } };
  }

  private ensureFocusNode(target: BoardFocusTarget, turn: BoardPlannerTurn | null): string | null {
    const origin: BoardNodeOrigin = turn ? this.turnOrigin(turn) : { source: 'user' };
    if (target.kind === 'live') {
      const existing = this.node(this.index.liveFrames.get(target.liveArtifactId));
      if (existing) {
        this.place(existing.id, 'existing', { liveArtifactId: target.liveArtifactId });
        return existing.id;
      }
      const id = this.allocateId(`live:${target.liveArtifactId}`);
      const size = defaultBoardNodeSize('frame', { device: 'desktop' });
      const draft = { id, kind: 'frame', ref: null, liveArtifactId: target.liveArtifactId, device: 'desktop', w: size.w, h: size.h, origin } as NodeDraft;
      if (!this.apply([this.addOp(draft, this.focusPlacement(turn))], `P5 live ${target.liveArtifactId}`)) return null;
      if (!this.index.byId.has(id)) return null;
      this.created.add(id);
      this.place(id, 'created', { liveArtifactId: target.liveArtifactId });
      this.recordFocusPlacement(turn, `live:${target.liveArtifactId}`, id);
      return id;
    }
    const path = target.path;
    delete this.ledger.dismissed[path];
    const kind = boardKindForPath(path);
    if (!kind) return null;
    if (isBoardMovieDocumentPath(path) && this.index.movieNodeId) {
      this.place(this.index.movieNodeId, 'existing', { path });
      return this.index.movieNodeId;
    }
    const existing = this.nodeForFile(path);
    if (existing) {
      this.place(existing.id, 'existing', { path });
      return existing.id;
    }
    const draft = this.fileDraft(path, kind, origin, { withCover: kind === 'frame' || kind === 'video' });
    if (!this.apply([this.addOp(draft.draft, this.focusPlacement(turn))], `P5 focus ${path}`)) return null;
    if (!this.index.byId.has(draft.id)) return null;
    this.markCreated([draft]);
    this.recordFocusPlacement(turn, path, draft.id);
    return draft.id;
  }

  private recordFocusPlacement(turn: BoardPlannerTurn | null, key: string, nodeId: string): void {
    if (!turn) return;
    const entry = this.ledger.turns[turn.messageId];
    if (entry) {
      entry.placed[key] = nodeId;
      return;
    }
    this.ledger.turns[turn.messageId] = {
      conversationId: turn.conversationId,
      status: turn.terminal ? 'terminal' : 'running',
      placed: { [key]: nodeId },
      updatedAt: this.input.now,
    };
  }

  // ---- P6 + result ------------------------------------------------------------------------------------

  private result(): BoardSyncPlan {
    const placements = [...this.placements.values()].map((placement) => {
      const { groupId: _previous, ...rest } = placement;
      if (placement.status === 'removed') return rest;
      const node = this.node(placement.nodeId);
      if (!node) return { ...rest, status: 'removed' as const };
      return node.parentId ? { ...rest, groupId: node.parentId } : rest;
    });
    return {
      ops: this.ops,
      ledger: trimBoardSyncLedger(this.ledger),
      placements,
      focus: this.focusResult,
      unplaceable: this.unplaceable,
      rejected: this.rejected,
    };
  }
}

/** Plans one chat sync (rules P1–P6 of spec 04 §4.5). Pure and deterministic. */
export function planBoardSync(input: BoardPlannerInput): BoardSyncPlan {
  return new BoardSyncPlanner(input).run();
}
