// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The data grid in a DOM: what it draws from a windowed source, how the pointer and the keyboard
// select, what the value bar says, what ⌘C puts on the clipboard, and that the reader's selection
// and column widths live in the session it is handed (so they outlive the grid).
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { DataGrid, type DataGridColumn } from '../../../src/fantay/artifact/viewers/parts/DataGrid';
import type { DataGridRow, GridRange } from '../../../src/fantay/artifact/viewers/sheet/grid-model';
import type { GridSession } from '../../../src/fantay/artifact/viewers/sheet/grid-session';
import type { RowWindows } from '../../../src/fantay/artifact/viewers/sheet/use-row-windows';

const VIEW = { width: 900, height: 420 };
const saved: Array<[string, PropertyDescriptor | undefined]> = [];

function define(name: string, value: number): void {
  saved.push([name, Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)]);
  Object.defineProperty(HTMLElement.prototype, name, { configurable: true, get: () => value });
}

beforeAll(() => {
  // jsdom lays nothing out: give every element the size of the grid's viewport.
  define('offsetWidth', VIEW.width);
  define('offsetHeight', VIEW.height);
  define('clientWidth', VIEW.width);
  define('clientHeight', VIEW.height);
  HTMLCanvasElement.prototype.getContext = (() => null) as typeof HTMLCanvasElement.prototype.getContext;
  HTMLElement.prototype.setPointerCapture = () => undefined;
  HTMLElement.prototype.releasePointerCapture = () => undefined;
  HTMLElement.prototype.hasPointerCapture = () => false;
});

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(HTMLElement.prototype, name, descriptor);
    else delete (HTMLElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const COLUMNS: DataGridColumn[] = [{ label: '订单号' }, { label: '客户' }, { label: '金额', hint: 'real' }, { label: '备注' }];

function makeRows(count: number): DataGridRow[] {
  return Array.from({ length: count }, (_, index) => ({
    cells: [`SO-${index + 1}`, `客户${index + 1}`, `${(index + 1) * 10}.50`, index === 1 ? '发票抬头：某公司\n税号：9131' : ''],
  }));
}

function source(data: DataGridRow[]): RowWindows & { ensureRows: ReturnType<typeof vi.fn<(start: number, end: number) => void>> } {
  return {
    getRow: (index) => data[index],
    ensureRows: vi.fn<(start: number, end: number) => void>(),
    readRows: async (start, end) => data.slice(start, end),
    revision: 0,
  };
}

function freshSession(): GridSession {
  return { view: { selection: null, widths: {}, scrollTop: 0, scrollLeft: 0 }, cache: { windows: new Map() } };
}

interface Setup {
  session?: GridSession;
  data?: DataGridRow[];
  merges?: GridRange[];
  addressing?: 'cell' | 'record';
  columns?: DataGridColumn[];
}

function setup({ session = freshSession(), data = makeRows(50), merges, addressing = 'record', columns = COLUMNS }: Setup = {}) {
  const rows = source(data);
  const view = render(
    <DataGrid
      label="订单"
      columns={columns}
      rowCount={data.length}
      rows={rows}
      sample={data.slice(0, 20)}
      merges={merges}
      session={session}
      addressing={addressing}
      emptyLabel="没有数据"
    />,
  );
  const grid = screen.getByRole('grid');
  return { ...view, grid, rows, session };
}

/** The x of a column's middle and the y of a row's middle, in the grid's own coordinates. */
function pointAt(grid: HTMLElement, row: number, column: number): { clientX: number; clientY: number } {
  const header = grid.querySelector<HTMLElement>(`[role="columnheader"][aria-colindex="${column + 1}"]`);
  if (!header) throw new Error(`column ${column} is not drawn`);
  return {
    clientX: Number.parseFloat(header.style.left) + Number.parseFloat(header.style.width) / 2,
    clientY: 30 + row * 28 + 14,
  };
}

function press(grid: HTMLElement, row: number, column: number, init: { shiftKey?: boolean } = {}): void {
  const cell = grid.querySelector<HTMLElement>('[role="gridcell"]');
  if (!cell) throw new Error('no cell drawn');
  const point = pointAt(grid, row, column);
  fireEvent.pointerDown(cell, { button: 0, pointerId: 1, ...point, ...init });
  fireEvent.pointerUp(cell, { button: 0, pointerId: 1, ...point });
}

const activeCell = (grid: HTMLElement): string | null => {
  const id = grid.getAttribute('aria-activedescendant');
  return id ? id.split('-').slice(-2).join(',') : null;
};

describe('DataGrid', () => {
  it('draws the header, the row numbers and only the rows in view', () => {
    const { grid, rows } = setup({ data: makeRows(5000) });
    expect(screen.getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['订单号', '客户', '金额real', '备注']);
    expect(grid.getAttribute('aria-rowcount')).toBe('5001');
    expect(grid.getAttribute('aria-colcount')).toBe('4');
    const drawn = screen.getAllByRole('row').length;
    // 420px of viewport at 28px a row, plus the rows kept ready above and below: nowhere near 5,000.
    expect(drawn).toBeGreaterThan(10);
    expect(drawn).toBeLessThan(40);
    expect(screen.getByText('SO-1')).toBeTruthy();
    expect(screen.queryByText('SO-400')).toBeNull();
    expect(rows.ensureRows).toHaveBeenCalled();
    expect(rows.ensureRows.mock.calls[0]?.[0]).toBe(0);
  });

  it('aligns numbers to the right and shows a cell on one line', () => {
    setup();
    expect(screen.getByText('10.50').getAttribute('data-kind')).toBe('n');
    expect(screen.getByText('客户1').getAttribute('data-kind')).toBe('s');
    expect(screen.getByText('发票抬头：某公司 税号：9131')).toBeTruthy();
  });

  it('selects the cell under the pointer and shows its whole value in the bar', () => {
    const { grid, container, session } = setup();
    expect(activeCell(grid)).toBeNull();
    press(grid, 1, 3);
    expect(activeCell(grid)).toBe('1,3');
    expect(session.view.selection).toEqual({ anchor: { row: 1, col: 3 }, focus: { row: 1, col: 3 } });
    const bar = container.querySelector('[data-open]');
    expect(bar?.textContent).toContain('备注');
    // The bar keeps the line break the cell flattened.
    expect(bar?.textContent).toContain('发票抬头：某公司\n税号：9131');
  });

  it('moves with the arrow keys, extends with Shift and clears with Escape', () => {
    const { grid, session } = setup();
    press(grid, 2, 1);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(activeCell(grid)).toBe('3,2');
    fireEvent.keyDown(grid, { key: 'ArrowDown', shiftKey: true });
    fireEvent.keyDown(grid, { key: 'ArrowLeft', shiftKey: true });
    expect(session.view.selection).toEqual({ anchor: { row: 3, col: 2 }, focus: { row: 4, col: 1 } });
    fireEvent.keyDown(grid, { key: 'End', metaKey: true });
    expect(session.view.selection?.focus).toEqual({ row: 49, col: 3 });
    fireEvent.keyDown(grid, { key: 'Escape' });
    expect(session.view.selection).toBeNull();
    expect(activeCell(grid)).toBeNull();
  });

  it('lands on the first cell in view when a key is pressed with nothing selected', () => {
    const { grid } = setup();
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(activeCell(grid)).toBe('0,0');
  });

  it('selects a whole column from its header, a whole row from its number, everything with the modifier and A', () => {
    const { grid, container, session } = setup();
    const header = screen.getAllByRole('columnheader')[2];
    if (!header) throw new Error('header missing');
    fireEvent.pointerDown(header, { button: 0, pointerId: 1, ...pointAt(grid, 0, 2), clientY: 10 });
    expect(session.view.selection).toEqual({ anchor: { row: 0, col: 2 }, focus: { row: 49, col: 2 } });
    fireEvent.pointerUp(header, { pointerId: 1 });

    const rowNumber = container.querySelector<HTMLElement>('[aria-hidden="true"] > div');
    if (!rowNumber) throw new Error('row number missing');
    fireEvent.pointerDown(rowNumber, { button: 0, pointerId: 2, clientX: 10, clientY: 30 + 3 * 28 + 5 });
    expect(session.view.selection).toEqual({ anchor: { row: 3, col: 0 }, focus: { row: 3, col: 3 } });
    fireEvent.pointerUp(rowNumber, { pointerId: 2 });

    fireEvent.keyDown(grid, { key: 'a', ctrlKey: true });
    expect(session.view.selection).toEqual({ anchor: { row: 0, col: 0 }, focus: { row: 49, col: 3 } });
  });

  it('copies the selection as tab-separated text', async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    const { grid, container } = setup();
    press(grid, 0, 0);
    press(grid, 1, 3, { shiftKey: true });
    fireEvent.keyDown(grid, { key: 'c', metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText).toHaveBeenCalledWith('SO-1\t客户1\t10.50\t\nSO-2\t客户2\t20.50\t"发票抬头：某公司\n税号：9131"');
    await waitFor(() => expect(container.querySelector('[role="status"]')?.textContent).toContain('8'));
  });

  it('adds up a range of numbers in the bar', () => {
    const { grid, container } = setup();
    press(grid, 0, 2);
    press(grid, 3, 2, { shiftKey: true });
    const status = container.querySelector('[role="status"]')?.textContent ?? '';
    expect(status).toContain('4');
    // 10.50 + 20.50 + 30.50 + 40.50
    expect(status).toContain('102');
    expect(status).toContain('25.5');
  });

  it('treats a merged cell as one cell', () => {
    const merges: GridRange[] = [{ top: 0, left: 0, bottom: 1, right: 1 }];
    const { grid, session } = setup({ merges, addressing: 'cell', columns: [{ label: 'A' }, { label: 'B' }, { label: 'C' }, { label: 'D' }] });
    press(grid, 1, 1);
    // The ring sits on the merged cell's first cell.
    expect(activeCell(grid)).toBe('0,0');
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(session.view.selection?.focus).toEqual({ row: 1, col: 2 });
  });

  it('restores the selection and the widths a previous grid left in the session', () => {
    const session = freshSession();
    session.view.selection = { anchor: { row: 4, col: 1 }, focus: { row: 4, col: 1 } };
    session.view.widths = { 1: 222 };
    const { grid } = setup({ session });
    expect(activeCell(grid)).toBe('4,1');
    expect(screen.getAllByRole('columnheader')[1]?.style.width).toBe('222px');
  });

  it('resizes a column by dragging its edge and remembers the width', () => {
    const { grid, container, session } = setup();
    const handle = container.querySelector<HTMLElement>('[data-resize="0"]');
    const header = screen.getAllByRole('columnheader')[0];
    if (!handle || !header) throw new Error('handle missing');
    const before = Number.parseFloat(header.style.width);
    fireEvent.pointerDown(handle, { button: 0, pointerId: 3, clientX: 200, clientY: 10 });
    fireEvent.pointerMove(grid, { pointerId: 3, clientX: 260, clientY: 10 });
    fireEvent.pointerUp(grid, { pointerId: 3, clientX: 260, clientY: 10 });
    expect(Number.parseFloat(screen.getAllByRole('columnheader')[0]?.style.width ?? '0')).toBe(before + 60);
    expect(session.view.widths[0]).toBe(before + 60);
    // A drag on the edge is not a click on the header: nothing got selected.
    expect(session.view.selection).toBeNull();
  });

  it('says so when there are no rows', () => {
    setup({ data: [] });
    expect(screen.getByText('没有数据')).toBeTruthy();
    expect(screen.getAllByRole('columnheader')).toHaveLength(4);
  });

  it('keeps a selection inside a table that became smaller', () => {
    const session = freshSession();
    session.view.selection = { anchor: { row: 40, col: 3 }, focus: { row: 48, col: 3 } };
    const { grid } = setup({ session, data: makeRows(10) });
    expect(activeCell(grid)).toBe('9,3');
    act(() => {
      fireEvent.keyDown(grid, { key: 'ArrowUp' });
    });
    expect(activeCell(grid)).toBe('8,3');
  });
});
