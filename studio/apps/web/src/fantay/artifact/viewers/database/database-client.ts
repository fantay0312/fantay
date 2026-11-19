// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the database worker: opens a file in a worker of its own, reports its
// tables, and reads pages of rows. The worker lives as long as the viewer shows that version of the
// file; `close` ends it and frees the engine's memory. Opening, and every page, has a time limit.
import type { DataGridRow } from '../sheet/grid-model';
import {
  DATABASE_OPEN_TIMEOUT_MS,
  DATABASE_QUERY_TIMEOUT_MS,
  type DatabaseFailure,
  type DatabaseModel,
  type DatabaseRequest,
  type DatabaseResponse,
} from './database-protocol';

export interface DatabaseHandlers {
  onReady(model: DatabaseModel): void;
  onFailed(reason: DatabaseFailure): void;
}

export interface DatabaseClient {
  rows(table: number, start: number, count: number): Promise<readonly DataGridRow[]>;
  close(): void;
}

export function openDatabase(bytes: ArrayBuffer, handlers: DatabaseHandlers): DatabaseClient {
  const worker = new Worker(new URL('./database.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, { resolve(rows: readonly DataGridRow[]): void; timer: number }>();
  let nextId = 1;
  let closed = false;
  let opened = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(openTimer);
    worker.terminate();
    for (const request of pending.values()) {
      window.clearTimeout(request.timer);
      request.resolve([]);
    }
    pending.clear();
  };
  const fail = (reason: DatabaseFailure): void => {
    if (closed) return;
    close();
    handlers.onFailed(reason);
  };
  const openTimer = window.setTimeout(() => {
    if (!opened) fail('timeout');
  }, DATABASE_OPEN_TIMEOUT_MS);

  worker.addEventListener('message', (event: MessageEvent<DatabaseResponse>) => {
    if (closed) return;
    const message = event.data;
    if (message.type === 'rows') {
      const request = pending.get(message.id);
      if (!request) return;
      window.clearTimeout(request.timer);
      pending.delete(message.id);
      request.resolve(message.rows);
    } else if (message.type === 'ready') {
      opened = true;
      window.clearTimeout(openTimer);
      handlers.onReady(message.model);
    } else {
      fail(message.reason);
    }
  });
  // The worker died: out of memory, or the engine failed to load.
  worker.addEventListener('error', () => fail('unreadable'));

  // Copied, not transferred: the viewer keeps the bytes for the next version check.
  worker.postMessage({ type: 'open', bytes } satisfies DatabaseRequest);

  return {
    rows: (table, start, count) => {
      if (closed) return Promise.resolve([]);
      const id = nextId;
      nextId += 1;
      return new Promise<readonly DataGridRow[]>((resolve) => {
        // The engine runs one statement at a time; one that never returns stops the whole worker.
        const timer = window.setTimeout(() => fail('timeout'), DATABASE_QUERY_TIMEOUT_MS);
        pending.set(id, { resolve, timer });
        worker.postMessage({ type: 'rows', id, table, start, count } satisfies DatabaseRequest);
      });
    },
    close,
  };
}
