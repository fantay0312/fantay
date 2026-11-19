// SPDX-License-Identifier: AGPL-3.0-only
// What the database viewer and its worker say to each other. The worker owns the open database (the
// whole file sits in the engine's memory); the window holds the list of tables and a few windows of
// rows. Rows cross the boundary as text: the engine's values never reach the window.
import type { DataGridRow } from '../sheet/grid-model';

/** Files larger than this are not opened: the engine keeps the whole file in memory. */
export const DATABASE_MAX_BYTES = 100 * 1024 * 1024;
export const DATABASE_OPEN_TIMEOUT_MS = 30_000;
/** A page of rows that takes longer than this (a view that never ends) stops the worker. */
export const DATABASE_QUERY_TIMEOUT_MS = 15_000;
export const DATABASE_MAX_TABLES = 500;
/** Columns read per table. Each needs two result columns, and the engine allows 2,000. */
export const DATABASE_MAX_COLUMNS = 500;
/** Characters read from a text value. */
export const DATABASE_TEXT_LIMIT = 4000;
/** Rows sent with the first answer, for this many tables; the rest are read when their tab opens. */
export const DATABASE_HEAD_ROWS = 200;
export const DATABASE_HEAD_TABLES = 24;

export interface DatabaseColumn {
  name: string;
  /** The declared type, as written in the schema ("INTEGER", "VARCHAR(16)"); '' when none. */
  type: string;
  primaryKey: boolean;
  notNull: boolean;
}

export interface DatabaseTable {
  name: string;
  kind: 'table' | 'view';
  rowCount: number;
  columns: DatabaseColumn[];
  /** False when the table or view cannot be read (a view over a table that is gone). */
  readable: boolean;
  /** The first rows; null when they have not been read yet. */
  head: DataGridRow[] | null;
}

export interface DatabaseModel {
  tables: DatabaseTable[];
  /** More tables exist than are listed. */
  truncated: boolean;
}

export type DatabaseFailure = 'not-database' | 'unreadable' | 'timeout';

export type DatabaseRequest =
  | { type: 'open'; bytes: ArrayBuffer }
  | { type: 'rows'; id: number; table: number; start: number; count: number };

export type DatabaseResponse =
  | { type: 'ready'; model: DatabaseModel }
  | { type: 'rows'; id: number; rows: DataGridRow[] }
  | { type: 'failed'; reason: DatabaseFailure };
