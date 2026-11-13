// SPDX-License-Identifier: Apache-2.0
// Board persistence (spec 04 §4.2): one fork-owned row per project in the daemon DB handle (`ctx.db`, i.e.
// `<RUNTIME_DATA_DIR>/app.sqlite`), deleted with its project (FK cascade). Board data never goes into the project
// folder. `commitBoard` runs inside the caller's `db.transaction` (read, pure apply and write with no `await`).
//
// B13 (amendments): the store stamps `createdAt` monotonically per board — the k-th entity a batch creates gets
// `max(clock, watermark + 1) + k` — so node/edge order (and a generator's reference order) never ties on random ids.
import type Database from 'better-sqlite3';
import {
  BOARD_SCHEMA_VERSION,
  compareBoardEdges,
  defaultBoardSettings,
  emptyBoardDocument,
  emptyBoardSyncLedger,
  type BoardActor,
  type BoardChangeSet,
  type BoardContent,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
  type BoardOp,
  type BoardOpResult,
  type BoardPage,
  type BoardSettings,
  type BoardSyncLedger,
  type BoardTurnLedgerEntry,
  type BoardViewport,
} from '@open-design/contracts';

type SqliteDb = Database.Database;

export class BoardRevisionMismatchError extends Error {
  readonly projectId: string;
  readonly expected: number;
  readonly actual: number;

  constructor(projectId: string, expected: number, actual: number) {
    super(`board revision mismatch for ${projectId}: expected ${expected}, found ${actual}`);
    this.name = 'BoardRevisionMismatchError';
    this.projectId = projectId;
    this.expected = expected;
    this.actual = actual;
  }
}

/** A stored row that cannot be parsed. Reads fail loudly instead of silently replacing the stored board. */
export class BoardStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoardStorageError';
  }
}

export interface BoardRow {
  projectId: string;
  revision: number;
  schemaVersion: number;
  content: BoardContent;
  /** Document `updatedAt` / `updatedBy` of the last committed revision (0 / null before the first commit). */
  updatedAt: number;
  updatedBy: BoardActor | null;
  /** B13 watermark: the highest `createdAt` this board ever stamped (survives deletions). */
  lastCreatedAt: number;
  ledger: BoardSyncLedger;
  viewport: BoardViewport | null;
  /** Page of the last saved camera (the page the user is on); agents and sync place new nodes there. */
  activePageId: string | null;
  pageViewports: Record<string, BoardViewport>;
}

