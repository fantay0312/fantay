// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/VirtualTablePreview.tsx @ c5e6b24f (MIT): the
// grid's anatomy: a sticky header row and a sticky row-number column around windowed rows, with
// column widths measured from a sample of the content.
// Changed here: rows and columns are both windowed by @tanstack/react-virtual, a cell can be
// selected, extended with Shift and copied as TSV, columns resize by dragging, merged cells are
// drawn, the selected cell's full value sits in a bar under the grid, and the look is the product's.
//
// A read-only grid shared by spreadsheets, delimited text and database tables. It draws what it is
// given: column facts, a row count, and rows that arrive in windows. Everything the reader sets
// (selection, widths, scroll position) is written into the `session` it is handed, so it survives
// the grid being unmounted.
'use client';

import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp } from 'lucide-react';
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

import { useT } from '../../../../i18n';
import { copyText } from '../../../board/interaction/file-actions';
import { IconButton } from '../../../ui';
import {
  GRID_DEFAULT_COLUMN,
  GRID_HEAD_HEIGHT,
  GRID_MAX_COLUMN,
  GRID_MIN_COLUMN,
  GRID_ROW_HEIGHT,
  GRID_CELL_PAD,
  clampSelection,
  columnAt,
  columnOffsets,
  estimateTextWidth,
  fitColumnWidths,
  formatCount,
  numericColumns,
  formatStat,
  isCollapsed,
  isNumericText,
  mergeAt,
  moveSelection,
  rangeStats,
  selectionAt,
  selectionRange,
  toTsv,
  type DataGridRow,
  type GridCell,
  type GridMove,
  type GridRange,
  type GridSelection,
} from '../sheet/grid-model';
import type { GridSession } from '../sheet/grid-session';
import type { RowWindows } from '../sheet/use-row-windows';
import styles from './DataGrid.module.css';

export interface DataGridColumn {
  label: string;
  /** Quieter text beside the label: a declared type. */
  hint?: string;
  /** The header's tooltip, when it says more than the label. */
  title?: string;
  /** The width the source asks for, in pixels. */
  width?: number;
}

export interface DataGridProps {
  /** Accessible name of the grid. */
  label: string;
  columns: readonly DataGridColumn[];
  rowCount: number;
  rows: RowWindows;
  /** Rows the column widths are measured from. */
  sample: readonly DataGridRow[];
  merges?: readonly GridRange[];
  /** Where the reader's selection, widths and scroll position live. */
  session: GridSession;
  /**
   * `cell`: a spreadsheet. Columns are letters, a cell is "C7".
   * `record`: a table of records. Columns have names, and the value bar names the column.
   */
  addressing: 'cell' | 'record';
  /** True when rows carry their own numbers, which can be longer than the row count. */
  rowLabels?: boolean;
  /**
   * `spill`: text too long for its cell runs on over the empty cells to its right, as a spreadsheet
   * draws it. `clip` (default): every cell keeps to its column and ends in an ellipsis.
   */
  overflow?: 'clip' | 'spill';
  /** Said in place of rows when there are none. */
  emptyLabel: string;
  /** Rows are still arriving. */
  busy?: boolean;
}

/** Cells copied in one go; a larger selection copies its first rows and says so. */
const MAX_COPY_CELLS = 1_000_000;
/** A selection up to this size gets its sum worked out. */
const MAX_STAT_CELLS = 20_000;
/** A cell never puts more than this into the DOM; the value bar shows the rest. */
const MAX_CELL_CHARS = 320;
const MAX_VALUE_CHARS = 20_000;
const ROW_OVERSCAN = 8;
const COLUMN_OVERSCAN = 3;
/** How close to an edge a drag starts pulling the grid along. */
const EDGE_PULL = 16;
const NO_MERGES: readonly GridRange[] = [];
/** How far left of the view a row looks for text that runs on into it. */
const SPILL_LOOKBACK = 12;

/** The fonts text is drawn in: a cell, a header name, and the type hint beside a header name. */
type MeasureFont = 'cell' | 'head' | 'hint';
type Measure = (text: string, font: MeasureFont) => number;

/** Characters whose width changes with tabular figures (in Inter: the digits and what travels with them). */
const TABULAR_CHARACTERS = '0123456789.,:%+-/ ';
/** Space between a header's name and its hint (the `gap` of `.headCell`). */
const HINT_GAP = 6;

function estimateMeasure(text: string, font: MeasureFont): number {
  return estimateTextWidth(text, font === 'cell' ? 13 : font === 'head' ? 12 : 10.5);
}

