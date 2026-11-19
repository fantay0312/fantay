// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — the ledger: item heads, immutable versions, events, links, conflicts, raw windows, meta.
//
// The truth tables (mem_items, mem_versions, mem_events, mem_links, mem_conflicts) only grow: rows are inserted
// and item heads are updated in place, but nothing here removes a row from them. The single exception to
// "versions are immutable" is `redact`, which only the owner may call.

import { randomUUID } from "node:crypto";
import type BetterSqlite3 from "better-sqlite3";
import {
  memoryScopeKey,
  type MemoryConflictResolution,
  type MemoryEvent,
  type MemoryEventType,
  type MemoryItemStatus,
  type MemoryItemVersion,
  type MemoryLink,
  type MemoryLinkRelation,
  type MemoryScopeCounts,
  type MemoryScopeRef,
} from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import { ensureMemorySchema } from "./schema.js";
import { contentHash } from "./text.js";
import {
  MemoryError,
  type ItemFilter,
  type MemoryActor,
  type MemoryChunkRow,
  type MemoryConflictRow,
  type MemoryItemRow,
  type MemoryStoreApi,
  type NewItemRow,
  type WriteWindowsInput,
} from "./types.js";

type Statement = BetterSqlite3.Statement<unknown[], unknown>;

/** Rows kept in mem_recall_log. */
const RECALL_LOG_KEEP = 500;

/** Scope keys are `<kind>:<id>`; kinds never contain a colon, so the first one separates them. */
const SCOPE_KEYS_MATCH =
  "(scope_kind, scope_id) IN (SELECT substr(value, 1, instr(value, ':') - 1), substr(value, instr(value, ':') + 1) FROM json_each(?))";

const ITEM_ORDER: Record<NonNullable<ItemFilter["order"]>, string> = {
  updated_desc: "updated_at DESC, rowid DESC",
  created_desc: "created_at DESC, rowid DESC",
  created_asc: "created_at ASC, rowid ASC",
};

interface ItemSqlRow {
  id: string;
  scope_kind: string;
  scope_id: string;
  principal_id: string;
  kind: string;
  status: string;
  origin: string;
  pinned: number;
  data_class: string;
  title: string;
  content: string;
  content_hash: string;
  source: string;
  source_refs: string;
  via: string | null;
  author_id: string | null;
  event_at: number | null;
  due_at: number | null;
  valid_from: number | null;
  valid_until: number | null;
  superseded_by: string | null;
  revision: number;
  content_revision: number;
  version_count: number;
  redacted: number;
  created_at: number;
  updated_at: number;
}

interface ConflictSqlRow {
  id: string;
  kind: string;
  scope_kind: string;
  scope_id: string;
  incoming_id: string;
  existing_id: string;
  reason: string;
  detector: string;
  confidence: number;
  suggestion: string | null;
  status: string;
  resolution: string | null;
  merged_item_id: string | null;
  created_at: number;
  resolved_at: number | null;
  resolved_by: string | null;
}

interface ChunkSqlRow {
  id: string;
  source: string;
  conversation_id: string;
  seq: number;
  content: string;
  content_hash: string;
  speakers: string;
  message_ids: string;
  start_at: number;
  end_at: number;
  data_class: string;
  principal_id: string;
  open: number;
  created_at: number;
  updated_at: number;
}

interface VersionSqlRow {
  version: number;
  title: string;
  content: string;
  actor: string;
  note: string;
  created_at: number;
}

interface EventSqlRow {
  seq: number;
  item_id: string | null;
  conflict_id: string | null;
  type: string;
  actor: string;
  at: number;
  data: string;
}

interface LinkSqlRow {
  from_id: string;
  to_id: string;
  relation: string;
  created_at: number;
}

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function parseArray<T>(text: string | null): T[] {
  const value = parseJson<unknown>(text, []);
  return Array.isArray(value) ? (value as T[]) : [];
}

