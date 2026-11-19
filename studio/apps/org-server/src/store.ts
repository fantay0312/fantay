// SPDX-License-Identifier: AGPL-3.0-only
// Storage of the Fantay organization server: one SQLite file holding records, access-token digests, library images
// and the hash-chained audit log. It never stores a conversation, a message or a memory of any member.
import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { OrgAuditEvent, OrgEntity } from '@open-design/contracts/org';

export class OrgError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
export type OrgCollection = 'org' | 'members' | 'groups' | 'roles' | 'library' | 'service_tokens' | 'sessions' | 'meta';
/** `member`: a member's access token (one live token each). `service`: a sync credential. `session`: a console
 *  session opened through SSO (several per member, short-lived). `scim`: the identity provider's provisioning token. */
export type TokenKind = 'member' | 'service' | 'session' | 'scim';
export interface TokenRow { sha256: string; kind: TokenKind; ownerId: string; expiresAt: number; createdAt: number; lastUsedAt: number | null }
type AuditInput = Omit<OrgAuditEvent, 'sequence' | 'hash'>;

const auditHash = (previous: string, event: AuditInput) =>
  createHash('sha256').update(JSON.stringify([previous, event.at, event.actorId, event.action, event.targetId, event.detail])).digest('hex');

export class OrgStore {
  readonly db: DatabaseSync;
  private depth = 0;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const file = path.join(directory, 'org.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records(collection TEXT NOT NULL,id TEXT NOT NULL,revision INTEGER NOT NULL,data TEXT NOT NULL,PRIMARY KEY(collection,id));
      CREATE TABLE IF NOT EXISTS tokens(sha256 TEXT PRIMARY KEY,kind TEXT NOT NULL,owner_id TEXT NOT NULL,expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,last_used_at INTEGER,UNIQUE(kind,owner_id));
      CREATE TABLE IF NOT EXISTS assets(item_id TEXT NOT NULL,id TEXT NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(item_id,id));
      CREATE TABLE IF NOT EXISTS audit(sequence INTEGER PRIMARY KEY AUTOINCREMENT,at INTEGER NOT NULL,actor_id TEXT NOT NULL,action TEXT NOT NULL,target_id TEXT,detail TEXT NOT NULL,previous_hash TEXT NOT NULL,hash TEXT NOT NULL);`);
  }
  close(): void { if (this.db.isOpen) this.db.close(); }

  /** Runs `fn` atomically. A nested call joins the transaction already open. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.depth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    } finally {
      this.depth -= 1;
    }
  }

  // ---- records ---------------------------------------------------------------------------------------------------
  list<T extends OrgEntity>(collection: OrgCollection): T[] {
    return (this.db.prepare('SELECT data FROM records WHERE collection=? ORDER BY rowid').all(collection) as Array<{ data: string }>)
      .map(row => JSON.parse(row.data) as T);
  }
  count(collection: OrgCollection): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM records WHERE collection=?').get(collection) as { n: number }).n;
  }
  get<T extends OrgEntity>(collection: OrgCollection, id: string): T | null {
    const row = this.db.prepare('SELECT data FROM records WHERE collection=? AND id=?').get(collection, id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : null;
  }
  require<T extends OrgEntity>(collection: OrgCollection, id: string): T {
    const value = this.get<T>(collection, id);
    if (!value) throw new OrgError(404, 'ORG_NOT_FOUND', '记录不存在');
    return value;
  }
  create<T extends OrgEntity>(collection: OrgCollection, value: Omit<T, keyof OrgEntity>, at: number, id: string = randomUUID()): T {
    const record = { ...value, id, revision: 1, createdAt: at, updatedAt: at } as T;
    this.db.prepare('INSERT INTO records(collection,id,revision,data) VALUES(?,?,?,?)').run(collection, id, 1, JSON.stringify(record));
    return record;
  }
  /** `expected`, when given, must be the stored revision: two editors never overwrite each other silently. */
  update<T extends OrgEntity>(collection: OrgCollection, id: string, patch: Partial<T>, at: number, expected?: number): T {
    const current = this.require<T>(collection, id);
    if (expected !== undefined && current.revision !== expected) throw new OrgError(409, 'ORG_REVISION_CONFLICT', '内容已更新，请刷新后重试');
    const next = { ...current, ...patch, id, createdAt: current.createdAt, revision: current.revision + 1, updatedAt: at } as T;
    const result = this.db.prepare('UPDATE records SET revision=?,data=? WHERE collection=? AND id=? AND revision=?')
      .run(next.revision, JSON.stringify(next), collection, id, current.revision);
    if (!result.changes) throw new OrgError(409, 'ORG_REVISION_CONFLICT', '内容已更新，请刷新后重试');
    return next;
  }
  remove(collection: OrgCollection, id: string): void {
    this.db.prepare('DELETE FROM records WHERE collection=? AND id=?').run(collection, id);
  }

  // ---- access tokens (digests only) ------------------------------------------------------------------------------
  /** One live token per owner: a new one replaces the old one. */
  putToken(kind: TokenKind, ownerId: string, sha256: string, expiresAt: number, at: number): void {
    this.db.prepare('DELETE FROM tokens WHERE kind=? AND owner_id=?').run(kind, ownerId);
    this.db.prepare('INSERT INTO tokens(sha256,kind,owner_id,expires_at,created_at) VALUES(?,?,?,?,?)').run(sha256, kind, ownerId, expiresAt, at);
  }
  private tokenRow(row: Record<string, unknown> | undefined): TokenRow | null {
    return row ? {
      sha256: String(row.sha256), kind: row.kind as TokenKind, ownerId: String(row.owner_id),
      expiresAt: Number(row.expires_at), createdAt: Number(row.created_at), lastUsedAt: row.last_used_at == null ? null : Number(row.last_used_at),
    } : null;
  }
  tokenByDigest(sha256: string): TokenRow | null {
    return this.tokenRow(this.db.prepare('SELECT * FROM tokens WHERE sha256=?').get(sha256) as Record<string, unknown> | undefined);
  }
  tokenOf(kind: TokenKind, ownerId: string): TokenRow | null {
    return this.tokenRow(this.db.prepare('SELECT * FROM tokens WHERE kind=? AND owner_id=?').get(kind, ownerId) as Record<string, unknown> | undefined);
  }
  deleteToken(kind: TokenKind, ownerId: string): void {
    this.db.prepare('DELETE FROM tokens WHERE kind=? AND owner_id=?').run(kind, ownerId);
  }
  touchToken(sha256: string, at: number): void {
    this.db.prepare('UPDATE tokens SET last_used_at=? WHERE sha256=?').run(at, sha256);
  }

  // ---- library images --------------------------------------------------------------------------------------------
  putAsset(itemId: string, id: string, bytes: Uint8Array): void {
    this.db.prepare('INSERT OR REPLACE INTO assets(item_id,id,bytes) VALUES(?,?,?)').run(itemId, id, bytes);
  }
  asset(itemId: string, id: string): Uint8Array | null {
    const row = this.db.prepare('SELECT bytes FROM assets WHERE item_id=? AND id=?').get(itemId, id) as { bytes: Uint8Array } | undefined;
    return row ? row.bytes : null;
  }
  removeAssets(itemId: string, id?: string): void {
    if (id) this.db.prepare('DELETE FROM assets WHERE item_id=? AND id=?').run(itemId, id);
    else this.db.prepare('DELETE FROM assets WHERE item_id=?').run(itemId);
  }

  // ---- audit log -------------------------------------------------------------------------------------------------
  appendAudit(event: AuditInput): void {
    const previous = (this.db.prepare('SELECT hash FROM audit ORDER BY sequence DESC LIMIT 1').get() as { hash: string } | undefined)?.hash ?? '';
    this.db.prepare('INSERT INTO audit(at,actor_id,action,target_id,detail,previous_hash,hash) VALUES(?,?,?,?,?,?,?)')
      .run(event.at, event.actorId, event.action, event.targetId, JSON.stringify(event.detail), previous, auditHash(previous, event));
  }
  audit(before: number, limit: number): OrgAuditEvent[] {
    const rows = this.db.prepare('SELECT * FROM audit WHERE sequence<? ORDER BY sequence DESC LIMIT ?').all(before, limit) as Array<Record<string, unknown>>;
    return rows.map(row => ({
      sequence: Number(row.sequence), at: Number(row.at), actorId: String(row.actor_id), action: String(row.action),
      targetId: row.target_id == null ? null : String(row.target_id),
      detail: JSON.parse(String(row.detail)) as Record<string, unknown>, hash: String(row.hash),
    }));
  }
  /** Recomputes the chain: an edited, removed or reordered entry breaks every hash after it. */
  verifyAudit(): { valid: boolean; entries: number; head: string | null } {
    const rows = this.db.prepare('SELECT * FROM audit ORDER BY sequence').all() as Array<Record<string, unknown>>;
    let previous = '', count = 0;
    for (const row of rows) {
      const event: AuditInput = {
        at: Number(row.at), actorId: String(row.actor_id), action: String(row.action),
        targetId: row.target_id == null ? null : String(row.target_id), detail: JSON.parse(String(row.detail)) as Record<string, unknown>,
      };
      if (Number(row.sequence) !== count + 1 || row.previous_hash !== previous || row.hash !== auditHash(previous, event))
        return { valid: false, entries: count, head: previous || null };
      previous = String(row.hash);
      count += 1;
    }
    return { valid: true, entries: count, head: previous || null };
  }
}