export function migrateBoardTables(db: SqliteDb): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS fantay_boards (
      project_id     TEXT PRIMARY KEY,
      revision       INTEGER NOT NULL,
      schema_version INTEGER NOT NULL,
      content_json   TEXT NOT NULL,
      sync_json      TEXT NOT NULL,
      viewport_json  TEXT,
      updated_at     INTEGER NOT NULL,
      FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
  `);
}

// ---- parsing ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseJson(text: unknown, what: string, projectId: string): unknown {
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BoardStorageError(`stored board ${what} for project ${projectId} is not valid JSON`);
  }
}

function parseSettings(value: unknown): BoardSettings {
  const settings = defaultBoardSettings();
  if (!isRecord(value)) return settings;
  if (value.background === 'dots' || value.background === 'lines' || value.background === 'blank') {
    settings.background = value.background;
  }
  if (typeof value.autoPlace === 'boolean') settings.autoPlace = value.autoPlace;
  return settings;
}

function parseActor(value: unknown): BoardActor | null {
  if (!isRecord(value) || typeof value.kind !== 'string') return null;
  return {
    kind: value.kind as BoardActor['kind'],
    ...(typeof value.clientId === 'string' ? { clientId: value.clientId } : {}),
    ...(typeof value.runId === 'string' ? { runId: value.runId } : {}),
  };
}

function parsePages(value: unknown): BoardPage[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const pages = value.filter((page): page is BoardPage => isRecord(page) && typeof page.id === 'string' && typeof page.title === 'string');
  return pages.length > 0 ? pages : undefined;
}

function parseStoredContent(raw: unknown): Pick<BoardRow, 'content' | 'updatedAt' | 'updatedBy' | 'lastCreatedAt'> {
  const record = isRecord(raw) ? raw : {};
  const pages = parsePages(record.pages);
  const content: BoardContent = {
    ...(typeof record.title === 'string' ? { title: record.title } : {}),
    settings: parseSettings(record.settings),
    ...(pages ? { pages } : {}),
    nodes: Array.isArray(record.nodes) ? (record.nodes as BoardNode[]) : [],
    edges: Array.isArray(record.edges) ? (record.edges as BoardEdge[]) : [],
  };
  return {
    content,
    updatedAt: finiteNumber(record.updatedAt, 0),
    updatedBy: parseActor(record.updatedBy),
    lastCreatedAt: finiteNumber(record.lastCreatedAt, 0),
  };
}

function numberRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'number' && Number.isFinite(entry)) out[key] = entry;
  }
  return out;
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!isRecord(value)) return out;
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string') out[key] = entry;
  }
  return out;
}

function parseTurns(value: unknown): Record<string, BoardTurnLedgerEntry> {
  const out: Record<string, BoardTurnLedgerEntry> = {};
  if (!isRecord(value)) return out;
  for (const [messageId, entry] of Object.entries(value)) {
    if (!isRecord(entry) || typeof entry.conversationId !== 'string') continue;
    out[messageId] = {
      conversationId: entry.conversationId,
      status: entry.status === 'terminal' ? 'terminal' : 'running',
      ...(typeof entry.groupId === 'string' ? { groupId: entry.groupId } : {}),
      placed: stringRecord(entry.placed),
      updatedAt: finiteNumber(entry.updatedAt, 0),
    };
  }
  return out;
}

/** Tolerant ledger reader: unknown or damaged parts fall back to the empty ledger's values. */
export function parseBoardLedger(raw: unknown): BoardSyncLedger {
  if (!isRecord(raw) || raw.version !== 1) return emptyBoardSyncLedger();
  return {
    version: 1,
    seededAt: typeof raw.seededAt === 'number' && Number.isFinite(raw.seededAt) ? raw.seededAt : null,
    cursor: finiteNumber(raw.cursor, 0),
    turns: parseTurns(raw.turns),
    mediaTasks: stringRecord(raw.mediaTasks),
    dismissed: numberRecord(raw.dismissed),
  };
}

function parseViewport(raw: unknown): BoardViewport | null {
  if (!isRecord(raw)) return null;
  const { centerX, centerY, zoom } = raw;
  if (typeof centerX !== 'number' || typeof centerY !== 'number' || typeof zoom !== 'number') return null;
  if (!Number.isFinite(centerX) || !Number.isFinite(centerY) || !Number.isFinite(zoom)) return null;
  return { centerX, centerY, zoom };
}

function parsePageViewports(raw: unknown): Record<string, BoardViewport> {
  const out: Record<string, BoardViewport> = {};
  if (!isRecord(raw) || !isRecord(raw.pages)) return out;
  for (const [pageId, entry] of Object.entries(raw.pages)) {
    const viewport = parseViewport(entry);
    if (viewport) out[pageId] = viewport;
  }
  return out;
}

interface RawBoardRow {
  projectId: string;
  revision: number;
  schemaVersion: number;
  contentJson: string;
  syncJson: string;
  viewportJson: string | null;
}

// ---- reads ---------------------------------------------------------------------------

export function readBoardRow(db: SqliteDb, projectId: string): BoardRow | null {
  const raw = db
    .prepare(
      `SELECT project_id AS projectId, revision, schema_version AS schemaVersion,
              content_json AS contentJson, sync_json AS syncJson, viewport_json AS viewportJson
         FROM fantay_boards WHERE project_id = ?`,
    )
    .get(projectId) as RawBoardRow | undefined;
  if (!raw) return null;
  const stored = parseStoredContent(parseJson(raw.contentJson, 'content', projectId));
  const viewport = parseJson(raw.viewportJson, 'viewport', projectId);
  return {
    projectId: raw.projectId,
    revision: raw.revision,
    schemaVersion: raw.schemaVersion,
    ...stored,
    ledger: parseBoardLedger(parseJson(raw.syncJson, 'sync ledger', projectId)),
    viewport: parseViewport(viewport),
    activePageId: isRecord(viewport) && typeof viewport.pageId === 'string' ? viewport.pageId : null,
    pageViewports: parsePageViewports(viewport),
  };
}

/** The stored board as a `BoardDocument`; a project without a row reads as `emptyBoardDocument` (revision 0). */
export function readBoardDocument(
  db: SqliteDb,
  projectId: string,
  opts: { includeSync?: boolean } = {},
): BoardDocument {
  const row = readBoardRow(db, projectId);
  if (!row) {
    const empty = emptyBoardDocument(projectId);
    return opts.includeSync ? { ...empty, sync: emptyBoardSyncLedger() } : empty;
  }
  return boardDocumentFromRow(row, opts);
}

export function boardDocumentFromRow(row: BoardRow, opts: { includeSync?: boolean } = {}): BoardDocument {
  return {
    schemaVersion: BOARD_SCHEMA_VERSION,
    projectId: row.projectId,
    revision: row.revision,
    ...(row.content.title !== undefined ? { title: row.content.title } : {}),
    settings: row.content.settings,
    ...(row.content.pages ? { pages: row.content.pages } : {}),
    nodes: row.content.nodes,
    edges: row.content.edges,
    updatedAt: row.updatedAt,
    updatedBy: row.updatedBy,
    viewport: row.viewport,
    ...(row.activePageId ? { activePageId: row.activePageId } : {}),
    ...(Object.keys(row.pageViewports).length > 0 ? { pageViewports: row.pageViewports } : {}),
    ...(opts.includeSync ? { sync: row.ledger } : {}),
  };
}

export function readBoardLedger(db: SqliteDb, projectId: string): BoardSyncLedger {
  return readBoardRow(db, projectId)?.ledger ?? emptyBoardSyncLedger();
}

// ---- writes ---------------------------------------------------------------------------

function contentJson(content: BoardContent, updatedAt: number, updatedBy: BoardActor | null, lastCreatedAt: number): string {
  return JSON.stringify({
    ...(content.title !== undefined ? { title: content.title } : {}),
    settings: content.settings,
    ...(content.pages ? { pages: content.pages } : {}),
    nodes: content.nodes,
    edges: content.edges,
    updatedAt,
    updatedBy,
    lastCreatedAt,
  });
}

export interface CommitBoardInput {
  projectId: string;
  expectedRevision: number;
  content: BoardContent;
  ledger: BoardSyncLedger;
  now: number;
  actor: BoardActor;
  /** B13 watermark after this batch; never lowered below the content's own highest `createdAt`. */
  lastCreatedAt?: number;
}

/**
 * Writes `content` + `ledger` as revision `expectedRevision + 1`. Throws `BoardRevisionMismatchError` when the
 * stored revision (0 for a missing row) differs from `expectedRevision`. The viewport is left untouched.
 */
export function commitBoard(db: SqliteDb, input: CommitBoardInput): number {
  const current = db
    .prepare('SELECT revision FROM fantay_boards WHERE project_id = ?')
    .get(input.projectId) as { revision: number } | undefined;
  const actual = current?.revision ?? 0;
  if (actual !== input.expectedRevision) {
    throw new BoardRevisionMismatchError(input.projectId, input.expectedRevision, actual);
  }
  const revision = input.expectedRevision + 1;
  const lastCreatedAt = Math.max(input.lastCreatedAt ?? 0, maxBoardCreatedAt(input.content));
  db.prepare(
    `INSERT INTO fantay_boards
       (project_id, revision, schema_version, content_json, sync_json, viewport_json, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?)
     ON CONFLICT(project_id) DO UPDATE SET
       revision = excluded.revision,
       schema_version = excluded.schema_version,
       content_json = excluded.content_json,
       sync_json = excluded.sync_json,
       updated_at = excluded.updated_at`,
  ).run(
    input.projectId,
    revision,
    BOARD_SCHEMA_VERSION,
    contentJson(input.content, input.now, input.actor, lastCreatedAt),
    JSON.stringify(input.ledger),
    input.now,
  );
  return revision;
}

function insertEmptyRowSql(column: 'viewport_json' | 'sync_json'): string {
  return `INSERT INTO fantay_boards
            (project_id, revision, schema_version, content_json, sync_json, viewport_json, updated_at)
          VALUES (?, 0, ?, ?, ?, ?, 0)
          ON CONFLICT(project_id) DO UPDATE SET ${column} = excluded.${column}`;
}

function emptyContentJson(): string {
  return contentJson({ settings: defaultBoardSettings(), nodes: [], edges: [] }, 0, null, 0);
}

/**
 * Saves the camera without touching `revision` or `content_json`; a missing row is created at revision 0. With
 * `pageId` the camera also becomes that page's, and that page the active one.
 */
export function writeBoardViewport(db: SqliteDb, projectId: string, viewport: BoardViewport, _now: number, pageId?: string): void {
  const camera = { centerX: viewport.centerX, centerY: viewport.centerY, zoom: viewport.zoom };
  const row = pageId ? readBoardRow(db, projectId) : null;
  db.prepare(insertEmptyRowSql('viewport_json')).run(
    projectId,
    BOARD_SCHEMA_VERSION,
    emptyContentJson(),
    JSON.stringify(emptyBoardSyncLedger()),
    JSON.stringify(pageId ? { ...camera, pageId, pages: { ...row?.pageViewports, [pageId]: camera } } : camera),
  );
}

/** Saves the sync ledger without touching `revision` or `content_json`; a missing row is created at revision 0. */
export function writeBoardLedger(db: SqliteDb, projectId: string, ledger: BoardSyncLedger): void {
  db.prepare(insertEmptyRowSql('sync_json')).run(
    projectId,
    BOARD_SCHEMA_VERSION,
    emptyContentJson(),
    JSON.stringify(ledger),
    null,
  );
}

// ---- B13: monotonic createdAt ---------------------------------------------------------------

/** Highest `createdAt` over the board's nodes and edges (0 when empty). */
export function maxBoardCreatedAt(content: BoardContent): number {
  let max = 0;
  for (const node of content.nodes) if (typeof node.createdAt === 'number' && node.createdAt > max) max = node.createdAt;
  for (const edge of content.edges) if (typeof edge.createdAt === 'number' && edge.createdAt > max) max = edge.createdAt;
  return max;
}

/** The value every new `createdAt` must exceed: the stored watermark or the board's highest `createdAt`. */
export function boardCreatedAtWatermark(row: Pick<BoardRow, 'content' | 'lastCreatedAt'> | null): number {
  if (!row) return 0;
  return Math.max(row.lastCreatedAt, maxBoardCreatedAt(row.content));
}

/**
 * Ids that a batch created through `add`, `connect` or `group`, in op order. Entities brought back by `restore`
 * keep the `createdAt` of their snapshot, so they are not listed.
 */
export function createdIdsInOpOrder(
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

export interface MonotonicCreatedAtInput {
  content: BoardContent;
  changes?: BoardChangeSet | null;
  /** Created entity ids (nodes and edges) in creation order. */
  createdIds: readonly string[];
  watermark: number;
  clock: number;
}

export interface MonotonicCreatedAtResult {
  content: BoardContent;
  changes: BoardChangeSet | null;
  /** New watermark, or null when nothing was created. */
  lastCreatedAt: number | null;
}

/**
 * Gives the k-th created entity `createdAt = max(clock, watermark + 1) + k` (nodes also get
 * `updatedAt = max(updatedAt, createdAt)`), then re-sorts the edges canonically (createdAt, then id) in both the
 * content and the change set. Unchanged entities keep their object identity.
 */
export function stampMonotonicCreatedAt(input: MonotonicCreatedAtInput): MonotonicCreatedAtResult {
  const changes = input.changes ?? null;
  if (input.createdIds.length === 0) return { content: input.content, changes, lastCreatedAt: null };
  const base = Math.max(input.clock, input.watermark + 1);
  const stamps = new Map<string, number>();
  input.createdIds.forEach((id, index) => stamps.set(id, base + index));
  const restampNode = (node: BoardNode): BoardNode => {
    const createdAt = stamps.get(node.id);
    if (createdAt === undefined) return node;
    return { ...node, createdAt, updatedAt: Math.max(node.updatedAt, createdAt) } as BoardNode;
  };
  const restampEdge = (edge: BoardEdge): BoardEdge => {
    const createdAt = stamps.get(edge.id);
    return createdAt === undefined ? edge : { ...edge, createdAt };
  };
  const content: BoardContent = {
    ...input.content,
    nodes: input.content.nodes.map(restampNode),
    edges: input.content.edges.map(restampEdge).sort(compareBoardEdges),
  };
  const nextChanges: BoardChangeSet | null = changes
    ? {
        ...changes,
        upsertNodes: changes.upsertNodes.map(restampNode),
        upsertEdges: changes.upsertEdges.map(restampEdge).sort(compareBoardEdges),
      }
    : null;
  return { content, changes: nextChanges, lastCreatedAt: base + input.createdIds.length - 1 };
}