function parseObject<T extends object>(text: string | null): T | null {
  const value = parseJson<unknown>(text, null);
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

function normalizeScope(scope: MemoryScopeRef): MemoryScopeRef {
  return { kind: scope.kind, id: scope.kind === "profile" ? "" : scope.id };
}

export function chunkIdOf(source: "pa" | "studio", conversationId: string, seq: number): string {
  return `${source}:${conversationId}:${seq}`;
}

export function conflictPairKey(a: string, b: string): string {
  return [a, b].sort().join("|");
}

function toItemRow(row: ItemSqlRow): MemoryItemRow {
  return {
    id: row.id,
    scopeKind: row.scope_kind as MemoryItemRow["scopeKind"],
    scopeId: row.scope_id,
    principalId: row.principal_id,
    kind: row.kind as MemoryItemRow["kind"],
    status: row.status as MemoryItemStatus,
    origin: row.origin as MemoryItemRow["origin"],
    pinned: row.pinned === 1,
    dataClass: row.data_class as MemoryItemRow["dataClass"],
    title: row.title,
    content: row.content,
    contentHash: row.content_hash,
    source: row.source,
    sourceRefs: parseArray(row.source_refs),
    via: parseObject(row.via),
    authorId: row.author_id,
    eventAt: row.event_at,
    dueAt: row.due_at,
    validFrom: row.valid_from,
    validUntil: row.valid_until,
    supersededBy: row.superseded_by,
    revision: row.revision,
    contentRevision: row.content_revision,
    versionCount: row.version_count,
    redacted: row.redacted === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function itemParams(row: MemoryItemRow): Record<string, unknown> {
  return {
    id: row.id,
    scope_kind: row.scopeKind,
    scope_id: row.scopeId,
    principal_id: row.principalId,
    kind: row.kind,
    status: row.status,
    origin: row.origin,
    pinned: row.pinned ? 1 : 0,
    data_class: row.dataClass,
    title: row.title,
    content: row.content,
    content_hash: row.contentHash,
    source: row.source,
    source_refs: JSON.stringify(row.sourceRefs),
    via: row.via ? JSON.stringify(row.via) : null,
    author_id: row.authorId,
    event_at: row.eventAt,
    due_at: row.dueAt,
    valid_from: row.validFrom,
    valid_until: row.validUntil,
    superseded_by: row.supersededBy,
    revision: row.revision,
    content_revision: row.contentRevision,
    version_count: row.versionCount,
    redacted: row.redacted ? 1 : 0,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function toConflictRow(row: ConflictSqlRow): MemoryConflictRow {
  return {
    id: row.id,
    kind: row.kind as MemoryConflictRow["kind"],
    scopeKind: row.scope_kind as MemoryConflictRow["scopeKind"],
    scopeId: row.scope_id,
    incomingId: row.incoming_id,
    existingId: row.existing_id,
    reason: row.reason,
    detector: row.detector as MemoryConflictRow["detector"],
    confidence: row.confidence,
    suggestion: row.suggestion as MemoryConflictResolution | null,
    status: row.status as MemoryConflictRow["status"],
    resolution: row.resolution as MemoryConflictResolution | null,
    mergedItemId: row.merged_item_id,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
    resolvedBy: row.resolved_by,
  };
}

function toChunkRow(row: ChunkSqlRow): MemoryChunkRow {
  return {
    id: row.id,
    source: row.source as MemoryChunkRow["source"],
    conversationId: row.conversation_id,
    seq: row.seq,
    content: row.content,
    contentHash: row.content_hash,
    speakers: parseArray(row.speakers),
    messageIds: parseArray(row.message_ids),
    startAt: row.start_at,
    endAt: row.end_at,
    dataClass: row.data_class as MemoryChunkRow["dataClass"],
    principalId: row.principal_id,
    open: row.open === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toVersion(row: VersionSqlRow): MemoryItemVersion {
  return {
    version: row.version,
    title: row.title,
    content: row.content,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
  };
}

function toEvent(row: EventSqlRow): MemoryEvent {
  return {
    seq: row.seq,
    itemId: row.item_id,
    conflictId: row.conflict_id,
    type: row.type as MemoryEventType,
    actor: row.actor,
    at: row.at,
    data: parseObject<Record<string, unknown>>(row.data) ?? {},
  };
}

function toLink(row: LinkSqlRow): MemoryLink {
  return {
    fromId: row.from_id,
    toId: row.to_id,
    relation: row.relation as MemoryLinkRelation,
    createdAt: row.created_at,
  };
}

function emptyCounts(): MemoryScopeCounts {
  return { active: 0, pending: 0, conflicts: 0, archived: 0, chunks: 0 };
}

/** Nearest-rank percentile over ascending values. */
function percentile(sorted: readonly number[], p: number): number {
  const rank = Math.max(1, Math.ceil(p * sorted.length));
  return sorted[Math.min(sorted.length, rank) - 1] ?? 0;
}

function prepareStatements(db: SqliteDb) {
  const prepare = (sql: string): Statement => db.prepare(sql);
  return {
    insertItem: prepare(`
      INSERT INTO mem_items (id, scope_kind, scope_id, principal_id, kind, status, origin, pinned, data_class, title,
        content, content_hash, source, source_refs, via, author_id, event_at, due_at, valid_from, valid_until,
        superseded_by, revision, content_revision, version_count, redacted, created_at, updated_at)
      VALUES (@id, @scope_kind, @scope_id, @principal_id, @kind, @status, @origin, @pinned, @data_class, @title,
        @content, @content_hash, @source, @source_refs, @via, @author_id, @event_at, @due_at, @valid_from,
        @valid_until, @superseded_by, @revision, @content_revision, @version_count, @redacted, @created_at,
        @updated_at)`),
    getItem: prepare("SELECT * FROM mem_items WHERE id = ?"),
    getItems: prepare("SELECT * FROM mem_items WHERE id IN (SELECT value FROM json_each(?))"),
    findByHash: prepare(`
      SELECT * FROM mem_items
      WHERE scope_kind = ? AND scope_id = ? AND content_hash = ? AND principal_id = ?
      ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END, updated_at DESC
      LIMIT 1`),
    updateText: prepare(`
      UPDATE mem_items SET title = @title, content = @content, content_hash = @content_hash,
        version_count = @version_count, revision = @revision, content_revision = @revision, updated_at = @at
      WHERE id = @id`),
    updateStatus: prepare(
      "UPDATE mem_items SET status = ?, superseded_by = ?, revision = ?, updated_at = ? WHERE id = ?",
    ),
    updatePinned: prepare("UPDATE mem_items SET pinned = ?, revision = ?, updated_at = ? WHERE id = ?"),
    updateMeta: prepare(`
      UPDATE mem_items SET kind = @kind, due_at = @due_at, valid_from = @valid_from, valid_until = @valid_until,
        revision = @revision, updated_at = @at
      WHERE id = @id`),
    redactItem: prepare(`
      UPDATE mem_items SET title = '', content = '', content_hash = '', redacted = 1, source_refs = @source_refs,
        revision = @revision, content_revision = @revision, updated_at = @at
      WHERE id = @id`),
    // A model judge writes its reason in its own words and may quote either memory; the built-in rules use
    // fixed sentences. Clearing a memory clears the judge's sentences about it.
    redactConflictReasons: prepare(
      "UPDATE mem_conflicts SET reason = '' WHERE (incoming_id = ? OR existing_id = ?) AND detector = 'judge' AND reason <> ''",
    ),
    // The only statement that rewrites stored versions; reached from `redact` with actor `owner` alone.
    redactVersions: prepare("UPDATE mem_versions SET title = '', content = '', content_hash = '' WHERE item_id = ?"),
    insertVersion: prepare(`
      INSERT INTO mem_versions (item_id, version, title, content, content_hash, actor, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
    versions: prepare(
      "SELECT version, title, content, actor, note, created_at FROM mem_versions WHERE item_id = ? ORDER BY version",
    ),
    insertEvent: prepare(
      "INSERT INTO mem_events (item_id, conflict_id, type, actor, at, data) VALUES (?, ?, ?, ?, ?, ?)",
    ),
    events: prepare("SELECT * FROM mem_events WHERE item_id = ? ORDER BY seq"),
    links: prepare(`
      SELECT * FROM mem_links WHERE from_id = ?
      UNION SELECT * FROM mem_links WHERE to_id = ?
      ORDER BY created_at, from_id, to_id`),
    addLink: prepare(
      "INSERT INTO mem_links (from_id, to_id, relation, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING",
    ),
    insertConflict: prepare(`
      INSERT INTO mem_conflicts (id, kind, scope_kind, scope_id, incoming_id, existing_id, pair_key, reason, detector,
        confidence, suggestion, status, created_at)
      VALUES (@id, @kind, @scope_kind, @scope_id, @incoming_id, @existing_id, @pair_key, @reason, @detector,
        @confidence, @suggestion, 'open', @created_at)
      ON CONFLICT(pair_key) DO NOTHING`),
    getConflict: prepare("SELECT * FROM mem_conflicts WHERE id = ?"),
    closeConflict: prepare(`
      UPDATE mem_conflicts SET status = 'resolved', resolution = ?, merged_item_id = ?, resolved_at = ?, resolved_by = ?
      WHERE id = ? AND status = 'open'`),
    openConflictIds: prepare(`
      SELECT id, incoming_id, existing_id FROM mem_conflicts
      WHERE status = 'open'
        AND (incoming_id IN (SELECT value FROM json_each(?)) OR existing_id IN (SELECT value FROM json_each(?)))
      ORDER BY created_at`),
    itemCounts: prepare(`
      SELECT scope_kind, scope_id, status, COUNT(*) AS n FROM mem_items
      GROUP BY scope_kind, scope_id, status`),
    itemCountsFor: prepare(`
      SELECT scope_kind, scope_id, status, COUNT(*) AS n FROM mem_items WHERE principal_id = ?
      GROUP BY scope_kind, scope_id, status`),
    conflictCounts: prepare(`
      SELECT scope_kind, scope_id, COUNT(*) AS n FROM mem_conflicts WHERE status = 'open'
      GROUP BY scope_kind, scope_id`),
    conflictCountsFor: prepare(`
      SELECT c.scope_kind, c.scope_id, COUNT(*) AS n FROM mem_conflicts c
      JOIN mem_items i ON i.id = c.incoming_id
      WHERE c.status = 'open' AND i.principal_id = ?
      GROUP BY c.scope_kind, c.scope_id`),
    cursor: prepare("SELECT message_count, prefix_hash FROM mem_cursors WHERE source = ? AND conversation_id = ?"),
    upsertCursor: prepare(`
      INSERT INTO mem_cursors (source, conversation_id, message_count, prefix_hash, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(source, conversation_id) DO UPDATE SET message_count = excluded.message_count,
        prefix_hash = excluded.prefix_hash, updated_at = excluded.updated_at`),
    chunkIdsFrom: prepare("SELECT id FROM mem_chunks WHERE source = ? AND conversation_id = ? AND seq >= ?").pluck(),
    upsertChunk: prepare(`
      INSERT INTO mem_chunks (id, source, conversation_id, seq, content, content_hash, speakers, message_ids, start_at,
        end_at, data_class, principal_id, open, created_at, updated_at)
      VALUES (@id, @source, @conversation_id, @seq, @content, @content_hash, @speakers, @message_ids, @start_at,
        @end_at, @data_class, @principal_id, @open, @at, @at)
      ON CONFLICT(id) DO UPDATE SET content = excluded.content, content_hash = excluded.content_hash,
        speakers = excluded.speakers, message_ids = excluded.message_ids, start_at = excluded.start_at,
        end_at = excluded.end_at, data_class = excluded.data_class, principal_id = excluded.principal_id,
        open = excluded.open, updated_at = excluded.updated_at
      RETURNING *`),
    // mem_chunks is a projection of the stored conversation; replaced windows may be removed.
    removeChunk: prepare("DELETE FROM mem_chunks WHERE id = ?"),
    getChunk: prepare("SELECT * FROM mem_chunks WHERE id = ?"),
    getChunks: prepare("SELECT * FROM mem_chunks WHERE id IN (SELECT value FROM json_each(?))"),
    neighbors: prepare(`
      SELECT * FROM mem_chunks
      WHERE source = ? AND conversation_id = ? AND seq BETWEEN ? AND ? AND seq <> ?
      ORDER BY seq`),
    getMeta: prepare("SELECT value FROM mem_meta WHERE key = ?"),
    setMeta: prepare(
      "INSERT INTO mem_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ),
    logRecall: prepare(`
      INSERT INTO mem_recall_log (at, surface, scope_keys, hit_count, injected_chars, level, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?)`),
    // mem_recall_log is bounded telemetry, not truth.
    trimRecallLog: prepare(`
      DELETE FROM mem_recall_log
      WHERE id < (SELECT id FROM mem_recall_log ORDER BY id DESC LIMIT 1 OFFSET ${RECALL_LOG_KEEP - 1})`),
    recallLatencies: prepare("SELECT latency_ms FROM mem_recall_log ORDER BY latency_ms").pluck(),
  };
}

export class MemoryStore implements MemoryStoreApi {
  readonly db: SqliteDb;
  private readonly now: () => number;
  private readonly sql: ReturnType<typeof prepareStatements>;
  /** Statements whose WHERE clause depends on which filters are set; one per distinct shape. */
  private readonly shaped = new Map<string, Statement>();
  private readonly inTransaction: (fn: () => unknown) => unknown;

  constructor(db: SqliteDb, now: () => number) {
    this.db = db;
    this.now = now;
    ensureMemorySchema(db);
    this.sql = prepareStatements(db);
    this.inTransaction = db.transaction((fn: () => unknown) => fn());
  }

  transaction<T>(fn: () => T): T {
    return this.inTransaction(fn) as T;
  }

  // ---- items -----------------------------------------------------------------------------------------------------

  /** `data` is stored on the creation event (e.g. where a copy came from). */
  insertItem(
    input: NewItemRow,
    actor: MemoryActor,
    eventType: MemoryEventType = "created",
    data: Record<string, unknown> = {},
  ): MemoryItemRow {
    const at = this.now();
    const scope = normalizeScope(input.scope);
    const revision = input.revision ?? 1;
    const createdAt = input.createdAt ?? at;
    const row: MemoryItemRow = {
      id: input.id ?? randomUUID(),
      scopeKind: scope.kind,
      scopeId: scope.id,
      principalId: input.principalId ?? "owner",
      kind: input.kind ?? "fact",
      status: input.status ?? "active",
      origin: input.origin ?? "user_explicit",
      pinned: input.pinned ?? false,
      dataClass: input.dataClass ?? "standard",
      title: input.title ?? "",
      content: input.content,
      contentHash: contentHash(input.content),
      source: input.source ?? "",
      sourceRefs: input.sourceRefs ?? [],
      via: input.via ?? null,
      authorId: input.authorId ?? null,
      eventAt: input.eventAt ?? null,
      dueAt: input.dueAt ?? null,
      validFrom: input.validFrom ?? null,
      validUntil: input.validUntil ?? null,
      supersededBy: null,
      revision,
      contentRevision: revision,
      versionCount: 1,
      redacted: false,
      createdAt,
      updatedAt: input.updatedAt ?? createdAt,
    };
    this.transaction(() => {
      this.sql.insertItem.run(itemParams(row));
      this.sql.insertVersion.run(row.id, 1, row.title, row.content, row.contentHash, actor, "", createdAt);
      this.insertEvent(row.id, null, eventType, actor, at, { status: row.status, ...data });
    });
    return row;
  }

  getItem(id: string): MemoryItemRow | null {
    const row = this.sql.getItem.get(id) as ItemSqlRow | undefined;
    return row ? toItemRow(row) : null;
  }

  /** In the order asked, without duplicates; missing ids are skipped. */
  getItems(ids: readonly string[]): MemoryItemRow[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const rows = this.sql.getItems.all(JSON.stringify(unique)) as ItemSqlRow[];
    const byId = new Map(rows.map((row) => [row.id, toItemRow(row)]));
    return unique.flatMap((id) => byId.get(id) ?? []);
  }

  listItems(filter: ItemFilter): { rows: MemoryItemRow[]; total: number } {
    const { where, params } = itemWhere(filter);
    const order = ITEM_ORDER[filter.order ?? "updated_desc"];
    const limit = filter.limit ?? -1;
    const offset = filter.offset ?? 0;
    const rows = (
      this.shapedStatement(`SELECT * FROM mem_items ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(
        ...params,
        limit,
        offset,
      ) as ItemSqlRow[]
    ).map(toItemRow);
    const total =
      limit < 0 && offset === 0
        ? rows.length
        : (this.shapedStatement(`SELECT COUNT(*) AS n FROM mem_items ${where}`).get(...params) as { n: number }).n;
    return { rows, total };
  }

  /** Prefers an active item, then a pending one, then the most recently changed. */
  findByHash(scope: MemoryScopeRef, hash: string, principalId: string): MemoryItemRow | null {
    const target = normalizeScope(scope);
    const row = this.sql.findByHash.get(target.kind, target.id, hash, principalId) as ItemSqlRow | undefined;
    return row ? toItemRow(row) : null;
  }

  appendVersion(
    id: string,
    input: { content: string; title?: string | undefined; actor: MemoryActor; note?: string | undefined },
  ): MemoryItemRow {
    return this.transaction(() => {
      const row = this.requireItem(id);
      const title = input.title ?? row.title;
      if (input.content === row.content && title === row.title) return row;
      const at = this.now();
      const version = row.versionCount + 1;
      const hash = contentHash(input.content);
      this.sql.insertVersion.run(id, version, title, input.content, hash, input.actor, input.note ?? "", at);
      this.sql.updateText.run({
        id,
        title,
        content: input.content,
        content_hash: hash,
        version_count: version,
        revision: row.revision + 1,
        at,
      });
      this.insertEvent(id, null, "revised", input.actor, at, {
        version,
        ...(input.note ? { note: input.note } : {}),
      });
      return this.requireItem(id);
    });
  }

  setStatus(
    id: string,
    status: MemoryItemStatus,
    input: {
      actor: MemoryActor;
      event: MemoryEventType;
      supersededBy?: string | null | undefined;
      data?: Record<string, unknown> | undefined;
    },
  ): MemoryItemRow {
    return this.transaction(() => {
      const row = this.requireItem(id);
      const supersededBy =
        input.supersededBy !== undefined ? input.supersededBy : status === "superseded" ? row.supersededBy : null;
      if (row.status === status && row.supersededBy === supersededBy) return row;
      const at = this.now();
      this.sql.updateStatus.run(status, supersededBy, row.revision + 1, at, id);
      this.insertEvent(id, null, input.event, input.actor, at, {
        from: row.status,
        to: status,
        ...(supersededBy ? { supersededBy } : {}),
        ...input.data,
      });
      return this.requireItem(id);
    });
  }

  setPinned(id: string, pinned: boolean, actor: MemoryActor): MemoryItemRow {
    return this.transaction(() => {
      const row = this.requireItem(id);
      if (row.pinned === pinned) return row;
      const at = this.now();
      this.sql.updatePinned.run(pinned ? 1 : 0, row.revision + 1, at, id);
      this.insertEvent(id, null, pinned ? "pinned" : "unpinned", actor, at, {});
      return this.requireItem(id);
    });
  }

  patchMeta(
    id: string,
    patch: {
      kind?: MemoryItemRow["kind"] | undefined;
      dueAt?: number | null | undefined;
      validFrom?: number | null | undefined;
      validUntil?: number | null | undefined;
    },
    actor: MemoryActor,
    note?: string,
  ): MemoryItemRow {
    return this.transaction(() => {
      const row = this.requireItem(id);
      const next = {
        kind: patch.kind ?? row.kind,
        dueAt: patch.dueAt !== undefined ? patch.dueAt : row.dueAt,
        validFrom: patch.validFrom !== undefined ? patch.validFrom : row.validFrom,
        validUntil: patch.validUntil !== undefined ? patch.validUntil : row.validUntil,
      };
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      for (const key of ["kind", "dueAt", "validFrom", "validUntil"] as const) {
        if (next[key] !== row[key]) changes[key] = { from: row[key], to: next[key] };
      }
      if (Object.keys(changes).length === 0) return row;
      const at = this.now();
      this.sql.updateMeta.run({
        id,
        kind: next.kind,
        due_at: next.dueAt,
        valid_from: next.validFrom,
        valid_until: next.validUntil,
        revision: row.revision + 1,
        at,
      });
      this.insertEvent(id, null, "meta_changed", actor, at, note ? { changes, note } : { changes });
      return this.requireItem(id);
    });
  }

  redact(id: string, actor: MemoryActor): MemoryItemRow {
    if (actor !== "owner") throw new MemoryError("MEMORY_FORBIDDEN", "Only the owner can redact a memory.", 403);
    return this.transaction(() => {
      const row = this.requireItem(id);
      const at = this.now();
      // Where the memory came from stays; the words quoted from there do not.
      const quotes = row.sourceRefs.filter((ref) => ref.quote !== undefined).length;
      const sourceRefs = row.sourceRefs.map(({ quote: _quote, ...where }) => where);
      this.sql.redactVersions.run(id);
      this.sql.redactItem.run({ id, revision: row.revision + 1, at, source_refs: JSON.stringify(sourceRefs) });
      const reasons = this.sql.redactConflictReasons.run(id, id).changes;
      this.insertEvent(id, null, "redacted", actor, at, { versions: row.versionCount, quotes, reasons });
      return this.requireItem(id);
    });
  }

  recordEvent(
    event: Omit<MemoryEvent, "seq" | "at" | "data"> & { data?: Record<string, unknown> | undefined },
  ): void {
    this.insertEvent(event.itemId, event.conflictId, event.type, event.actor, this.now(), event.data ?? {});
  }

  versions(id: string): MemoryItemVersion[] {
    return (this.sql.versions.all(id) as VersionSqlRow[]).map(toVersion);
  }

  events(id: string): MemoryEvent[] {
    return (this.sql.events.all(id) as EventSqlRow[]).map(toEvent);
  }

  links(id: string): MemoryLink[] {
    return (this.sql.links.all(id, id) as LinkSqlRow[]).map(toLink);
  }

  addLink(fromId: string, toId: string, relation: MemoryLinkRelation): void {
    this.sql.addLink.run(fromId, toId, relation, this.now());
  }

  // ---- conflicts -------------------------------------------------------------------------------------------------

  openConflict(input: {
    kind: MemoryConflictRow["kind"];
    scope: MemoryScopeRef;
    incomingId: string;
    existingId: string;
    reason: string;
    detector: MemoryConflictRow["detector"];
    confidence: number;
    suggestion?: MemoryConflictResolution | null | undefined;
  }): MemoryConflictRow | null {
    if (input.incomingId === input.existingId) return null;
    const scope = normalizeScope(input.scope);
    return this.transaction(() => {
      const id = randomUUID();
      const at = this.now();
      const inserted = this.sql.insertConflict.run({
        id,
        kind: input.kind,
        scope_kind: scope.kind,
        scope_id: scope.id,
        incoming_id: input.incomingId,
        existing_id: input.existingId,
        pair_key: conflictPairKey(input.incomingId, input.existingId),
        reason: input.reason,
        detector: input.detector,
        confidence: input.confidence,
        suggestion: input.suggestion ?? null,
        created_at: at,
      });
      if (inserted.changes === 0) return null;
      const data = { kind: input.kind, detector: input.detector };
      this.insertEvent(input.incomingId, id, "conflict_opened", "system", at, { ...data, with: input.existingId });
      this.insertEvent(input.existingId, id, "conflict_opened", "system", at, { ...data, with: input.incomingId });
      return this.requireConflict(id);
    });
  }

  getConflict(id: string): MemoryConflictRow | null {
    const row = this.sql.getConflict.get(id) as ConflictSqlRow | undefined;
    return row ? toConflictRow(row) : null;
  }

  listConflicts(filter: {
    status?: "open" | "resolved" | undefined;
    scopeKeys?: readonly string[] | undefined;
    itemId?: string | undefined;
    limit?: number | undefined;
  }): MemoryConflictRow[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.status) {
      where.push("status = ?");
      params.push(filter.status);
    }
    if (filter.scopeKeys) {
      where.push(SCOPE_KEYS_MATCH);
      params.push(JSON.stringify(filter.scopeKeys));
    }
    if (filter.itemId) {
      where.push("(incoming_id = ? OR existing_id = ?)");
      params.push(filter.itemId, filter.itemId);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const sql = `SELECT * FROM mem_conflicts ${clause} ORDER BY created_at DESC, rowid DESC LIMIT ?`;
    return (this.shapedStatement(sql).all(...params, filter.limit ?? -1) as ConflictSqlRow[]).map(toConflictRow);
  }

  closeConflict(
    id: string,
    input: { resolution: MemoryConflictResolution; mergedItemId?: string | null | undefined; actor: MemoryActor },
  ): MemoryConflictRow {
    return this.transaction(() => {
      const conflict = this.requireConflict(id);
      if (conflict.status === "resolved") {
        throw new MemoryError("MEMORY_CONFLICT_RESOLVED", "This conflict was already resolved.", 409);
      }
      const at = this.now();
      const mergedItemId = input.mergedItemId ?? null;
      this.sql.closeConflict.run(input.resolution, mergedItemId, at, input.actor, id);
      const data = { resolution: input.resolution, ...(mergedItemId ? { mergedItemId } : {}) };
      this.insertEvent(conflict.incomingId, id, "conflict_resolved", input.actor, at, data);
      this.insertEvent(conflict.existingId, id, "conflict_resolved", input.actor, at, data);
      return this.requireConflict(id);
    });
  }

  openConflictIds(itemIds: readonly string[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    if (itemIds.length === 0) return out;
    const asked = new Set(itemIds);
    const json = JSON.stringify([...asked]);
    const rows = this.sql.openConflictIds.all(json, json) as Array<{
      id: string;
      incoming_id: string;
      existing_id: string;
    }>;
    for (const row of rows) {
      for (const itemId of [row.incoming_id, row.existing_id]) {
        if (!asked.has(itemId)) continue;
        const list = out.get(itemId);
        if (list) list.push(row.id);
        else out.set(itemId, [row.id]);
      }
    }
    return out;
  }

  /** `archived` counts every item put away: archived, superseded and rejected. */
  scopeCounts(principalId?: string): Map<string, MemoryScopeCounts> {
    const out = new Map<string, MemoryScopeCounts>();
    const entry = (kind: string, id: string): MemoryScopeCounts => {
      const key = memoryScopeKey({ kind: kind as MemoryScopeRef["kind"], id });
      let counts = out.get(key);
      if (!counts) {
        counts = emptyCounts();
        out.set(key, counts);
      }
      return counts;
    };
    const items = (
      principalId === undefined ? this.sql.itemCounts.all() : this.sql.itemCountsFor.all(principalId)
    ) as Array<{ scope_kind: string; scope_id: string; status: string; n: number }>;
    for (const row of items) {
      const counts = entry(row.scope_kind, row.scope_id);
      if (row.status === "active") counts.active += row.n;
      else if (row.status === "pending") counts.pending += row.n;
      else counts.archived += row.n;
    }
    const conflicts = (
      principalId === undefined ? this.sql.conflictCounts.all() : this.sql.conflictCountsFor.all(principalId)
    ) as Array<{ scope_kind: string; scope_id: string; n: number }>;
    for (const row of conflicts) entry(row.scope_kind, row.scope_id).conflicts += row.n;
    return out;
  }

  // ---- raw conversation windows ----------------------------------------------------------------------------------

  cursor(source: "pa" | "studio", conversationId: string): { messageCount: number; prefixHash: string } | null {
    const row = this.sql.cursor.get(source, conversationId) as
      | { message_count: number; prefix_hash: string }
      | undefined;
    return row ? { messageCount: row.message_count, prefixHash: row.prefix_hash } : null;
  }

  /**
   * Upserts the given windows and removes the conversation's other windows at `seq >= fromSeq`.
   * `replacedIds` lists the windows that were removed and not rewritten; rewritten windows keep their id.
   */
  writeWindows(input: WriteWindowsInput): { written: MemoryChunkRow[]; replacedIds: string[] } {
    return this.transaction(() => {
      const at = this.now();
      const before = this.sql.chunkIdsFrom.all(input.source, input.conversationId, input.fromSeq) as string[];
      const written = input.windows.map((window) => {
        const row = this.sql.upsertChunk.get({
          id: chunkIdOf(input.source, input.conversationId, window.seq),
          source: input.source,
          conversation_id: input.conversationId,
          seq: window.seq,
          content: window.content,
          content_hash: contentHash(window.content),
          speakers: JSON.stringify(window.speakers),
          message_ids: JSON.stringify(window.messageIds),
          start_at: window.startAt,
          end_at: window.endAt,
          data_class: input.dataClass,
          principal_id: input.principalId,
          open: window.open ? 1 : 0,
          at,
        }) as ChunkSqlRow;
        return toChunkRow(row);
      });
      const kept = new Set(written.map((row) => row.id));
      const replacedIds = before.filter((id) => !kept.has(id));
      for (const id of replacedIds) this.sql.removeChunk.run(id);
      this.sql.upsertCursor.run(
        input.source,
        input.conversationId,
        input.cursor.messageCount,
        input.cursor.prefixHash,
        at,
      );
      return { written, replacedIds };
    });
  }

  getChunk(id: string): MemoryChunkRow | null {
    const row = this.sql.getChunk.get(id) as ChunkSqlRow | undefined;
    return row ? toChunkRow(row) : null;
  }

  getChunks(ids: readonly string[]): MemoryChunkRow[] {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const rows = this.sql.getChunks.all(JSON.stringify(unique)) as ChunkSqlRow[];
    const byId = new Map(rows.map((row) => [row.id, toChunkRow(row)]));
    return unique.flatMap((id) => byId.get(id) ?? []);
  }

  /** Newest first. */
  listChunks(filter: {
    conversationId?: string | undefined;
    ids?: readonly string[] | undefined;
    principalId?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
  }): { rows: MemoryChunkRow[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.conversationId !== undefined) {
      where.push("conversation_id = ?");
      params.push(filter.conversationId);
    }
    if (filter.principalId !== undefined) {
      where.push("principal_id = ?");
      params.push(filter.principalId);
    }
    if (filter.ids) {
      where.push("id IN (SELECT value FROM json_each(?))");
      params.push(JSON.stringify(filter.ids));
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = filter.limit ?? -1;
    const offset = filter.offset ?? 0;
    const rows = (
      this.shapedStatement(
        `SELECT * FROM mem_chunks ${clause} ORDER BY end_at DESC, seq DESC, rowid DESC LIMIT ? OFFSET ?`,
      ).all(...params, limit, offset) as ChunkSqlRow[]
    ).map(toChunkRow);
    const total =
      limit < 0 && offset === 0
        ? rows.length
        : (this.shapedStatement(`SELECT COUNT(*) AS n FROM mem_chunks ${clause}`).get(...params) as { n: number }).n;
    return { rows, total };
  }

  /** Windows within `radius` before and after, in order, without the window itself. */
  neighbors(chunk: MemoryChunkRow, radius: number): MemoryChunkRow[] {
    const span = Math.max(0, Math.floor(radius));
    if (span === 0) return [];
    return (
      this.sql.neighbors.all(
        chunk.source,
        chunk.conversationId,
        chunk.seq - span,
        chunk.seq + span,
        chunk.seq,
      ) as ChunkSqlRow[]
    ).map(toChunkRow);
  }

  // ---- meta and telemetry ----------------------------------------------------------------------------------------

  getMeta(key: string): string | null {
    const row = this.sql.getMeta.get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  setMeta(key: string, value: string): void {
    this.sql.setMeta.run(key, value);
  }

  logRecall(entry: {
    surface: string;
    scopeKeys: readonly string[];
    hitCount: number;
    injectedChars: number;
    level: string;
    latencyMs: number;
  }): void {
    this.transaction(() => {
      this.sql.logRecall.run(
        this.now(),
        entry.surface,
        JSON.stringify(entry.scopeKeys),
        Math.round(entry.hitCount),
        Math.round(entry.injectedChars),
        entry.level,
        Math.max(0, Math.round(entry.latencyMs)),
      );
      this.sql.trimRecallLog.run();
    });
  }

  recallLatency(): { p50: number; p95: number; samples: number } | null {
    const values = this.sql.recallLatencies.all() as number[];
    if (values.length === 0) return null;
    return { p50: percentile(values, 0.5), p95: percentile(values, 0.95), samples: values.length };
  }

  // ---- internals -------------------------------------------------------------------------------------------------

  private requireItem(id: string): MemoryItemRow {
    const row = this.getItem(id);
    if (!row) throw new MemoryError("MEMORY_NOT_FOUND", `Memory ${id} was not found.`, 404);
    return row;
  }

  private requireConflict(id: string): MemoryConflictRow {
    const row = this.getConflict(id);
    if (!row) throw new MemoryError("MEMORY_NOT_FOUND", `Conflict ${id} was not found.`, 404);
    return row;
  }

  private insertEvent(
    itemId: string | null,
    conflictId: string | null,
    type: MemoryEventType,
    actor: MemoryActor,
    at: number,
    data: Record<string, unknown>,
  ): void {
    this.sql.insertEvent.run(itemId, conflictId, type, actor, at, JSON.stringify(data));
  }

  private shapedStatement(sql: string): Statement {
    let statement = this.shaped.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.shaped.set(sql, statement);
    }
    return statement;
  }
}

function itemWhere(filter: ItemFilter): { where: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.scope) {
    const scope = normalizeScope(filter.scope);
    clauses.push("scope_kind = ? AND scope_id = ?");
    params.push(scope.kind, scope.id);
  }
  if (filter.scopeKeys) {
    clauses.push(SCOPE_KEYS_MATCH);
    params.push(JSON.stringify(filter.scopeKeys));
  }
  if (filter.statuses) {
    clauses.push("status IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(filter.statuses));
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  if (filter.pinned !== undefined) {
    clauses.push("pinned = ?");
    params.push(filter.pinned ? 1 : 0);
  }
  if (filter.viaGroup !== undefined) {
    clauses.push(
      filter.viaGroup
        ? "json_extract(via, '$.groupId') IS NOT NULL"
        : "(via IS NULL OR json_extract(via, '$.groupId') IS NULL)",
    );
  }
  const text = filter.text?.trim().toLowerCase();
  if (text) {
    clauses.push("instr(lower(title || char(10) || content), ?) > 0");
    params.push(text);
  }
  if (filter.principalId !== undefined) {
    clauses.push("principal_id = ?");
    params.push(filter.principalId);
  }
  if (!filter.includeLocalOnly) clauses.push("data_class <> 'local_only'");
  return { where: clauses.length ? `WHERE ${clauses.join(" AND ")}` : "", params };
}
