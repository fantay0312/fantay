// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Rows in windows: a window is read once, a window read while the file was growing is read again,
// rows of an older version stay until their replacement arrives, a range can be read for copying,
// and the per-file session keeps what a remounted grid needs.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DataGridRow } from '../../../src/fantay/artifact/viewers/sheet/grid-model';
import {
  ROW_WINDOW,
  fileGridSession,
  gridSession,
  storeWindow,
  trimIdleGrids,
  type RowWindowCache,
} from '../../../src/fantay/artifact/viewers/sheet/grid-session';
import { useRowWindows, type RowFetcher } from '../../../src/fantay/artifact/viewers/sheet/use-row-windows';
import { resetArtifactViewState } from '../../../src/fantay/artifact/use-view-state';

afterEach(() => {
  cleanup();
  resetArtifactViewState();
});

const row = (index: number, tag = ''): DataGridRow => ({ cells: [`${tag}${index}`] });

/** A source of `total` rows that remembers what it was asked for. */
function fetcher(total: () => number, tag = ''): RowFetcher & { calls: Array<[number, number]> } {
  const calls: Array<[number, number]> = [];
  const fetch = Object.assign(
    async (start: number, count: number) => {
      calls.push([start, count]);
      const rows: DataGridRow[] = [];
      for (let index = start; index < Math.min(total(), start + count); index += 1) rows.push(row(index, tag));
      return rows;
    },
    { calls },
  );
  return fetch;
}

const emptyCache = (): RowWindowCache => ({ windows: new Map() });

describe('useRowWindows', () => {
  it('reads a window when it is asked for, once', async () => {
    const fetch = fetcher(() => 1000);
    const cache = emptyCache();
    const { result } = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 1000, fetch }));
    expect(result.current.getRow(450)).toBeUndefined();
    act(() => result.current.ensureRows(430, 470));
    act(() => result.current.ensureRows(430, 470));
    await waitFor(() => expect(result.current.getRow(450)).toEqual(row(450)));
    expect(fetch.calls).toEqual([[2 * ROW_WINDOW, ROW_WINDOW]]);
    expect(result.current.revision).toBe(1);
  });

  it('reads every window a range touches', async () => {
    const fetch = fetcher(() => 1000);
    const cache = emptyCache();
    const { result } = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 1000, fetch }));
    act(() => result.current.ensureRows(190, 410));
    await waitFor(() => expect(result.current.getRow(405)).toEqual(row(405)));
    expect(fetch.calls.map((call) => call[0])).toEqual([0, 200, 400]);
  });

  it('serves the rows it was given up front without asking', () => {
    const fetch = fetcher(() => 150);
    const head = Array.from({ length: 150 }, (_, index) => row(index));
    const cache = emptyCache();
    const { result } = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 150, fetch, head }));
    act(() => result.current.ensureRows(0, 150));
    expect(result.current.getRow(149)).toEqual(row(149));
    expect(fetch.calls).toEqual([]);
  });

  it('reads the last window again once the file has grown past what it held', async () => {
    let total = 250;
    const fetch = fetcher(() => total);
    const cache = emptyCache();
    const { result, rerender } = renderHook(({ rowCount }) => useRowWindows({ cache, dataKey: 'v1', rowCount, fetch }), {
      initialProps: { rowCount: 250 },
    });
    act(() => result.current.ensureRows(200, 250));
    await waitFor(() => expect(result.current.getRow(249)).toEqual(row(249)));
    expect(result.current.getRow(260)).toBeUndefined();
    total = 400;
    rerender({ rowCount: 400 });
    act(() => result.current.ensureRows(200, 300));
    await waitFor(() => expect(result.current.getRow(260)).toEqual(row(260)));
    expect(fetch.calls).toEqual([
      [200, 200],
      [200, 200],
    ]);
  });

  it('keeps rows of the previous version on screen until the new ones arrive', async () => {
    const cache = emptyCache();
    const older = fetcher(() => 600, 'old-');
    const first = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 600, fetch: older }));
    act(() => first.result.current.ensureRows(200, 260));
    await waitFor(() => expect(first.result.current.getRow(210)).toEqual(row(210, 'old-')));
    first.unmount();

    // The viewer is mounted again for a new version; no worker is up yet.
    const second = renderHook(({ fetch, dataKey }: { fetch: RowFetcher | null; dataKey: string }) => useRowWindows({ cache, dataKey, rowCount: 600, fetch }), {
      initialProps: { fetch: null as RowFetcher | null, dataKey: 'v1' },
    });
    expect(second.result.current.getRow(210)).toEqual(row(210, 'old-'));
    act(() => second.result.current.ensureRows(200, 260));

    const newer = fetcher(() => 600, 'new-');
    second.rerender({ fetch: newer, dataKey: 'v2' });
    expect(second.result.current.getRow(210)).toEqual(row(210, 'old-'));
    act(() => second.result.current.ensureRows(200, 260));
    await waitFor(() => expect(second.result.current.getRow(210)).toEqual(row(210, 'new-')));
    expect(newer.calls).toEqual([[200, 200]]);
  });

  it('reads a range for copying, from what it holds and from the source', async () => {
    const fetch = fetcher(() => 9000);
    const head = Array.from({ length: 100 }, (_, index) => row(index));
    const cache = emptyCache();
    const { result } = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 9000, fetch, head }));
    const rows = await result.current.readRows(95, 4200);
    expect(rows).toHaveLength(4105);
    expect(rows[0]).toEqual(row(95));
    expect(rows[4104]).toEqual(row(4199));
    // The first five came from the head; the rest in chunks from the source.
    expect(fetch.calls).toEqual([
      [100, 4000],
      [4100, 100],
    ]);
    expect(await result.current.readRows(8990, 20_000)).toHaveLength(10);
  });

  it('drops an answer that arrives after the grid is gone', async () => {
    let release: (rows: DataGridRow[]) => void = () => undefined;
    const fetch = vi.fn(() => new Promise<DataGridRow[]>((resolve) => (release = resolve)));
    const cache = emptyCache();
    const { result, unmount } = renderHook(() => useRowWindows({ cache, dataKey: 'v1', rowCount: 500, fetch }));
    act(() => result.current.ensureRows(0, 10));
    unmount();
    await act(async () => release([row(0)]));
    // Stored for the next mount, without touching the unmounted hook's state.
    expect(cache.windows.get(0)?.rows).toEqual([row(0)]);
  });
});

