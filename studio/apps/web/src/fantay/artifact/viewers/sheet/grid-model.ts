// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/office/sheet-cells.ts @ c5e6b24f (MIT; that file is
// itself adapted from opencode, MIT, Copyright (c) 2025 opencode): column letters, growing a range
// over the merged cells it touches, and how the active cell steps around a merged cell.
// Changed here: the selection is a plain anchor / focus pair instead of the spreadsheet engine's
// type, the sheet's size is a parameter, and the rest of the grid's arithmetic (keyboard moves, TSV,
// column widths, the header guess) is added. Pure: no React, no DOM, so tests and workers share it.

export interface GridCell {
  row: number;
  col: number;
}

/** Inclusive on every side. */
export interface GridRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

/** `anchor` is where the selection started, `focus` is the active cell. */
export interface GridSelection {
  anchor: GridCell;
  focus: GridCell;
}

/** One row as the grid draws it. */
export interface DataGridRow {
  /** The text of each cell, as shown. May be shorter than the column count. */
  cells: readonly string[];
  /**
   * One character per cell saying what the value is: `n` number or date, `b` boolean, `e` error,
   * `z` an absent value (NULL), `x` binary, anything else text. Omitted when the source has no
   * types (delimited text); the grid then looks at the text.
   */
  kinds?: string;
  /** The row's own number when it is not its position (a sheet with hidden rows). */
  label?: string;
  /** Extra text for a cell, by column: the formula behind a calculated value. */
  notes?: Readonly<Record<number, string>>;
}

export const GRID_ROW_HEIGHT = 28;
export const GRID_HEAD_HEIGHT = 30;
export const GRID_MIN_COLUMN = 44;
export const GRID_MAX_COLUMN = 720;
/** A column sized from its content never opens wider than this; the reader can drag it further. */
export const GRID_MAX_FIT_COLUMN = 320;
export const GRID_DEFAULT_COLUMN = 104;
/** Left plus right padding of a cell. */
export const GRID_CELL_PAD = 20;

/** A column's letters: 0 → "A", 25 → "Z", 26 → "AA". */
export function columnLabel(index: number): string {
  let label = '';
  for (let value = Math.max(0, Math.floor(index)) + 1; value > 0; value = Math.floor((value - 1) / 26)) {
    label = String.fromCharCode(65 + ((value - 1) % 26)) + label;
  }
  return label;
}

export function sameCell(a: GridCell, b: GridCell): boolean {
  return a.row === b.row && a.col === b.col;
}

export function selectionAt(cell: GridCell): GridSelection {
  return { anchor: cell, focus: cell };
}

export function isCollapsed(selection: GridSelection): boolean {
  return sameCell(selection.anchor, selection.focus);
}

function contains(range: GridRange, cell: GridCell): boolean {
  return cell.row >= range.top && cell.row <= range.bottom && cell.col >= range.left && cell.col <= range.right;
}

function overlaps(a: GridRange, b: GridRange): boolean {
  return a.left <= b.right && a.right >= b.left && a.top <= b.bottom && a.bottom >= b.top;
}

/** The merged cell that holds `cell`, if any. */
export function mergeAt(merges: readonly GridRange[], cell: GridCell): GridRange | undefined {
  for (const merge of merges) if (contains(merge, cell)) return merge;
  return undefined;
}

/** Grows a range until it covers every merged cell it touches, as a spreadsheet selects. */
export function coverMerges(range: GridRange, merges: readonly GridRange[]): GridRange {
  if (merges.length === 0) return range;
  let grown = range;
  // Each pass can only grow the range, and a range can swallow each merge once: this ends.
  for (let pass = 0; pass <= merges.length; pass += 1) {
    let next = grown;
    for (const merge of merges) {
      if (!overlaps(next, merge)) continue;
      next = {
        top: Math.min(next.top, merge.top),
        left: Math.min(next.left, merge.left),
        bottom: Math.max(next.bottom, merge.bottom),
        right: Math.max(next.right, merge.right),
      };
    }
    if (next.top === grown.top && next.left === grown.left && next.bottom === grown.bottom && next.right === grown.right) break;
    grown = next;
  }
  return grown;
}