/**
 * A function that gives the width of text in the grid's fonts. Text is measured on a canvas, which
 * is fast; a canvas cannot be asked for tabular figures, though, and cells use them. So the
 * characters they change are measured once in the DOM, and the difference is added per character.
 */
function createMeasure(root: HTMLElement): Measure {
  const context = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d');
  if (!context) return estimateMeasure;
  const style = getComputedStyle(root);
  const mono = style.getPropertyValue('--font-mono').trim() || 'monospace';
  const fonts: Record<MeasureFont, string> = {
    cell: `400 13px ${style.fontFamily}`,
    head: `600 12px ${style.fontFamily}`,
    hint: `500 10.5px ${mono}`,
  };

  const probe = document.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;top:0;left:0;visibility:hidden;white-space:pre';
  probe.style.font = fonts.cell;
  probe.style.fontVariantNumeric = 'tabular-nums';
  const spans = [...TABULAR_CHARACTERS].map((character) => {
    const span = document.createElement('span');
    span.style.display = 'inline-block';
    span.textContent = character.repeat(16);
    probe.appendChild(span);
    return span;
  });
  root.appendChild(probe);
  context.font = fonts.cell;
  const extra = new Map<string, number>();
  [...TABULAR_CHARACTERS].forEach((character, index) => {
    const tabular = (spans[index]?.getBoundingClientRect().width ?? 0) / 16;
    const plain = context.measureText(character.repeat(16)).width / 16;
    if (tabular > 0 && Math.abs(tabular - plain) > 0.02) extra.set(character, tabular - plain);
  });
  probe.remove();

  return (text, font) => {
    context.font = fonts[font];
    let width = context.measureText(text).width;
    if (font === 'cell' && extra.size > 0) {
      for (let index = 0; index < text.length; index += 1) width += extra.get(text[index] ?? '') ?? 0;
    }
    // The hint is letter-spaced by 0.01em.
    return font === 'hint' ? width + text.length * 0.105 : width;
  };
}

/** The width a column's header needs: its name, and its hint when it has one. */
function headerWidth(column: DataGridColumn, measure: Measure): number {
  return measure(column.label, 'head') + (column.hint ? HINT_GAP + measure(column.hint, 'hint') : 0);
}

/** Text as one line: a cell is one row high, whatever the value holds. */
function oneLine(text: string): string {
  const flat = text.includes('\n') || text.includes('\r') ? text.replace(/\s*[\r\n]+\s*/g, ' ') : text;
  return flat.length > MAX_CELL_CHARS ? flat.slice(0, MAX_CELL_CHARS) : flat;
}

function kindOf(row: DataGridRow, column: number, text: string): string {
  const kind = row.kinds?.[column];
  if (kind !== undefined) return kind;
  return isNumericText(text) ? 'n' : 's';
}

interface RowViewProps {
  id: string;
  index: number;
  top: number;
  row: DataGridRow | undefined;
  /** Indices of the columns in view. */
  columns: readonly number[];
  offsets: readonly number[];
  gutter: number;
  /** Set when long text may run on over the empty cells to its right; it measures that text. */
  spill: ((text: string) => number) | null;
  merges: readonly GridRange[];
  /** The selected cell's column when it is in this row, else -1. */
  active: number;
}

/** One row of cells. Memoised: scrolling down draws only the rows that come into view. */
const RowView = memo(function RowView({ id, index, top, row, columns, offsets, gutter, spill, merges, active }: RowViewProps): JSX.Element {
  const cells: JSX.Element[] = [];
  const first = columns[0];
  const last = columns[columns.length - 1];
  // An empty cell is not drawn, except the selected one: assistive technology is pointed at it.
  if (active >= 0 && !row?.cells[active]) {
    const left = offsets[active] ?? 0;
    cells.push(
      <div
        key={`active-${active}`}
        id={`${id}-${index}-${active}`}
        role="gridcell"
        aria-colindex={active + 1}
        className={styles.cell}
        style={{ left: left + gutter, width: (offsets[active + 1] ?? left) - left }}
      />,
    );
  }
  if (row && first !== undefined && last !== undefined) {
    const columnCount = offsets.length - 1;
    const taken = spill && merges.length > 0 ? merges.filter((merge) => merge.top <= index && merge.bottom >= index) : NO_MERGES;
    const inMerge = (column: number): boolean => taken.some((merge) => merge.left <= column && merge.right >= column);
    let start = first;
    if (spill) {
      // Text that starts left of the view can still reach into it.
      let back = first - 1;
      while (back >= 0 && first - back <= SPILL_LOOKBACK && !row.cells[back]) back -= 1;
      if (back >= 0 && first - back <= SPILL_LOOKBACK) start = back;
    }
    for (let column = start; column <= last; column += 1) {
      const text = row.cells[column];
      if (!text) continue;
      const kind = kindOf(row, column, text);
      const shown = oneLine(text);
      const left = offsets[column] ?? 0;
      let end = column;
      if (spill && kind === 's' && !inMerge(column)) {
        const own = (offsets[column + 1] ?? left) - left;
        // No character is wider than 14px: text this short fits without being measured.
        const needed = shown.length * 14 > own - GRID_CELL_PAD ? spill(shown) + GRID_CELL_PAD : 0;
        while (needed > (offsets[end + 1] ?? left) - left && end + 1 < columnCount && !row.cells[end + 1] && !inMerge(end + 1)) end += 1;
      }
      if (end < first) continue;
      cells.push(
        <div
          key={column}
          id={`${id}-${index}-${column}`}
          role="gridcell"
          aria-colindex={column + 1}
          className={styles.cell}
          data-kind={kind}
          data-spill={end > column || undefined}
          style={{ left: left + gutter, width: (offsets[end + 1] ?? left) - left }}
        >
          {shown}
        </div>,
      );
    }
  }
  return (
    <div role="row" aria-rowindex={index + 2} className={styles.row} style={{ top }}>
      {cells}
    </div>
  );
});

