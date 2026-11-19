// SPDX-License-Identifier: Apache-2.0
// Fantay Memory 1.0 — SQLite schema.
//
// Truth vs projection:
//   Truth (append-only):  mem_versions (immutable text), mem_events (every state change), mem_links,
//                         mem_conflicts (a row is opened once and closed once; never removed).
//   Head  (current state): mem_items — one row per memory, updated in place; it can be rebuilt from the truth.
//   Projection (rebuildable from truth + raw conversations): mem_chunks, mem_cursors, mem_docs,
//                         mem_doc_scopes, mem_fts, mem_vectors.
//   Telemetry (bounded):  mem_recall_log.
//
// No code path may DELETE from the truth tables or from mem_items.

import type { SqliteDb } from "../../db.js";

export const MEMORY_SCHEMA_VERSION = 1;

const DDL = `
CREATE TABLE IF NOT EXISTS mem_items (
  id TEXT PRIMARY KEY,
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  principal_id TEXT NOT NULL DEFAULT 'owner',
  kind TEXT NOT NULL DEFAULT 'fact',
  status TEXT NOT NULL DEFAULT 'active',
  origin TEXT NOT NULL DEFAULT 'user_explicit',
  pinned INTEGER NOT NULL DEFAULT 0,
  data_class TEXT NOT NULL DEFAULT 'standard',
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  source_refs TEXT NOT NULL DEFAULT '[]',
  via TEXT,
  author_id TEXT,
  event_at INTEGER,
  due_at INTEGER,
  valid_from INTEGER,
  valid_until INTEGER,
  superseded_by TEXT,
  revision INTEGER NOT NULL DEFAULT 1,
  content_revision INTEGER NOT NULL DEFAULT 1,
  version_count INTEGER NOT NULL DEFAULT 1,
  redacted INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mem_items_scope ON mem_items(scope_kind, scope_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_items_hash ON mem_items(scope_kind, scope_id, content_hash);
CREATE INDEX IF NOT EXISTS idx_mem_items_status ON mem_items(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS mem_versions (
  item_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  actor TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  PRIMARY KEY (item_id, version)
);

CREATE TABLE IF NOT EXISTS mem_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  conflict_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  at INTEGER NOT NULL,
  data TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_mem_events_item ON mem_events(item_id, seq);
CREATE INDEX IF NOT EXISTS idx_mem_events_conflict ON mem_events(conflict_id, seq);

CREATE TABLE IF NOT EXISTS mem_links (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, relation)
);
CREATE INDEX IF NOT EXISTS idx_mem_links_to ON mem_links(to_id);

CREATE TABLE IF NOT EXISTS mem_conflicts (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'conflict',
  scope_kind TEXT NOT NULL,
  scope_id TEXT NOT NULL DEFAULT '',
  incoming_id TEXT NOT NULL,
  existing_id TEXT NOT NULL,
  -- The two item ids sorted and joined with '|': one pair is raised at most once, ever.
  pair_key TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL DEFAULT '',
  detector TEXT NOT NULL DEFAULT 'heuristic',
  confidence REAL NOT NULL DEFAULT 0,
  suggestion TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  resolution TEXT,
  merged_item_id TEXT,
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_mem_conflicts_status ON mem_conflicts(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_conflicts_incoming ON mem_conflicts(incoming_id);
CREATE INDEX IF NOT EXISTS idx_mem_conflicts_existing ON mem_conflicts(existing_id);

CREATE TABLE IF NOT EXISTS mem_chunks (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  speakers TEXT NOT NULL DEFAULT '[]',
  message_ids TEXT NOT NULL DEFAULT '[]',
  start_at INTEGER NOT NULL,
  end_at INTEGER NOT NULL,
  data_class TEXT NOT NULL DEFAULT 'standard',
  principal_id TEXT NOT NULL DEFAULT 'owner',
  -- 1 while the window can still grow with the next message; closed windows are never rewritten.
  open INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (source, conversation_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_mem_chunks_conv ON mem_chunks(source, conversation_id, seq);
-- Listing one conversation's windows, or one member's, newest first, without walking the whole table.
CREATE INDEX IF NOT EXISTS idx_mem_chunks_conv_end ON mem_chunks(conversation_id, end_at DESC);
CREATE INDEX IF NOT EXISTS idx_mem_chunks_principal_end ON mem_chunks(principal_id, end_at DESC);

CREATE TABLE IF NOT EXISTS mem_cursors (
  source TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  -- Number of messages already covered by closed windows, and a fingerprint of them. When the fingerprint of
  -- the same prefix changes (a message was edited or removed) the conversation's windows are rebuilt.
  message_count INTEGER NOT NULL DEFAULT 0,
  prefix_hash TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (source, conversation_id)
);

CREATE TABLE IF NOT EXISTS mem_docs (
  doc_id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_kind TEXT NOT NULL,
  ref_id TEXT NOT NULL,
  data_class TEXT NOT NULL DEFAULT 'standard',
  principal_id TEXT NOT NULL DEFAULT 'owner',
  -- 0 hides the document from recall without removing it (non-active items).
  recallable INTEGER NOT NULL DEFAULT 1,
  event_at INTEGER NOT NULL DEFAULT 0,
  content_hash TEXT NOT NULL DEFAULT '',
  UNIQUE (doc_kind, ref_id)
);

CREATE TABLE IF NOT EXISTS mem_doc_scopes (
  doc_id INTEGER NOT NULL,
  scope_key TEXT NOT NULL,
  PRIMARY KEY (doc_id, scope_key)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_mem_doc_scopes_key ON mem_doc_scopes(scope_key, doc_id);

-- rowid = mem_docs.doc_id. 'tokens' holds the pre-tokenized text (see text.ts); 'scopes' holds one opaque
-- token per readable scope so a query is restricted to its scopes inside the index, before any LIMIT.
CREATE VIRTUAL TABLE IF NOT EXISTS mem_fts USING fts5(
  tokens,
  scopes,
  tokenize = "unicode61 remove_diacritics 0 tokenchars '_'"
);

CREATE TABLE IF NOT EXISTS mem_vectors (
  doc_id INTEGER NOT NULL,
  model_id TEXT NOT NULL,
  dim INTEGER NOT NULL,
  vec BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (doc_id, model_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS mem_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mem_recall_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at INTEGER NOT NULL,
  surface TEXT NOT NULL,
  scope_keys TEXT NOT NULL,
  hit_count INTEGER NOT NULL,
  injected_chars INTEGER NOT NULL,
  level TEXT NOT NULL,
  latency_ms INTEGER NOT NULL
);
`;

/** Creates the memory tables. Safe to call on every start. */
export function ensureMemorySchema(db: SqliteDb): void {
  db.exec(DDL);
  db.prepare(
    "INSERT INTO mem_meta(key, value) VALUES('schema_version', ?) ON CONFLICT(key) DO NOTHING",
  ).run(String(MEMORY_SCHEMA_VERSION));
}
