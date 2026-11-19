// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/binaryPreview.worker.ts @ c5e6b24f (MIT): how a
// SQLite file is opened for looking only (`query_only`, `trusted_schema` off), how its tables are
// listed without the engine's own and the virtual ones, how names are quoted,
// and how a page of rows is read with LIMIT / OFFSET, binary values reduced to their size.
// Changed here: views are listed too, columns keep their declared type and key, values keep their
// storage class (so numbers align and NULL reads as absent), integers are read as BigInt, text is
// cut in SQL, and the functions take an open database so tests run them under Node.
import type { Database, SqlValue } from 'sql.js';

import type { DataGridRow } from '../sheet/grid-model';
import {
  DATABASE_HEAD_ROWS,
  DATABASE_HEAD_TABLES,
  DATABASE_MAX_COLUMNS,
  DATABASE_MAX_TABLES,
  DATABASE_TEXT_LIMIT,
  type DatabaseColumn,
  type DatabaseModel,
  type DatabaseTable,
} from './database-protocol';

const MAGIC = 'SQLite format 3\u0000';

/** True when the bytes start with SQLite's file header. */
export function isSqliteFile(bytes: Uint8Array): boolean {
  if (bytes.length < MAGIC.length) return false;
  for (let index = 0; index < MAGIC.length; index += 1) if (bytes[index] !== MAGIC.charCodeAt(index)) return false;
  return true;
}

/** A table or column name as SQL: in double quotes, with any quote inside doubled. */
export function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** Read-only from here on: no statement may write, and the schema may not call unsafe functions. */
export function lockDatabase(database: Database): void {
  database.run('PRAGMA query_only = ON; PRAGMA trusted_schema = OFF;');
}

function byteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

function columnsOf(database: Database, name: string): DatabaseColumn[] {
  const info = database.exec(`PRAGMA table_xinfo(${quoteIdentifier(name)})`)[0];
  if (!info) return [];
  const columns: DatabaseColumn[] = [];
  // cid, name, type, notnull, dflt_value, pk, hidden
  for (const row of info.values) {
    // 1 marks a virtual table's hidden column.
    if (Number(row[6]) === 1) continue;
    columns.push({ name: String(row[1]), type: String(row[2] ?? ''), notNull: Number(row[3]) !== 0, primaryKey: Number(row[5]) !== 0 });
    if (columns.length >= DATABASE_MAX_COLUMNS) break;
  }
  return columns;
}

/** Tables first, then views, each by name; with their columns, row counts and first rows. */
export function describeDatabase(database: Database): DatabaseModel {
  // `table_list` tells ordinary tables and views from virtual tables and the shadow tables behind
  // them (a full-text index keeps several); only the first two are something to read.
  const listed = database.exec(
    "SELECT name, type FROM pragma_table_list WHERE schema = 'main' AND type IN ('table', 'view') " +
      "AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name COLLATE NOCASE " +
      `LIMIT ${DATABASE_MAX_TABLES + 1}`,
  )[0];
  const entries = listed?.values ?? [];
  const tables: DatabaseTable[] = [];
  for (const entry of entries.slice(0, DATABASE_MAX_TABLES)) {
    const name = String(entry[0]);
    const table: DatabaseTable = { name, kind: entry[1] === 'view' ? 'view' : 'table', rowCount: 0, columns: [], readable: true, head: null };
    try {
      table.columns = columnsOf(database, name);
      table.rowCount = Number(database.exec(`SELECT count(*) FROM ${quoteIdentifier(name)}`)[0]?.values[0]?.[0] ?? 0);
      if (tables.length < DATABASE_HEAD_TABLES) table.head = readRows(database, table, 0, DATABASE_HEAD_ROWS);
    } catch {
      // A view whose tables are gone, or a table the engine build cannot read.
      table.readable = false;
      table.rowCount = 0;
      table.head = [];
    }
    tables.push(table);
  }
  return { tables, truncated: entries.length > DATABASE_MAX_TABLES };
}

/**
 * Rows `start` to `start + count` of a table, as text with each value's storage class: integers
 * and reals are numbers (`n`), NULL is absent (`z`), a blob is its size (`x`), the rest is text.
 */
export function readRows(database: Database, table: DatabaseTable, start: number, count: number): DataGridRow[] {
  if (table.columns.length === 0 || count <= 0) return [];
  const fields = table.columns
    .map((column) => {
      const field = quoteIdentifier(column.name);
      return `typeof(${field}), CASE typeof(${field}) WHEN 'blob' THEN length(${field}) WHEN 'text' THEN substr(${field}, 1, ${DATABASE_TEXT_LIMIT}) ELSE ${field} END`;
    })
    .join(', ');
  const statement = database.prepare(`SELECT ${fields} FROM ${quoteIdentifier(table.name)} LIMIT ? OFFSET ?`, [
    Math.max(0, Math.floor(count)),
    Math.max(0, Math.floor(start)),
  ]);
  const rows: DataGridRow[] = [];
  try {
    while (statement.step()) {
      const values: SqlValue[] = statement.get(null, { useBigInt: true });
      const cells: string[] = [];
      let kinds = '';
      for (let index = 0; index < table.columns.length; index += 1) {
        const storage = values[index * 2];
        const value = values[index * 2 + 1];
        if (storage === 'null' || value === null || value === undefined) {
          cells.push('NULL');
          kinds += 'z';
        } else if (storage === 'blob') {
          cells.push(`BLOB · ${byteSize(Number(value))}`);
          kinds += 'x';
        } else if (storage === 'integer' || storage === 'real') {
          cells.push(String(value));
          kinds += 'n';
        } else {
          cells.push(String(value));
          kinds += 's';
        }
      }
      rows.push({ cells, kinds });
    }
  } finally {
    statement.free();
  }
  return rows;
}
