// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the sheet worker: opens a file in a worker of its own, reports what it
// holds, and reads rows on request. The worker lives as long as the viewer shows that version of the
// file; `close` ends it. A file that takes too long to open is stopped and reported as such.
import type { DataGridRow } from './grid-model';
import {
  SHEET_OPEN_TIMEOUT_MS,
  type SheetBook,
  type SheetFailure,
  type SheetFormat,
  type SheetRequest,
  type SheetResponse,
} from './sheet-protocol';

export interface SheetProgress {
  rowCount: number;
  columnCount: number;
  done: boolean;
  truncated: boolean;
}

export interface SheetHandlers {
  onReady(book: SheetBook): void;
  /** Delimited text still streaming in: the first sheet has grown. */
  onProgress(progress: SheetProgress): void;
  onFailed(reason: SheetFailure): void;
}

export interface SheetClient {
  rows(sheet: number, start: number, count: number): Promise<readonly DataGridRow[]>;
  close(): void;
}

export function openSheet(format: SheetFormat, bytes: ArrayBuffer, handlers: SheetHandlers): SheetClient {
  const worker = new Worker(new URL('./sheet.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, (rows: readonly DataGridRow[]) => void>();
  let nextId = 1;
  let closed = false;
  let opened = false;

  const close = (): void => {
    if (closed) return;
    closed = true;
    window.clearTimeout(timer);
    worker.terminate();
    // Whoever is still waiting gets nothing rather than waiting for ever.
    for (const resolve of pending.values()) resolve([]);
    pending.clear();
  };
  const fail = (reason: SheetFailure): void => {
    if (closed) return;
    close();
    handlers.onFailed(reason);
  };
  const timer = window.setTimeout(() => {
    if (!opened) fail('timeout');
  }, SHEET_OPEN_TIMEOUT_MS);

  worker.addEventListener('message', (event: MessageEvent<SheetResponse>) => {
    if (closed) return;
    const message = event.data;
    if (message.type === 'rows') {
      pending.get(message.id)?.(message.rows);
      pending.delete(message.id);
    } else if (message.type === 'ready') {
      opened = true;
      window.clearTimeout(timer);
      handlers.onReady(message.book);
    } else if (message.type === 'progress') {
      handlers.onProgress(message);
    } else {
      fail(message.reason);
    }
  });
  // The worker died: out of memory on a huge workbook, or its code failed to load.
  worker.addEventListener('error', () => fail('invalid'));

  // Copied, not transferred: the viewer keeps the bytes (for the source view and the next version).
  worker.postMessage({ type: 'open', format, bytes } satisfies SheetRequest);

  return {
    rows: (sheet, start, count) => {
      if (closed) return Promise.resolve([]);
      const id = nextId;
      nextId += 1;
      return new Promise<readonly DataGridRow[]>((resolve) => {
        pending.set(id, resolve);
        worker.postMessage({ type: 'rows', id, sheet, start, count } satisfies SheetRequest);
      });
    },
    close,
  };
}