/** The rectangle a selection covers, grown over merged cells. */
export function selectionRange(selection: GridSelection, merges: readonly GridRange[] = []): GridRange {
  return coverMerges(
    {
      top: Math.min(selection.anchor.row, selection.focus.row),
      left: Math.min(selection.anchor.col, selection.focus.col),
      bottom: Math.max(selection.anchor.row, selection.focus.row),
      right: Math.max(selection.anchor.col, selection.focus.col),
    },
    merges,
  );
}

export function clampCell(cell: GridCell, rows: number, cols: number): GridCell {
  return {
    row: Math.min(Math.max(0, rows - 1), Math.max(0, cell.row)),
    col: Math.min(Math.max(0, cols - 1), Math.max(0, cell.col)),
  };
}

/** A selection that still fits a grid of this size (the file changed and has fewer rows now). */
export function clampSelection(selection: GridSelection | null, rows: number, cols: number): GridSelection | null {
  if (!selection || rows <= 0 || cols <= 0) return null;
  return { anchor: clampCell(selection.anchor, rows, cols), focus: clampCell(selection.focus, rows, cols) };
}

export type GridMove =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pageUp'
  | 'pageDown'
  /** First / last column of the row. */
  | 'rowStart'
  | 'rowEnd'
  /** First / last row of the column. */
  | 'columnStart'
  | 'columnEnd'
  /** The first / last cell of the grid. */
  | 'gridStart'
  | 'gridEnd';

export interface GridMoveOptions {
  rows: number;
  cols: number;
  /** Keeps the anchor and moves only the focus (Shift). */
  extend?: boolean;
  /** Rows a page key moves by. */
  page?: number;
  merges?: readonly GridRange[];
}

/** One step along an axis that started inside a merged cell: past its far edge, or where it was. */
function past(from: number, to: number, low: number, high: number): number {
  if (to > from) return high + 1;
  if (to < from) return low - 1;
  return from;
}

/**
 * Where a key moves the selection. A collapsed selection walks around merged cells the way a
 * spreadsheet's active cell does: landing in one selects its first cell, and a step that would stay
 * inside the merged cell it started from steps past it.
 */
export function moveSelection(selection: GridSelection, move: GridMove, options: GridMoveOptions): GridSelection {
  const { rows, cols, extend = false, page = 10, merges = [] } = options;
  const from = selection.focus;
  let target: GridCell;
  switch (move) {
    case 'up':
      target = { row: from.row - 1, col: from.col };
      break;
    case 'down':
      target = { row: from.row + 1, col: from.col };
      break;
    case 'left':
      target = { row: from.row, col: from.col - 1 };
      break;
    case 'right':
      target = { row: from.row, col: from.col + 1 };
      break;
    case 'pageUp':
      target = { row: from.row - Math.max(1, page), col: from.col };
      break;
    case 'pageDown':
      target = { row: from.row + Math.max(1, page), col: from.col };
      break;
    case 'rowStart':
      target = { row: from.row, col: 0 };
      break;
    case 'rowEnd':
      target = { row: from.row, col: cols - 1 };
      break;
    case 'columnStart':
      target = { row: 0, col: from.col };
      break;
    case 'columnEnd':
      target = { row: rows - 1, col: from.col };
      break;
    case 'gridStart':
      target = { row: 0, col: 0 };
      break;
    default:
      target = { row: rows - 1, col: cols - 1 };
  }

  if (extend) return { anchor: selection.anchor, focus: clampCell(target, rows, cols) };

  const single = move === 'up' || move === 'down' || move === 'left' || move === 'right';
  const inside = single ? mergeAt(merges, from) : undefined;
  if (inside && contains(inside, target)) {
    target = {
      row: past(from.row, target.row, inside.top, inside.bottom),
      col: past(from.col, target.col, inside.left, inside.right),
    };
  }
  target = clampCell(target, rows, cols);
  const landed = mergeAt(merges, target);
  // A step that could not leave the merged cell (it touches the edge of the grid) stays put.
  if (landed && inside === landed) return selectionAt(from);
  return selectionAt(landed ? { row: landed.top, col: landed.left } : target);
}

