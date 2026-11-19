// SPDX-License-Identifier: AGPL-3.0-only
// One worker holds one open SQLite file, read through sql.js (SQLite compiled to WebAssembly). The
// file is untrusted: it is opened for reading only, its schema may not call unsafe functions, no
// extension is ever loaded, and a query that never ends takes this worker with it, not the tab.
// The engine's .wasm file ships with the app; nothing is fetched from the network.
/// <reference lib="webworker" />
import initSqlJs from 'sql.js/dist/sql-wasm-browser.js';
import type { Database } from 'sql.js';

import type { DatabaseModel, DatabaseRequest, DatabaseResponse } from './database-protocol';
import { describeDatabase, isSqliteFile, lockDatabase, readRows } from './read-database';

let database: Database | null = null;
let model: DatabaseModel | null = null;

function reply(message: DatabaseResponse): void {
  self.postMessage(message);
}

async function open(bytes: ArrayBuffer): Promise<void> {
  const data = new Uint8Array(bytes);
  if (!isSqliteFile(data)) {
    reply({ type: 'failed', reason: 'not-database' });
    return;
  }
  const engine = new URL('sql.js/dist/sql-wasm-browser.wasm', import.meta.url).href;
  const sql = await initSqlJs({ locateFile: () => engine });
  database = new sql.Database(data);
  lockDatabase(database);
  model = describeDatabase(database);
  reply({ type: 'ready', model });
}

self.addEventListener('message', (event: MessageEvent<DatabaseRequest>) => {
  const request = event.data;
  if (request.type === 'open') {
    // An encrypted or damaged file passes the header check and fails at the first statement.
    open(request.bytes).catch(() => reply({ type: 'failed', reason: 'unreadable' }));
    return;
  }
  const table = model?.tables[request.table];
  let rows: ReturnType<typeof readRows> = [];
  if (database && table && table.readable) {
    try {
      rows = readRows(database, table, request.start, request.count);
    } catch {
      rows = [];
    }
  }
  reply({ type: 'rows', id: request.id, rows });
});
