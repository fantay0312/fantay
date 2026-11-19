import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { SqliteDb } from "../db.js";
import type { PaEntity } from "@open-design/contracts";
import { paFeedKinds, type PaFeedItem } from "@open-design/contracts";

export type PaCollection =
  | "agents"
  | "groups"
  | "conversations"
  | "messages"
  | "tasks"
  | "attempts"
  | "leases"
  | "dispatches"
  | "revocations"
  | "budget_reservations"
  | "artifacts"
  | "memories"
  | "memory_versions"
  | "memory_candidates"
  | "episodes"
  | "goals"
  | "routines"
  | "channels"
  | "channel_inbox"
  | "channel_outbox"
  | "channel_pairings"
  | "channel_attachments"
  | "approvals"
  | "characters" | "lorebooks" | "personas" | "presets" | "chat_settings" | "chat_state" | "soul_traces"
  | "soul_speech"
  | "org_library"
  | "settings";
const SNAPSHOT_COLLECTIONS: ReadonlySet<PaCollection> = new Set([
  "agents", "groups", "conversations", "messages", "tasks", "attempts", "artifacts",
  "memories", "memory_candidates", "goals", "routines", "settings",
]);
export class PaError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = "PA_INVALID_REQUEST",
  ) {
    super(message);
  }
}
type PaAuditRow = { sequence: number; eventId: string; previousHash: string; hash: string };
type PaEventRow = { taskId: string | null; kind: string; at: number; data: string };
const auditHash = (previous: string, eventId: string, event: PaEventRow) =>
  createHash("sha256").update(JSON.stringify([previous, eventId, event.taskId, event.kind, event.at, event.data])).digest("hex");

type PaStmt = Database.Statement<unknown[]>;

/** PA records never cascade with ordinary project conversations. */
export class PaStore {
  private listeners = new Set<(taskId: string | null, kind: string) => void>();
  private readonly stmtList: PaStmt;
  private readonly stmtGet: PaStmt;
  private readonly stmtHas: PaStmt;
  private readonly stmtInsert: PaStmt;
  private readonly stmtUpdate: PaStmt;
  private readonly stmtDelete: PaStmt;
  private readonly stmtInsertEvent: PaStmt;
  private readonly stmtHasEvent: PaStmt;
  private readonly stmtEvents: PaStmt;
  private readonly stmtFeed: PaStmt;
  private readonly stmtHasTaskRequest: PaStmt;
  private readonly stmtAuditEvent: PaStmt;
  private readonly stmtLastAuditHash: PaStmt;
  private readonly stmtInsertAudit: PaStmt;
  private readonly stmtCountTaskAttempts: PaStmt;
  private readonly stmtListTaskAttempts: PaStmt;
  private readonly stmtActionableInbox: PaStmt;
  private readonly stmtActionableOutbox: PaStmt;
  private readonly stmtConversationMessages: PaStmt;
  private readonly stmtTaskByRequest: PaStmt;
  /** Bumped by every write to a collection the /api/pa snapshot reads. */
  changes = 0;