/**
 * Rows as tab-separated text for the clipboard. A cell that holds a tab, a line break or a quote is
 * quoted with doubled quotes, which is what spreadsheets write and read back.
 */
export function toTsv(rows: readonly (readonly string[])[]): string {
  return rows
    .map((row) => row.map((cell) => (/[\t\n\r"]/.test(cell) ? `"${cell.replaceAll('"', '""')}"` : cell)).join('\t'))
    .join('\n');
}

const NUMERIC = /^[-+]?[¥$€£]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?(?:[eE][-+]?\d+)?%?$/;

/** True when text reads as a number: "1,204", "-3.5", "12%", "¥98.00", "1e6". Used to align delimited text. */
export function isNumericText(text: string): boolean {
  if (text.length === 0 || text.length > 32) return false;
  const first = text.charCodeAt(0);
  // A digit, a sign, a decimal point or a currency sign: anything else is not a number.
  if (!((first >= 48 && first <= 57) || first === 43 || first === 45 || first === 46 || first > 127 || first === 36)) return false;
  return /\d/.test(text) && NUMERIC.test(text);
}

/**
 * Guesses whether the first row of delimited text names the columns. Each column votes: a name
 * over a column of numbers, or a name whose length differs from a column of same-length values,
 * says "header"; a first cell that looks like the rest says "data". Text-only tables fall back to
 * "the first row has a distinct, non-empty name in every column".
 */
export function looksLikeHeader(rows: readonly (readonly string[])[]): boolean {
  const first = rows[0];
  if (!first || first.length === 0) return false;
  const names = first.map((cell) => cell.trim());
  if (names.some((name) => name.length === 0)) return false;
  const body = rows.slice(1, 41);
  if (body.length === 0) return names.every((name) => !isNumericText(name));

  let votes = 0;
  for (let column = 0; column < names.length; column += 1) {
    const values = body.map((row) => (row[column] ?? '').trim()).filter((value) => value.length > 0);
    if (values.length === 0) continue;
    const name = names[column] ?? '';
    const numeric = values.filter(isNumericText).length >= values.length * 0.8;
    if (numeric) {
      votes += isNumericText(name) ? -1 : 1;
      continue;
    }
    // Codes and dates share one length. Short words do too, by chance (two-character names under a
    // two-character heading), so a matching length only counts against a header when it is long.
    const length = values[0]?.length ?? 0;
    if (values.length > 1 && values.every((value) => value.length === length)) {
      if (name.length !== length) votes += 1;
      else if (length >= 4) votes -= 1;
    }
  }
  if (votes !== 0) return votes > 0;
  return new Set(names).size === names.length && names.every((name) => !isNumericText(name));
}

export interface FitColumnsInput {
  columnCount: number;
  /** The width each column's header needs, in pixels, without padding. */
  headerWidths: readonly number[];
  /** Rows to size the columns from. */
  sample: readonly DataGridRow[];
  /** Width in pixels of a string in the cell font. */
  measure(text: string): number;
  /** Widths the file itself asks for, by column. */
  preset?: readonly (number | undefined)[];
  /** Columns past this index are not measured and get the default width. */
  limit?: number;
}

/** Column widths from content: the widest of the header and the sampled cells, padded and clamped. */
export function fitColumnWidths(input: FitColumnsInput): number[] {
  const { columnCount, headerWidths, sample, measure, preset, limit = 240 } = input;
  const widths = new Array<number>(columnCount);
  for (let column = 0; column < columnCount; column += 1) {
    const fixed = preset?.[column];
    if (fixed !== undefined && Number.isFinite(fixed) && fixed > 0) {
      widths[column] = Math.round(Math.min(GRID_MAX_COLUMN, Math.max(GRID_MIN_COLUMN, fixed)));
      continue;
    }
    if (column >= limit) {
      widths[column] = GRID_DEFAULT_COLUMN;
      continue;
    }
    let widest = headerWidths[column] ?? 0;
    for (const row of sample) {
      const text = row.cells[column];
      if (!text) continue;
      // Past this length the column is at its maximum anyway.
      widest = Math.max(widest, measure(text.length > 80 ? text.slice(0, 80) : text));
      if (widest + GRID_CELL_PAD >= GRID_MAX_FIT_COLUMN) break;
    }
    widths[column] = Math.round(Math.min(GRID_MAX_FIT_COLUMN, Math.max(GRID_MIN_COLUMN, widest + GRID_CELL_PAD + 2)));
  }
  return widths;
}

/**
 * Which columns hold numbers, judged from a sample: most of the filled cells read as one. The
 * header of such a column sits on the right, over its digits.
 */
export function numericColumns(sample: readonly DataGridRow[], columnCount: number, limit = 240): boolean[] {
  const numeric = new Array<boolean>(columnCount).fill(false);
  for (let column = 0; column < Math.min(columnCount, limit); column += 1) {
    let filled = 0;
    let numbers = 0;
    for (const row of sample) {
      const text = row.cells[column];
      if (!text) continue;
      const kind = row.kinds?.[column];
      // An absent value says nothing about the column.
      if (kind === 'z') continue;
      filled += 1;
      if (kind === undefined ? isNumericText(text) : kind === 'n') numbers += 1;
    }
    numeric[column] = filled > 0 && numbers >= filled * 0.6;
  }
  return numeric;
}

/** Left edge of every column, plus the right edge of the last: `offsets[i + 1] - offsets[i]` is a width. */
export function columnOffsets(widths: readonly number[]): number[] {
  const offsets = new Array<number>(widths.length + 1);
  offsets[0] = 0;
  for (let index = 0; index < widths.length; index += 1) offsets[index + 1] = (offsets[index] ?? 0) + (widths[index] ?? 0);
  return offsets;
}

/** The column whose span holds `x` (0 = the left edge of the first column); clamped to the grid. */
export function columnAt(offsets: readonly number[], x: number): number {
  let low = 0;
  let high = offsets.length - 2;
  if (high < 0) return 0;
  while (low < high) {
    const middle = (low + high + 1) >>> 1;
    if ((offsets[middle] ?? 0) <= x) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** "1,204": grouped digits, the same in every locale so counts line up with the file's own numbers. */
export function formatCount(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString('en-US');
}

/** A width guess for when no canvas is at hand: full-width characters count as one em. */
export function estimateTextWidth(text: string, fontSize = 13): number {
  let width = 0;
  for (let index = 0; index < text.length; index += 1) width += text.charCodeAt(index) > 0x2e7f ? fontSize : fontSize * 0.56;
  return width;
}

/** The number behind text a cell shows: "1,204" → 1204, "¥98.50" → 98.5, "12%" → 0.12. Null when it is not one. */
export function parseNumericText(text: string): { value: number; percent: boolean } | null {
  if (!isNumericText(text)) return null;
  const percent = text.endsWith('%');
  const value = Number(text.replace(/[¥$€£,%]/g, ''));
  if (!Number.isFinite(value)) return null;
  return { value: percent ? value / 100 : value, percent };
}

export interface RangeStats {
  /** Cells that hold a number. */
  numbers: number;
  sum: number;
  /** Every number was written as a percentage. */
  percent: boolean;
}

/** Sum of the numbers in columns `left` to `right` of these rows; null when a row is not loaded. */
export function rangeStats(rows: readonly (DataGridRow | undefined)[], left: number, right: number): RangeStats | null {
  let numbers = 0;
  let sum = 0;
  let percent = true;
  for (const row of rows) {
    if (!row) return null;
    for (let column = left; column <= right; column += 1) {
      const text = row.cells[column];
      if (!text) continue;
      const kind = row.kinds?.[column];
      if (kind !== undefined && kind !== 'n') continue;
      const parsed = parseNumericText(text);
      if (!parsed) continue;
      numbers += 1;
      sum += parsed.value;
      if (!parsed.percent) percent = false;
    }
  }
  return { numbers, sum, percent: numbers > 0 && percent };
}

/** A sum or an average as the status text shows it. */
export function formatStat(value: number, percent: boolean): string {
  if (percent) return `${(value * 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}
