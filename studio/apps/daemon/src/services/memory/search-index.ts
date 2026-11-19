// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — the search index: mem_docs (one row per item or raw window), mem_doc_scopes (the scopes
// that may read it) and mem_fts (pre-tokenized text plus one opaque token per readable scope).
//
// The scope restriction is part of the MATCH expression (`scopes:(…) AND tokens:(…)`) and data class, principal,
// recallability and document kind are filtered in the same statement, so LIMIT only ever counts readable
// documents: another scope's better matches cannot crowd out this scope's results.

import { memoryScopeKey } from "@open-design/contracts";
import type { SqliteDb } from "../../db.js";
import { ensureMemorySchema } from "./schema.js";
import { literalTerms, queryTokens, scopeToken, searchableText, tokenize, type LiteralPhrase } from "./text.js";
import type {
  ChannelHit,
  DocFilter,
  IndexedDoc,
  MemoryChunkRow,
  MemoryIndexApi,
  MemoryItemRow,
} from "./types.js";

/** Query tokens OR-ed into one lexical query; longer queries keep their rarest tokens. */
const MAX_QUERY_TOKENS = 24;

type DocKind = IndexedDoc["docKind"];

interface DocInput {
  docKind: DocKind;
  refId: string;
  dataClass: string;
  principalId: string;
  recallable: boolean;
  eventAt: number;
  contentHash: string;
  tokens: string;
  scopeKeys: readonly string[];
}

interface DocRow {
  docId: number;
  docKind: DocKind;
  refId: string;
  dataClass: IndexedDoc["dataClass"];
  principalId: string;
  recallable: number;
  eventAt: number;
  contentHash: string;
}

interface FilterParams {
  includeHidden: number;
  principalId: string;
  localOnly: number;
  docKind: DocKind | null;
  /** JSON array of scope keys a raw window must be readable by, or null when windows follow the item scopes. */
  windowKeys: string | null;
}

const DOC_COLUMNS =
  "doc_id AS docId, doc_kind AS docKind, ref_id AS refId, data_class AS dataClass, principal_id AS principalId, " +
  "recallable, event_at AS eventAt, content_hash AS contentHash";

const FILTER_SQL =
  "(@includeHidden = 1 OR d.recallable = 1) AND d.principal_id = @principalId " +
  "AND (@localOnly = 1 OR d.data_class <> 'local_only') AND (@docKind IS NULL OR d.doc_kind = @docKind) " +
  "AND (@windowKeys IS NULL OR d.doc_kind <> 'chunk' OR EXISTS (SELECT 1 FROM mem_doc_scopes w " +
  "WHERE w.doc_id = d.doc_id AND w.scope_key IN (SELECT value FROM json_each(@windowKeys))))";

function quoteToken(token: string): string {
  return `"${token.replace(/"/g, '""')}"`;
}

function phraseExpression(phrase: LiteralPhrase): string {
  return `${quoteToken(phrase.tokens.join(" "))}${phrase.prefix ? "*" : ""}`;
}

function scopeColumnText(scopeKeys: readonly string[]): string {
  return [...new Set(scopeKeys)].map(scopeToken).sort().join(" ");
}

function filterParams(filter: DocFilter): FilterParams {
  return {
    includeHidden: filter.includeHidden ? 1 : 0,
    // An unset principal means the owner, never "any principal": a missing field must not widen what is read.
    principalId: filter.principalId ?? "owner",
    localOnly: filter.dataClass === "local_only" ? 1 : 0,
    docKind: filter.docKind ?? null,
    windowKeys: filter.windowScopeKeys ? JSON.stringify([...new Set(filter.windowScopeKeys)]) : null,
  };
}

function toIndexedDoc(row: DocRow): IndexedDoc {
  return { ...row, recallable: row.recallable === 1 };
}

