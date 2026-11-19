// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/VirtualTablePreview.tsx @ c5e6b24f (MIT): rows
// are held in fixed pages, a page is asked for when it comes into view, and a page that was read
// while the file was still growing is asked for again once it can be complete.
// Changed here: the pages live in the file's session rather than in the component, so a remount
// paints from them; a page read from an older version of the file stays on screen until its
// replacement arrives; and a range can be read in one call for copying.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { DataGridRow } from './grid-model';
import { ROW_WINDOW, storeWindow, type RowWindowCache } from './grid-session';

/** Rows asked for in one request when copying a range. */
const READ_CHUNK = 4000;

export type RowFetcher = (start: number, count: number) => Promise<readonly DataGridRow[]>;

export interface RowWindowsOptions {
  cache: RowWindowCache;
  /** Identity of the data: the file version, the sheet, the row offset. */
  dataKey: string;
  rowCount: number;
  /** Reads rows from the source; null while there is nothing to ask (the worker is not up yet). */
  fetch: RowFetcher | null;
  /** Rows known without asking, from index 0. */
  head?: readonly DataGridRow[];
}

export interface RowWindows {
  /** The row if it is known; a row from an older version is better than a blank. */
  getRow(index: number): DataGridRow | undefined;
  /** Asks for rows `start` (inclusive) to `end` (exclusive) if they are not here yet. */
  ensureRows(start: number, end: number): void;
  /** Reads rows `start` to `end` (exclusive), from here or from the source. */
  readRows(start: number, end: number): Promise<DataGridRow[]>;
  /** Changes whenever rows arrive. */
  revision: number;
}

const NO_ROWS: readonly DataGridRow[] = [];

export function useRowWindows({ cache, dataKey, rowCount, fetch, head = NO_ROWS }: RowWindowsOptions): RowWindows {
  const [revision, setRevision] = useState(0);
  const inFlight = useRef(new Set<string>());
  const mounted = useRef(true);
  // The latest values, for callbacks that outlive a render.
  const live = useRef({ cache, dataKey, rowCount, fetch, head });
  live.current = { cache, dataKey, rowCount, fetch, head };

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const getRow = useCallback(
    (index: number): DataGridRow | undefined => {
      if (index < head.length) return head[index];
      return cache.windows.get(Math.floor(index / ROW_WINDOW))?.rows[index % ROW_WINDOW];
    },
    // `revision` is a dependency on purpose: a new function tells memoised rows to read again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [cache, head, revision],
  );

  const ensureRows = useCallback(
    (start: number, end: number): void => {
      if (!fetch || rowCount <= 0) return;
      const first = Math.floor(Math.max(0, start) / ROW_WINDOW);
      const last = Math.floor(Math.max(0, Math.min(end, rowCount) - 1) / ROW_WINDOW);
      for (let index = first; index <= last; index += 1) {
        const from = index * ROW_WINDOW;
        const expected = Math.min(ROW_WINDOW, rowCount - from);
        if (expected <= 0 || from + expected <= head.length) continue;
        const stored = cache.windows.get(index);
        if (stored && stored.key === dataKey && stored.rows.length >= expected) continue;
        const ticket = `${dataKey}\n${index}\n${expected}`;
        if (inFlight.current.has(ticket)) continue;
        inFlight.current.add(ticket);
        fetch(from, ROW_WINDOW).then(
          (rows) => {
            inFlight.current.delete(ticket);
            // An answer for data that is no longer shown is dropped.
            if (live.current.dataKey !== dataKey || live.current.cache !== cache) return;
            storeWindow(cache, index, dataKey, rows);
            if (mounted.current) setRevision((value) => value + 1);
          },
          () => {
            inFlight.current.delete(ticket);
          },
        );
      }
    },
    [cache, dataKey, fetch, head.length, rowCount],
  );

  const readRows = useCallback(async (start: number, end: number): Promise<DataGridRow[]> => {
    const current = live.current;
    const from = Math.max(0, start);
    const to = Math.min(end, current.rowCount);
    const rows: DataGridRow[] = [];
    let index = from;
    while (index < to) {
      const known =
        index < current.head.length
          ? current.head[index]
          : ((): DataGridRow | undefined => {
              const stored = current.cache.windows.get(Math.floor(index / ROW_WINDOW));
              return stored && stored.key === current.dataKey ? stored.rows[index % ROW_WINDOW] : undefined;
            })();
      if (known) {
        rows.push(known);
        index += 1;
        continue;
      }
      if (!current.fetch) break;
      const fetched = await current.fetch(index, Math.min(READ_CHUNK, to - index));
      if (fetched.length === 0) break;
      for (const row of fetched) rows.push(row);
      index += fetched.length;
    }
    return rows;
  }, []);

  return useMemo(() => ({ getRow, ensureRows, readRows, revision }), [getRow, ensureRows, readRows, revision]);
}