export function DataGrid({
  label,
  columns,
  rowCount,
  rows,
  sample,
  merges = NO_MERGES,
  session,
  addressing,
  rowLabels = false,
  overflow = 'clip',
  emptyLabel,
  busy = false,
}: DataGridProps): JSX.Element {
  const t = useT();
  const id = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const columnCount = columns.length;

  // ── column widths ─────────────────────────────────────────────────────────────────────────────
  const measureRef = useRef<Measure | null>(null);
  const [fitted, setFitted] = useState<{ widths: number[]; numeric: boolean[] } | null>(null);
  const [custom, setCustom] = useState<Record<number, number>>(() => session.view.widths);

  // Widths come from the text itself, measured in the grid's own fonts. This runs before paint, so
  // the grid never shows a first frame with guessed widths.
  useLayoutEffect(() => {
    if (!measureRef.current) measureRef.current = rootRef.current ? createMeasure(rootRef.current) : estimateMeasure;
    const measure = measureRef.current;
    setFitted({
      widths: fitColumnWidths({
        columnCount: columns.length,
        headerWidths: columns.map((column) => headerWidth(column, measure)),
        sample,
        measure: (text) => measure(text, 'cell'),
        preset: columns.map((column) => column.width),
      }),
      numeric: numericColumns(sample, columns.length),
    });
  }, [columns, sample]);
  const measureCell = useCallback((text: string) => (measureRef.current ?? estimateMeasure)(text, 'cell'), []);

  const widths = useMemo(
    () => (fitted && fitted.widths.length === columnCount ? fitted.widths.map((width, index) => custom[index] ?? width) : null),
    [fitted, custom, columnCount],
  );
  const offsets = useMemo(() => columnOffsets(widths ?? []), [widths]);
  const ready = widths !== null;

  const gutter = useMemo(() => {
    const digits = String(Math.max(1, rowCount)).length + (rowLabels ? 1 : 0);
    return Math.max(40, Math.round(digits * 7.4 + 18));
  }, [rowCount, rowLabels]);

  // ── windows ───────────────────────────────────────────────────────────────────────────────────
  const rowVirtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollerRef.current,
    estimateSize: () => GRID_ROW_HEIGHT,
    overscan: ROW_OVERSCAN,
    paddingStart: GRID_HEAD_HEIGHT,
    initialOffset: session.view.scrollTop,
  });
  const columnVirtualizer = useVirtualizer({
    horizontal: true,
    count: ready ? columnCount : 0,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => widths?.[index] ?? GRID_DEFAULT_COLUMN,
    overscan: COLUMN_OVERSCAN,
    paddingStart: gutter,
    initialOffset: session.view.scrollLeft,
  });
  // The virtualizer caches sizes; a resized column has to be read again.
  useLayoutEffect(() => {
    columnVirtualizer.measure();
  }, [columnVirtualizer, widths]);

  const virtualRows = rowVirtualizer.getVirtualItems();
  const virtualColumns = columnVirtualizer.getVirtualItems();
  const firstRow = virtualRows[0]?.index ?? 0;
  const lastRow = virtualRows[virtualRows.length - 1]?.index ?? -1;
  const firstColumn = virtualColumns[0]?.index ?? 0;
  const lastColumn = virtualColumns[virtualColumns.length - 1]?.index ?? -1;
  const visibleColumns = useMemo(() => {
    const list: number[] = [];
    for (let column = firstColumn; column <= lastColumn; column += 1) list.push(column);
    return list;
  }, [firstColumn, lastColumn]);

  const { ensureRows, getRow, readRows } = rows;
  useEffect(() => {
    if (lastRow >= firstRow) ensureRows(firstRow, lastRow + 1);
  }, [ensureRows, firstRow, lastRow, rowCount]);

  // ── scroll position ───────────────────────────────────────────────────────────────────────────
  // Restored once the grid has its real size, and only recorded after that: the first scroll event
  // of an empty grid must not overwrite where the reader was.
  const restored = useRef(false);
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller || !ready || restored.current) return;
    scroller.scrollTop = session.view.scrollTop;
    scroller.scrollLeft = session.view.scrollLeft;
    restored.current = true;
  }, [ready, session]);
  const [scrolledX, setScrolledX] = useState(session.view.scrollLeft > 0);
  const onScroll = (): void => {
    const scroller = scrollerRef.current;
    if (!scroller || !restored.current) return;
    session.view.scrollTop = scroller.scrollTop;
    session.view.scrollLeft = scroller.scrollLeft;
    setScrolledX(scroller.scrollLeft > 0);
  };

  // ── selection ─────────────────────────────────────────────────────────────────────────────────
  const [stored, setStored] = useState<GridSelection | null>(() => session.view.selection);
  // The file can have fewer rows than when the selection was made.
  const selection = useMemo(() => clampSelection(stored, rowCount, columnCount), [stored, rowCount, columnCount]);
  const select = useCallback(
    (next: GridSelection | null) => {
      session.view.selection = next;
      setStored(next);
    },
    [session],
  );
  const range = useMemo(() => (selection ? selectionRange(selection, merges) : null), [selection, merges]);
  const focusCell = selection?.focus ?? null;
  const focusMerge = focusCell ? mergeAt(merges, focusCell) : undefined;
  const activeCell: GridCell | null = focusCell ? (focusMerge ? { row: focusMerge.top, col: focusMerge.left } : focusCell) : null;

  const reveal = useCallback(
    (cell: GridCell) => {
      const scroller = scrollerRef.current;
      if (!scroller) return;
      const top = GRID_HEAD_HEIGHT + cell.row * GRID_ROW_HEIGHT;
      if (top < scroller.scrollTop + GRID_HEAD_HEIGHT) scroller.scrollTop = top - GRID_HEAD_HEIGHT;
      else if (top + GRID_ROW_HEIGHT > scroller.scrollTop + scroller.clientHeight) scroller.scrollTop = top + GRID_ROW_HEIGHT - scroller.clientHeight;
      const left = gutter + (offsets[cell.col] ?? 0);
      const right = gutter + (offsets[cell.col + 1] ?? 0);
      if (left < scroller.scrollLeft + gutter) scroller.scrollLeft = left - gutter;
      else if (right > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = Math.min(left - gutter, right - scroller.clientWidth);
    },
    [gutter, offsets],
  );

  // ── copying ───────────────────────────────────────────────────────────────────────────────────
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    },
    [],
  );
  const say = useCallback((text: string) => {
    setNotice(text);
    if (noticeTimer.current !== null) window.clearTimeout(noticeTimer.current);
    noticeTimer.current = window.setTimeout(() => setNotice(null), 2000);
  }, []);

  const copySelection = useCallback(async () => {
    if (!range) return;
    const width = range.right - range.left + 1;
    const wanted = range.bottom - range.top + 1;
    const taken = Math.min(wanted, Math.max(1, Math.floor(MAX_COPY_CELLS / width)));
    try {
      const data = await readRows(range.top, range.top + taken);
      const text = toTsv(
        data.map((row) => {
          const cells: string[] = [];
          for (let column = range.left; column <= range.right; column += 1) cells.push(row.cells[column] ?? '');
          return cells;
        }),
      );
      if (!(await copyText(text))) {
        say(t('artifact.grid.copyFailed'));
      } else if (taken < wanted) {
        say(t('artifact.grid.copiedPart', { rows: formatCount(taken) }));
      } else {
        say(t('artifact.grid.copied', { count: formatCount(data.length * width) }));
      }
    } catch {
      say(t('artifact.grid.copyFailed'));
    }
  }, [range, readRows, say, t]);

  // ── keyboard ──────────────────────────────────────────────────────────────────────────────────
  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (rowCount <= 0 || columnCount <= 0 || event.altKey) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;
    if (mod && (key === 'c' || key === 'C')) {
      // Text the reader selected in the value bar is theirs to copy.
      if (!range || (window.getSelection()?.toString() ?? '') !== '') return;
      event.preventDefault();
      void copySelection();
      return;
    }
    if (mod && (key === 'a' || key === 'A')) {
      event.preventDefault();
      select({ anchor: { row: 0, col: 0 }, focus: { row: rowCount - 1, col: columnCount - 1 } });
      return;
    }
    if (key === 'Escape') {
      if (selection) {
        event.preventDefault();
        select(null);
      }
      return;
    }
    let move: GridMove | null = null;
    if (key === 'ArrowUp') move = mod ? 'columnStart' : 'up';
    else if (key === 'ArrowDown') move = mod ? 'columnEnd' : 'down';
    else if (key === 'ArrowLeft') move = mod ? 'rowStart' : 'left';
    else if (key === 'ArrowRight') move = mod ? 'rowEnd' : 'right';
    else if (key === 'PageUp') move = 'pageUp';
    else if (key === 'PageDown') move = 'pageDown';
    else if (key === 'Home') move = mod ? 'gridStart' : 'rowStart';
    else if (key === 'End') move = mod ? 'gridEnd' : 'rowEnd';
    if (!move) return;
    event.preventDefault();
    if (!selection) {
      // Nothing selected yet: the first key lands on the first cell in view.
      const scroller = scrollerRef.current;
      const row = scroller ? Math.min(rowCount - 1, Math.ceil(scroller.scrollTop / GRID_ROW_HEIGHT)) : 0;
      const col = scroller ? columnAt(offsets, scroller.scrollLeft + 1) : 0;
      select(selectionAt({ row, col }));
      return;
    }
    const scroller = scrollerRef.current;
    const page = scroller ? Math.max(1, Math.floor((scroller.clientHeight - GRID_HEAD_HEIGHT) / GRID_ROW_HEIGHT) - 1) : 10;
    const next = moveSelection(selection, move, { rows: rowCount, cols: columnCount, extend: event.shiftKey, page, merges });
    select(next);
    reveal(next.focus);
  };

  // ── pointer ───────────────────────────────────────────────────────────────────────────────────
  const drag = useRef<{ pointer: number; anchor: GridCell; mode: 'cell' | 'row' | 'column' } | null>(null);
  const resize = useRef<{ pointer: number; column: number; startX: number; startWidth: number } | null>(null);
  const [resizing, setResizing] = useState<number | null>(null);

  /** What is under a point: a body cell (clamped to the grid), or the header, the gutter, the corner. */
  const locate = (clientX: number, clientY: number): { zone: 'body' | 'head' | 'gutter' | 'corner' | 'outside'; cell: GridCell } => {
    const scroller = scrollerRef.current;
    const none = { zone: 'outside' as const, cell: { row: 0, col: 0 } };
    if (!scroller) return none;
    const box = scroller.getBoundingClientRect();
    const x = clientX - box.left;
    const y = clientY - box.top;
    const contentX = x + scroller.scrollLeft - gutter;
    const contentY = y + scroller.scrollTop - GRID_HEAD_HEIGHT;
    const cell = {
      row: Math.min(rowCount - 1, Math.max(0, Math.floor(contentY / GRID_ROW_HEIGHT))),
      col: columnAt(offsets, Math.max(0, contentX)),
    };
    if (x > scroller.clientWidth || y > scroller.clientHeight) return { zone: 'outside', cell };
    const inHead = y < GRID_HEAD_HEIGHT;
    const inGutter = x < gutter;
    if (inHead && inGutter) return { zone: 'corner', cell };
    const pastColumns = contentX >= (offsets[columnCount] ?? 0);
    const pastRows = contentY >= rowCount * GRID_ROW_HEIGHT;
    if (inHead) return { zone: pastColumns ? 'outside' : 'head', cell };
    if (inGutter) return { zone: pastRows ? 'outside' : 'gutter', cell };
    return { zone: pastColumns || pastRows ? 'outside' : 'body', cell };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    // A press on the scroller itself is a press on its scrollbar.
    if (event.button !== 0 || !ready || rowCount <= 0 || columnCount <= 0 || event.target === event.currentTarget) return;
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize]');
    if (handle) {
      const column = Number(handle.dataset.resize);
      resize.current = { pointer: event.pointerId, column, startX: event.clientX, startWidth: widths?.[column] ?? GRID_DEFAULT_COLUMN };
      setResizing(column);
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      return;
    }
    const hit = locate(event.clientX, event.clientY);
    if (hit.zone === 'outside') return;
    const lastCell = { row: rowCount - 1, col: columnCount - 1 };
    if (hit.zone === 'corner') {
      select({ anchor: { row: 0, col: 0 }, focus: lastCell });
      return;
    }
    const extendFrom = event.shiftKey && selection ? selection.anchor : null;
    if (hit.zone === 'head') {
      const anchor = extendFrom ?? { row: 0, col: hit.cell.col };
      select({ anchor: { row: 0, col: anchor.col }, focus: { row: lastCell.row, col: hit.cell.col } });
      drag.current = { pointer: event.pointerId, anchor: { row: 0, col: anchor.col }, mode: 'column' };
    } else if (hit.zone === 'gutter') {
      const anchor = extendFrom ?? { row: hit.cell.row, col: 0 };
      select({ anchor: { row: anchor.row, col: 0 }, focus: { row: hit.cell.row, col: lastCell.col } });
      drag.current = { pointer: event.pointerId, anchor: { row: anchor.row, col: 0 }, mode: 'row' };
    } else {
      const anchor = extendFrom ?? hit.cell;
      select({ anchor, focus: hit.cell });
      drag.current = { pointer: event.pointerId, anchor, mode: 'cell' };
    }
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Moves the focus of a drag to the cell under a point. */
  const extendTo = (clientX: number, clientY: number): void => {
    const dragging = drag.current;
    if (!dragging) return;
    const { cell } = locate(clientX, clientY);
    const focus =
      dragging.mode === 'column'
        ? { row: rowCount - 1, col: cell.col }
        : dragging.mode === 'row'
          ? { row: cell.row, col: columnCount - 1 }
          : cell;
    if (selection && selection.focus.row === focus.row && selection.focus.col === focus.col) return;
    select({ anchor: dragging.anchor, focus });
  };
  // The timer below outlives a render; it calls the latest version.
  const extendRef = useRef(extendTo);
  extendRef.current = extendTo;
  const autoScroll = useRef<{ timer: number | null; x: number; y: number; clientX: number; clientY: number }>({ timer: null, x: 0, y: 0, clientX: 0, clientY: 0 });
  const stopPull = useCallback(() => {
    const pull = autoScroll.current;
    if (pull.timer !== null) window.clearInterval(pull.timer);
    pull.timer = null;
  }, []);
  useEffect(() => stopPull, [stopPull]);

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const sizing = resize.current;
    if (sizing && sizing.pointer === event.pointerId) {
      const width = Math.round(Math.min(GRID_MAX_COLUMN, Math.max(GRID_MIN_COLUMN, sizing.startWidth + event.clientX - sizing.startX)));
      setCustom((previous) => {
        if (previous[sizing.column] === width) return previous;
        const next = { ...previous, [sizing.column]: width };
        session.view.widths = next;
        return next;
      });
      return;
    }
    const dragging = drag.current;
    if (!dragging || dragging.pointer !== event.pointerId) return;
    const scroller = scrollerRef.current;
    const pull = autoScroll.current;
    pull.clientX = event.clientX;
    pull.clientY = event.clientY;
    pull.x = 0;
    pull.y = 0;
    if (scroller) {
      // Held at (or past) an edge, the pointer pulls the grid along, a step at a time.
      const box = scroller.getBoundingClientRect();
      if (dragging.mode !== 'column') {
        if (event.clientY > box.bottom - EDGE_PULL) pull.y = GRID_ROW_HEIGHT;
        else if (event.clientY < box.top + GRID_HEAD_HEIGHT + EDGE_PULL / 2) pull.y = -GRID_ROW_HEIGHT;
      }
      if (dragging.mode !== 'row') {
        if (event.clientX > box.right - EDGE_PULL) pull.x = 48;
        else if (event.clientX < box.left + gutter + EDGE_PULL / 2) pull.x = -48;
      }
    }
    if (pull.x === 0 && pull.y === 0) stopPull();
    else if (pull.timer === null) {
      pull.timer = window.setInterval(() => {
        const element = scrollerRef.current;
        if (!element || !drag.current) {
          stopPull();
          return;
        }
        element.scrollBy(pull.x, pull.y);
        extendRef.current(pull.clientX, pull.clientY);
      }, 60);
    }
    extendTo(event.clientX, event.clientY);
  };

  const endPointer = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (resize.current?.pointer === event.pointerId) {
      resize.current = null;
      setResizing(null);
    }
    if (drag.current?.pointer === event.pointerId) {
      drag.current = null;
      stopPull();
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  /** A double click on a column's edge fits it to the rows in view. */
  const onDoubleClick = (event: ReactMouseEvent<HTMLDivElement>): void => {
    const handle = (event.target as HTMLElement).closest<HTMLElement>('[data-resize]');
    const measure = measureRef.current;
    if (!handle || !measure) return;
    const column = Number(handle.dataset.resize);
    const header = columns[column];
    let widest = header ? headerWidth(header, measure) : 0;
    for (let index = firstRow; index <= lastRow; index += 1) {
      const text = getRow(index)?.cells[column];
      if (text) widest = Math.max(widest, measure(oneLine(text), 'cell'));
    }
    const width = Math.round(Math.min(GRID_MAX_COLUMN, Math.max(GRID_MIN_COLUMN, widest + GRID_CELL_PAD + 2)));
    setCustom((previous) => {
      const next = { ...previous, [column]: width };
      session.view.widths = next;
      return next;
    });
  };

  // ── the selected cell's value ─────────────────────────────────────────────────────────────────
  const activeRow = activeCell ? getRow(activeCell.row) : undefined;
  const activeText = activeCell ? (activeRow?.cells[activeCell.col] ?? '') : '';
  const activeNote = activeCell ? activeRow?.notes?.[activeCell.col] : undefined;
  const activeColumn = activeCell ? columns[activeCell.col] : undefined;
  const address = !activeCell
    ? ''
    : addressing === 'cell'
      ? `${activeColumn?.label ?? ''}${activeRow?.label ?? activeCell.row + 1}`
      : (activeColumn?.label ?? '');

  const stats = useMemo(() => {
    if (!range || !selection || isCollapsed(selection)) return null;
    const height = range.bottom - range.top + 1;
    const width = range.right - range.left + 1;
    const size = t('artifact.grid.size', { rows: formatCount(height), cols: formatCount(width) });
    if (height * width > MAX_STAT_CELLS) return size;
    const data: (DataGridRow | undefined)[] = [];
    for (let index = range.top; index <= range.bottom; index += 1) data.push(getRow(index));
    const totals = rangeStats(data, range.left, range.right);
    if (!totals || totals.numbers < 2) return size;
    return [
      size,
      t('artifact.grid.sum', { value: formatStat(totals.sum, totals.percent) }),
      t('artifact.grid.average', { value: formatStat(totals.sum / totals.numbers, totals.percent) }),
    ].join(' · ');
  }, [getRow, range, selection, t]);

  const valueRef = useRef<HTMLSpanElement | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  // The one-line bar offers "show all" only when the value does not fit.
  useLayoutEffect(() => {
    const element = valueRef.current;
    if (!element || expanded) return;
    setOverflowing(element.scrollWidth > element.clientWidth + 1);
  }, [activeText, activeNote, expanded, notice, stats]);

  // ── geometry ──────────────────────────────────────────────────────────────────────────────────
  const totalWidth = columnVirtualizer.getTotalSize();
  const totalHeight = rowVirtualizer.getTotalSize();
  const rect = (area: GridRange): { top: number; left: number; width: number; height: number } => ({
    top: GRID_HEAD_HEIGHT + area.top * GRID_ROW_HEIGHT,
    left: gutter + (offsets[area.left] ?? 0),
    width: (offsets[area.right + 1] ?? 0) - (offsets[area.left] ?? 0),
    height: (area.bottom - area.top + 1) * GRID_ROW_HEIGHT,
  });
  const visibleMerges =
    merges.length === 0 || lastRow < firstRow
      ? NO_MERGES
      : merges.filter((merge) => merge.bottom >= firstRow && merge.top <= lastRow && merge.right >= firstColumn && merge.left <= lastColumn);
  const activeId = activeCell ? `${id}-${activeCell.row}-${activeCell.col}` : undefined;
  const empty = rowCount <= 0 || columnCount <= 0;

  return (
    <div ref={rootRef} className={styles.root} data-resizing={resizing !== null || undefined} data-scrolled-x={scrolledX || undefined}>
      <div
        ref={scrollerRef}
        className={styles.scroller}
        role="grid"
        tabIndex={0}
        aria-label={label}
        aria-rowcount={rowCount + 1}
        aria-colcount={columnCount}
        aria-busy={busy || undefined}
        aria-readonly="true"
        aria-multiselectable="true"
        aria-activedescendant={activeId}
        data-artifact-grid=""
        onScroll={onScroll}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endPointer}
        onPointerCancel={endPointer}
        onDoubleClick={onDoubleClick}
      >
        {ready ? (
          <div className={styles.canvas} role="presentation" style={{ width: totalWidth, height: empty ? GRID_HEAD_HEIGHT : totalHeight }}>
            <div role="row" aria-rowindex={1} className={styles.head}>
              <div className={styles.corner} style={{ width: gutter }} title={t('artifact.grid.selectAll')} />
              {virtualColumns.map((item) => {
                const column = columns[item.index];
                if (!column) return null;
                const selected = range !== null && item.index >= range.left && item.index <= range.right;
                return (
                  <div
                    key={item.index}
                    role="columnheader"
                    aria-colindex={item.index + 1}
                    className={styles.headCell}
                    data-align={addressing === 'cell' ? 'center' : fitted?.numeric[item.index] ? 'end' : undefined}
                    data-selected={selected || undefined}
                    data-resizing={resizing === item.index || undefined}
                    style={{ left: item.start, width: item.size }}
                    title={column.title ?? (column.hint ? `${column.label} · ${column.hint}` : column.label)}
                  >
                    <span className={styles.headLabel}>{column.label}</span>
                    {column.hint ? <span className={styles.headHint}>{column.hint}</span> : null}
                    <span className={styles.resizer} data-resize={item.index} aria-hidden="true" />
                  </div>
                );
              })}
            </div>
            {empty ? null : (
              <>
                <div className={styles.gutter} style={{ width: gutter, height: totalHeight - GRID_HEAD_HEIGHT }} aria-hidden="true">
                  {virtualRows.map((item) => (
                    <div
                      key={item.index}
                      className={styles.rowHead}
                      data-selected={(range !== null && item.index >= range.top && item.index <= range.bottom) || undefined}
                      style={{ top: item.start - GRID_HEAD_HEIGHT }}
                    >
                      {getRow(item.index)?.label ?? item.index + 1}
                    </div>
                  ))}
                </div>
                {virtualColumns.map((item) => (
                  <div key={item.index} className={styles.columnLine} style={{ left: item.end - 1 }} aria-hidden="true" />
                ))}
                {virtualRows.map((item) => (
                  <RowView
                    key={item.index}
                    id={id}
                    index={item.index}
                    top={item.start}
                    row={getRow(item.index)}
                    columns={visibleColumns}
                    offsets={offsets}
                    gutter={gutter}
                    spill={overflow === 'spill' ? measureCell : null}
                    merges={merges}
                    active={activeCell && activeCell.row === item.index ? activeCell.col : -1}
                  />
                ))}
                {visibleMerges.map((merge) => {
                  const row = getRow(merge.top);
                  const text = row?.cells[merge.left] ?? '';
                  return (
                    <div
                      key={`${merge.top}:${merge.left}`}
                      className={styles.merge}
                      aria-hidden="true"
                      data-kind={row && text ? kindOf(row, merge.left, text) : undefined}
                      data-center={merge.right > merge.left || undefined}
                      style={rect(merge)}
                    >
                      <span>{oneLine(text)}</span>
                    </div>
                  );
                })}
                {range && selection && !isCollapsed(selection) ? <div className={styles.range} style={rect(range)} aria-hidden="true" /> : null}
                {activeCell ? (
                  <div
                    className={styles.active}
                    aria-hidden="true"
                    style={rect(focusMerge ?? { top: activeCell.row, bottom: activeCell.row, left: activeCell.col, right: activeCell.col })}
                  />
                ) : null}
              </>
            )}
          </div>
        ) : null}
        {ready && empty ? <p className={styles.empty}>{emptyLabel}</p> : null}
      </div>

      <div className={styles.valueBar} data-open={activeCell !== null || undefined} data-expanded={expanded || undefined} aria-hidden={activeCell === null}>
        <div className={styles.valueClip}>
          <div className={styles.valueRow}>
            <span className={styles.address} data-addressing={addressing}>
              {address}
            </span>
            <span ref={valueRef} className={styles.value} data-empty={activeText === '' || undefined}>
              {activeText.length > MAX_VALUE_CHARS ? activeText.slice(0, MAX_VALUE_CHARS) : activeText}
              {activeNote ? <span className={styles.note}>{activeNote}</span> : null}
            </span>
            {notice || stats ? (
              <span className={styles.stats} role="status">
                {notice ?? stats}
              </span>
            ) : null}
            {overflowing || expanded ? (
              <IconButton
                size="xs"
                className={styles.expand}
                aria-label={expanded ? t('artifact.grid.collapseValue') : t('artifact.grid.expandValue')}
                tooltipSide="top"
                tabIndex={activeCell === null ? -1 : 0}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? <ChevronDown aria-hidden="true" strokeWidth={1.75} /> : <ChevronUp aria-hidden="true" strokeWidth={1.75} />}
              </IconButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