describe('grid session', () => {
  it('is one object per file, found again after a remount', () => {
    const first = fileGridSession<{ sheets: number }>('project', 'data/a.csv');
    first.snapshot = { mtime: 1, model: { sheets: 3 } };
    gridSession(first, '汇总').view.scrollTop = 840;
    const again = fileGridSession<{ sheets: number }>('project', 'data/a.csv');
    expect(again).toBe(first);
    expect(gridSession(again, '汇总').view.scrollTop).toBe(840);
    expect(fileGridSession('project', 'data/b.csv')).not.toBe(first);
  });

  it('keeps the newest windows and drops the oldest past the limit', () => {
    const cache = emptyCache();
    for (let index = 0; index < 40; index += 1) storeWindow(cache, index, 'v1', [row(index)]);
    expect(cache.windows.size).toBe(24);
    expect(cache.windows.has(0)).toBe(false);
    expect(cache.windows.has(39)).toBe(true);
    // Storing a window again makes it the newest.
    storeWindow(cache, 16, 'v1', [row(16)]);
    storeWindow(cache, 99, 'v1', [row(99)]);
    expect(cache.windows.has(16)).toBe(true);
    expect(cache.windows.has(17)).toBe(false);
  });

  it('trims the sheets that are not on screen', () => {
    const session = fileGridSession('project', 'office/book.xlsx');
    for (const name of ['汇总', '订单']) {
      const grid = gridSession(session, name);
      for (let index = 0; index < 10; index += 1) storeWindow(grid.cache, index, 'v1', [row(index)]);
    }
    trimIdleGrids(session, '订单');
    expect(gridSession(session, '汇总').cache.windows.size).toBe(3);
    expect(gridSession(session, '订单').cache.windows.size).toBe(10);
  });
});