function prepareStatements(db: SqliteDb) {
  return {
    findDoc: db.prepare<[DocKind, string], { docId: number }>(
      "SELECT doc_id AS docId FROM mem_docs WHERE doc_kind = ? AND ref_id = ?",
    ),
    insertDoc: db.prepare(
      "INSERT INTO mem_docs(doc_id, doc_kind, ref_id, data_class, principal_id, recallable, event_at, content_hash) " +
        "VALUES (@docId, @docKind, @refId, @dataClass, @principalId, @recallable, @eventAt, @contentHash)",
    ),
    updateDoc: db.prepare(
      "UPDATE mem_docs SET data_class = @dataClass, principal_id = @principalId, recallable = @recallable, " +
        "event_at = @eventAt, content_hash = @contentHash WHERE doc_id = @docId",
    ),
    ftsRow: db.prepare<[number], { tokens: string; scopes: string }>(
      "SELECT tokens, scopes FROM mem_fts WHERE rowid = ?",
    ),
    ftsDelete: db.prepare("DELETE FROM mem_fts WHERE rowid = ?"),
    ftsInsert: db.prepare("INSERT INTO mem_fts(rowid, tokens, scopes) VALUES (?, ?, ?)"),
    scopesDelete: db.prepare("DELETE FROM mem_doc_scopes WHERE doc_id = ?"),
    scopeInsert: db.prepare("INSERT OR IGNORE INTO mem_doc_scopes(doc_id, scope_key) VALUES (?, ?)"),
    docDelete: db.prepare("DELETE FROM mem_docs WHERE doc_id = ?"),
    vectorsDelete: db.prepare("DELETE FROM mem_vectors WHERE doc_id = ?"),
    search: db.prepare<[Record<string, unknown>], { docId: number; rank: number }>(
      "SELECT mem_fts.rowid AS docId, bm25(mem_fts, 1.0, 0.0) AS rank FROM mem_fts " +
        `JOIN mem_docs d ON d.doc_id = mem_fts.rowid WHERE mem_fts MATCH @expr AND ${FILTER_SQL} ` +
        "ORDER BY rank LIMIT @limit",
    ),
    allowed: db
      .prepare<[Record<string, unknown>], number>(
        "SELECT DISTINCT s.doc_id FROM mem_doc_scopes s JOIN mem_docs d ON d.doc_id = s.doc_id " +
          `WHERE s.scope_key IN (SELECT value FROM json_each(@keys)) AND ${FILTER_SQL}`,
      )
      .pluck(),
    docs: db.prepare<[string], DocRow>(
      `SELECT ${DOC_COLUMNS} FROM mem_docs WHERE doc_id IN (SELECT value FROM json_each(?))`,
    ),
    chunkCounts: db.prepare<[], { scopeKey: string; n: number }>(
      "SELECT s.scope_key AS scopeKey, COUNT(*) AS n FROM mem_doc_scopes s " +
        "JOIN mem_docs d ON d.doc_id = s.doc_id WHERE d.doc_kind = 'chunk' GROUP BY s.scope_key",
    ),
    scopeKeysOf: db
      .prepare<[number], string>("SELECT scope_key FROM mem_doc_scopes WHERE doc_id = ? ORDER BY scope_key")
      .pluck(),
    count: db.prepare<[], number>("SELECT COUNT(*) FROM mem_docs").pluck(),
    documentFrequency: db
      .prepare<[string], number>("SELECT doc FROM temp.mem_fts_vocab WHERE term = ?")
      .pluck(),
    existingDocIds: db.prepare<[], { docKind: DocKind; refId: string; docId: number }>(
      "SELECT doc_kind AS docKind, ref_id AS refId, doc_id AS docId FROM mem_docs",
    ),
    clearFts: db.prepare("DELETE FROM mem_fts"),
    clearScopes: db.prepare("DELETE FROM mem_doc_scopes"),
    clearDocs: db.prepare("DELETE FROM mem_docs"),
    clearOrphanVectors: db.prepare("DELETE FROM mem_vectors WHERE doc_id NOT IN (SELECT doc_id FROM mem_docs)"),
    orphanDocs: db.prepare<[], { docId: number }>(
      "SELECT d.doc_id AS docId FROM mem_docs d WHERE " +
        "(d.doc_kind = 'item' AND NOT EXISTS (SELECT 1 FROM mem_items i WHERE i.id = d.ref_id)) OR " +
        "(d.doc_kind = 'chunk' AND NOT EXISTS (SELECT 1 FROM mem_chunks c WHERE c.id = d.ref_id))",
    ),
    optimize: db.prepare("INSERT INTO mem_fts(mem_fts) VALUES ('optimize')"),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

export class MemoryIndex implements MemoryIndexApi {
  private readonly statements: Statements;
  private readonly writeDoc: (doc: DocInput, preferredDocId: number | null) => number;
  private readonly removeChunksTx: (chunkIds: readonly string[]) => void;
  private readonly rebuildTx: (source: Parameters<MemoryIndexApi["rebuild"]>[0]) => number;
  private readonly removeOrphansTx: () => number;

  constructor(db: SqliteDb) {
    ensureMemorySchema(db);
    db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS temp.mem_fts_vocab USING fts5vocab(main, 'mem_fts', 'row')");
    this.statements = prepareStatements(db);
    this.writeDoc = db.transaction((doc: DocInput, preferredDocId: number | null) =>
      this.writeDocNow(doc, preferredDocId),
    );
    this.removeChunksTx = db.transaction((chunkIds: readonly string[]) => {
      for (const chunkId of new Set(chunkIds)) {
        const found = this.statements.findDoc.get("chunk", chunkId);
        if (!found) continue;
        this.statements.ftsDelete.run(found.docId);
        this.statements.scopesDelete.run(found.docId);
        this.statements.vectorsDelete.run(found.docId);
        this.statements.docDelete.run(found.docId);
      }
    });
    this.rebuildTx = db.transaction((source: Parameters<MemoryIndexApi["rebuild"]>[0]) => this.rebuildNow(source));
    this.removeOrphansTx = db.transaction(() => {
      const orphans = this.statements.orphanDocs.all();
      for (const { docId } of orphans) {
        this.statements.ftsDelete.run(docId);
        this.statements.scopesDelete.run(docId);
        this.statements.vectorsDelete.run(docId);
        this.statements.docDelete.run(docId);
      }
      this.statements.clearOrphanVectors.run();
      this.statements.optimize.run();
      return orphans.length;
    });
  }

  // ---- writes ----------------------------------------------------------------------------------------------------

  upsertItem(item: MemoryItemRow): number {
    return this.writeDoc(this.itemDoc(item), null);
  }

  upsertChunk(chunk: MemoryChunkRow, scopeKeys: readonly string[]): number {
    return this.writeDoc(this.chunkDoc(chunk, scopeKeys), null);
  }

  removeChunks(chunkIds: readonly string[]): void {
    if (chunkIds.length > 0) this.removeChunksTx(chunkIds);
  }

  rebuild(source: Parameters<MemoryIndexApi["rebuild"]>[0]): number {
    const written = this.rebuildTx(source);
    this.statements.optimize.run();
    return written;
  }

  removeOrphans(): number {
    return this.removeOrphansTx();
  }

  private itemDoc(item: MemoryItemRow): DocInput {
    return {
      docKind: "item",
      refId: item.id,
      dataClass: item.dataClass,
      principalId: item.principalId,
      recallable: item.status === "active" && !item.redacted,
      eventAt: item.eventAt ?? item.createdAt,
      contentHash: item.contentHash,
      tokens: item.redacted ? "" : tokenize(searchableText(item.title, item.content)).join(" "),
      scopeKeys: [memoryScopeKey({ kind: item.scopeKind, id: item.scopeId })],
    };
  }

  private chunkDoc(chunk: MemoryChunkRow, scopeKeys: readonly string[]): DocInput {
    return {
      docKind: "chunk",
      refId: chunk.id,
      dataClass: chunk.dataClass,
      principalId: chunk.principalId,
      recallable: true,
      eventAt: chunk.startAt,
      contentHash: chunk.contentHash,
      tokens: tokenize(chunk.content).join(" "),
      scopeKeys,
    };
  }

  /** Keeps the doc id of an existing (kind, ref) so stored vectors stay attached; rewrites FTS only on change. */
  private writeDocNow(doc: DocInput, preferredDocId: number | null): number {
    const values = {
      docKind: doc.docKind,
      refId: doc.refId,
      dataClass: doc.dataClass,
      principalId: doc.principalId,
      recallable: doc.recallable ? 1 : 0,
      eventAt: doc.eventAt,
      contentHash: doc.contentHash,
    };
    const existing = this.statements.findDoc.get(doc.docKind, doc.refId);
    let docId: number;
    if (existing) {
      docId = existing.docId;
      this.statements.updateDoc.run({ ...values, docId });
    } else {
      docId = Number(this.statements.insertDoc.run({ ...values, docId: preferredDocId }).lastInsertRowid);
    }
    const scopes = scopeColumnText(doc.scopeKeys);
    const stored = this.statements.ftsRow.get(docId);
    if (stored?.tokens === doc.tokens && stored.scopes === scopes) return docId;
    if (stored) this.statements.ftsDelete.run(docId);
    this.statements.ftsInsert.run(docId, doc.tokens, scopes);
    if (stored?.scopes !== scopes) {
      this.statements.scopesDelete.run(docId);
      for (const key of new Set(doc.scopeKeys)) this.statements.scopeInsert.run(docId, key);
    }
    return docId;
  }

  private rebuildNow(source: Parameters<MemoryIndexApi["rebuild"]>[0]): number {
    const previous = new Map<string, number>();
    for (const row of this.statements.existingDocIds.iterate()) {
      previous.set(`${row.docKind}\u0000${row.refId}`, row.docId);
    }
    this.statements.clearFts.run();
    this.statements.clearScopes.run();
    this.statements.clearDocs.run();
    let written = 0;
    const write = (doc: DocInput): void => {
      this.writeDocNow(doc, previous.get(`${doc.docKind}\u0000${doc.refId}`) ?? null);
      written += 1;
    };
    for (const item of source.items) write(this.itemDoc(item));
    for (const { chunk, scopeKeys } of source.chunks) write(this.chunkDoc(chunk, scopeKeys));
    this.statements.clearOrphanVectors.run();
    return written;
  }

  // ---- reads -----------------------------------------------------------------------------------------------------

  lexical(query: string, filter: DocFilter, limit: number): ChannelHit[] {
    if (filter.scopeKeys.length === 0 || limit <= 0) return [];
    let tokens = queryTokens(query);
    if (tokens.length > MAX_QUERY_TOKENS) tokens = this.rarest(tokens, MAX_QUERY_TOKENS);
    if (tokens.length === 0) return [];
    return this.match(tokens.map(quoteToken), filter, limit);
  }

  literal(query: string, filter: DocFilter, limit: number): ChannelHit[] {
    if (filter.scopeKeys.length === 0 || limit <= 0) return [];
    const phrases = new Set(literalTerms(query).flatMap((term) => term.phrases.map(phraseExpression)));
    if (phrases.size === 0) return [];
    return this.match([...phrases], filter, limit);
  }

  allowedDocIds(filter: DocFilter): number[] {
    if (filter.scopeKeys.length === 0) return [];
    return this.statements.allowed.all({ keys: JSON.stringify(filter.scopeKeys), ...filterParams(filter) });
  }

  docs(docIds: readonly number[]): IndexedDoc[] {
    if (docIds.length === 0) return [];
    const byId = new Map<number, IndexedDoc>();
    for (const row of this.statements.docs.all(JSON.stringify(docIds))) byId.set(row.docId, toIndexedDoc(row));
    const out: IndexedDoc[] = [];
    for (const docId of docIds) {
      const doc = byId.get(docId);
      if (doc) out.push(doc);
    }
    return out;
  }

  docIdOf(docKind: DocKind, refId: string): number | null {
    return this.statements.findDoc.get(docKind, refId)?.docId ?? null;
  }

  chunkCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const row of this.statements.chunkCounts.all()) out.set(row.scopeKey, row.n);
    return out;
  }

  scopeKeysOf(docId: number): string[] {
    return this.statements.scopeKeysOf.all(docId);
  }

  count(): number {
    return this.statements.count.get() ?? 0;
  }

  /** One FTS query: any of `alternatives`, inside the readable scopes, filtered before LIMIT. */
  private match(alternatives: readonly string[], filter: DocFilter, limit: number): ChannelHit[] {
    const scopes = [...new Set(filter.scopeKeys)].map(scopeToken).join(" OR ");
    const expr = `scopes:(${scopes}) AND tokens:(${alternatives.join(" OR ")})`;
    const rows = this.statements.search.all({ expr, limit, ...filterParams(filter) });
    return rows.map((row) => ({ docId: row.docId, score: -row.rank }));
  }

  /** The `count` tokens found in the fewest documents; tokens found nowhere cannot match and are dropped. */
  private rarest(tokens: readonly string[], count: number): string[] {
    const scored: Array<{ token: string; df: number; order: number }> = [];
    tokens.forEach((token, order) => {
      const df = this.statements.documentFrequency.get(token) ?? 0;
      if (df > 0) scored.push({ token, df, order });
    });
    scored.sort((a, b) => a.df - b.df || a.order - b.order);
    return scored
      .slice(0, count)
      .sort((a, b) => a.order - b.order)
      .map((entry) => entry.token);
  }
}