  subscribe(listener: (taskId: string | null, kind: string) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  constructor(readonly db: SqliteDb) {
    db.exec(`CREATE TABLE IF NOT EXISTS pa_records (
      collection TEXT NOT NULL, id TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(collection,id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS pa_request_id ON pa_records(json_extract(data,'$.requestId')) WHERE collection='tasks';
    CREATE INDEX IF NOT EXISTS pa_attempt_task ON pa_records(json_extract(data,'$.taskId')) WHERE collection='attempts';
    CREATE INDEX IF NOT EXISTS pa_channel_state ON pa_records(collection, json_extract(data,'$.state')) WHERE collection IN ('channel_inbox','channel_outbox');
    CREATE INDEX IF NOT EXISTS pa_message_conversation ON pa_records(json_extract(data,'$.conversationId')) WHERE collection='messages';
    CREATE TABLE IF NOT EXISTS pa_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      task_id TEXT, kind TEXT NOT NULL, at INTEGER NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pa_audit (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE NOT NULL,
      previous_hash TEXT NOT NULL, hash TEXT NOT NULL
    );`);
    this.stmtList = db.prepare<unknown[]>("SELECT data FROM pa_records WHERE collection=? ORDER BY rowid");
    this.stmtGet = db.prepare<unknown[]>("SELECT data FROM pa_records WHERE collection=? AND id=?");
    this.stmtHas = db.prepare<unknown[]>("SELECT 1 FROM pa_records WHERE collection=? AND id=?");
    this.stmtInsert = db.prepare<unknown[]>("INSERT INTO pa_records(collection,id,revision,data) VALUES(?,?,?,?)");
    this.stmtUpdate = db.prepare<unknown[]>("UPDATE pa_records SET revision=?,data=? WHERE collection=? AND id=? AND revision=?");
    this.stmtDelete = db.prepare<unknown[]>("DELETE FROM pa_records WHERE collection=? AND id=?");
    this.stmtInsertEvent = db.prepare<unknown[]>("INSERT OR IGNORE INTO pa_events(event_id,task_id,kind,at,data) VALUES(?,?,?,?,?)");
    this.stmtHasEvent = db.prepare<unknown[]>("SELECT 1 FROM pa_events WHERE event_id=?");
    this.stmtEvents = db.prepare<unknown[]>("SELECT sequence,event_id AS id,kind,at,data FROM pa_events WHERE task_id=? ORDER BY sequence");
    this.stmtFeed = db.prepare<unknown[]>(`
      SELECT sequence, task_id AS taskId, kind, at FROM pa_events
      WHERE sequence < ? AND kind IN (${paFeedKinds.map(() => '?').join(',')})
      ORDER BY sequence DESC LIMIT ?
    `);
    this.stmtHasTaskRequest = db.prepare<unknown[]>("SELECT 1 FROM pa_records WHERE collection='tasks' AND json_extract(data,'$.requestId')=?");
    this.stmtAuditEvent = db.prepare<unknown[]>("SELECT task_id AS taskId, kind, at, data FROM pa_events WHERE event_id=?");
    this.stmtLastAuditHash = db.prepare<unknown[]>("SELECT hash FROM pa_audit ORDER BY sequence DESC LIMIT 1");
    this.stmtInsertAudit = db.prepare<unknown[]>("INSERT INTO pa_audit(event_id,previous_hash,hash) VALUES(?,?,?)");
    this.stmtCountTaskAttempts = db.prepare<unknown[]>("SELECT COUNT(*) AS count FROM pa_records WHERE collection='attempts' AND json_extract(data,'$.taskId')=?");
    this.stmtListTaskAttempts = db.prepare<unknown[]>("SELECT data FROM pa_records WHERE collection='attempts' AND json_extract(data,'$.taskId')=? ORDER BY rowid");
    this.stmtConversationMessages = db.prepare<unknown[]>("SELECT data FROM pa_records WHERE collection='messages' AND json_extract(data,'$.conversationId')=? ORDER BY rowid");
    this.stmtTaskByRequest = db.prepare<unknown[]>("SELECT data FROM pa_records WHERE collection='tasks' AND json_extract(data,'$.requestId')=?");
    this.stmtActionableInbox = db.prepare<unknown[]>(
      "SELECT data FROM pa_records WHERE collection='channel_inbox' AND (json_extract(data,'$.state')='pending' OR (json_extract(data,'$.state')='accepted' AND json_extract(data,'$.taskId') IS NOT NULL)) ORDER BY rowid",
    );
    this.stmtActionableOutbox = db.prepare<unknown[]>(
      "SELECT data FROM pa_records WHERE collection='channel_outbox' AND json_extract(data,'$.state') IN ('pending','unknown') ORDER BY rowid",
    );
  }
  list<T extends PaEntity>(collection: PaCollection): T[] {
    return (this.stmtList.all(collection) as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  get<T extends PaEntity>(collection: PaCollection, id: string): T | null {
    const row = this.stmtGet.get(collection, id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  has(collection: PaCollection, id: string): boolean {
    return Boolean(this.stmtHas.get(collection, id));
  }
  countTaskAttempts(taskId: string): number {
    return (this.stmtCountTaskAttempts.get(taskId) as { count: number } | undefined)?.count ?? 0;
  }
  listTaskAttempts<T extends PaEntity>(taskId: string): T[] {
    return (this.stmtListTaskAttempts.all(taskId) as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  listConversationMessages<T extends PaEntity>(conversationId: string): T[] {
    return (this.stmtConversationMessages.all(conversationId) as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  taskByRequest<T extends PaEntity>(requestId: string): T | null {
    const row = this.stmtTaskByRequest.get(requestId) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : null;
  }
  listActionableChannelInbox<T extends PaEntity>(): T[] {
    return (this.stmtActionableInbox.all() as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  listActionableChannelOutbox<T extends PaEntity>(): T[] {
    return (this.stmtActionableOutbox.all() as Array<{ data: string }>).map(
      (row) => JSON.parse(row.data) as T,
    );
  }
  require<T extends PaEntity>(collection: PaCollection, id: string): T {
    const value = this.get<T>(collection, id);
    if (!value) throw new PaError("记录不存在", 404, "PA_NOT_FOUND");
    return value;
  }
  create<T extends PaEntity>(
    collection: PaCollection,
    value: Omit<T, keyof PaEntity>,
    id: string = randomUUID(),
  ): T {
    const now = Date.now();
    const record = {
      ...value,
      id,
      revision: 1,
      createdAt: now,
      updatedAt: now,
    } as T;
    this.stmtInsert.run(collection, id, 1, JSON.stringify(record));
    if (SNAPSHOT_COLLECTIONS.has(collection)) this.changes += 1;
    return record;
  }
  update<T extends PaEntity>(
    collection: PaCollection,
    id: string,
    patch: Partial<T>,
    expectedRevision?: number,
  ): T {
    const current = this.require<T>(collection, id);
    if (expectedRevision !== undefined && current.revision !== expectedRevision)
      throw new PaError(
        "内容已更新，请刷新后重试",
        409,
        "PA_REVISION_CONFLICT",
      );
    const next = {
      ...current,
      ...patch,
      id,
      createdAt: current.createdAt,
      revision: current.revision + 1,
      updatedAt: Date.now(),
    };
    const result = this.stmtUpdate.run(
      next.revision,
      JSON.stringify(next),
      collection,
      id,
      current.revision,
    );
    if (!result.changes)
      throw new PaError(
        "内容已更新，请刷新后重试",
        409,
        "PA_REVISION_CONFLICT",
      );
    if (SNAPSHOT_COLLECTIONS.has(collection)) this.changes += 1;
    return next;
  }
  remove(collection: PaCollection, id: string): void {
    this.stmtDelete.run(collection, id);
    if (SNAPSHOT_COLLECTIONS.has(collection)) this.changes += 1;
  }
  event(
    taskId: string | null,
    kind: string,
    data: unknown,
    eventId: string = randomUUID(),
  ): boolean {
    const inserted =
      this.stmtInsertEvent.run(eventId, taskId, kind, Date.now(), JSON.stringify(data)).changes > 0;
    if (inserted) queueMicrotask(() => {
      if (!this.db.open || !this.stmtHasEvent.get(eventId)) return;
      for (const listener of this.listeners) { try { listener(taskId, kind); } catch { /* observers cannot change a committed event */ } }
    });
    return inserted;
  }
  events(taskId: string) {
    return (
      this.stmtEvents.all(taskId) as Array<{
        sequence: number;
        id: string;
        kind: string;
        at: number;
        data: string;
      }>
    ).map((row) => ({ ...row, data: JSON.parse(row.data) as unknown }));
  }
  feed(before: number, limit: number): PaFeedItem[] {
    return this.stmtFeed.all(before, ...paFeedKinds, limit) as PaFeedItem[];
  }
  hasTaskRequest(requestId: string): boolean {
    return Boolean(this.stmtHasTaskRequest.get(requestId));
  }
  hasEvent(eventId: string): boolean {
    return Boolean(this.stmtHasEvent.get(eventId));
  }
  private auditEvent(eventId: string): PaEventRow | undefined {
    return this.stmtAuditEvent.get(eventId) as PaEventRow | undefined;
  }
  audit(taskId: string | null, kind: string, data: unknown, eventId: string): void {
    this.transaction(() => {
      if (!this.event(taskId, kind, data, eventId)) return;
      const previous = this.stmtLastAuditHash.get() as { hash: string } | undefined;
      const previousHash = previous?.hash ?? "";
      this.stmtInsertAudit.run(eventId, previousHash, auditHash(previousHash, eventId, this.auditEvent(eventId)!));
    });
  }
  verifyAudit(): { valid: boolean; entries: number; head: string | null } {
    const rows = this.db.prepare("SELECT sequence,event_id AS eventId,previous_hash AS previousHash,hash FROM pa_audit ORDER BY sequence")
      .iterate() as Iterable<PaAuditRow>;
    let previous = "", count = 0;
    for (const row of rows) {
      const event = this.auditEvent(row.eventId);
      if (row.sequence !== count + 1 || !event || row.previousHash !== previous || row.hash !== auditHash(previous, row.eventId, event))
        return { valid: false, entries: count, head: previous || null };
      previous = row.hash;
      count++;
    }
    return { valid: true, entries: count, head: previous || null };
  }
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }
}
