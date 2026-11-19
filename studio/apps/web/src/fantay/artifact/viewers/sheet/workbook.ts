// SPDX-License-Identifier: AGPL-3.0-only
// A workbook (.xlsx .xlsm .xlsb .xls .ods .numbers .et) into sheets of formatted text, through SheetJS
// Community Edition. The library parses; this file decides what a reader sees: visible sheets only,
// hidden rows and columns left out (their numbers and letters skip, as in a spreadsheet), each value
// as the cell shows it (number format, date, percentage), merged cells, the file's column widths.
// Values only: no macro, formula or external link is ever evaluated. The SheetJS module is passed
// in, so the worker loads it on demand and tests load it from Node.
import type * as SheetJS from '@e965/xlsx';

import { columnLabel, type DataGridRow, type GridRange } from './grid-model';
import {
  SHEET_HEAD_ROWS,
  SHEET_MAX_COLUMNS,
  SHEET_MAX_ROWS,
  SHEET_MAX_UNPACKED_BYTES,
  type SheetColumn,
  type SheetFailure,
  type SheetInfo,
} from './sheet-protocol';

type SheetJSModule = typeof SheetJS;

/** The date format behind the "short date" a file leaves to the system; this is what Chinese locales show. */
const SHORT_DATE = 'yyyy/m/d';
/** Pixels per character of a file's column width, in the grid's font; padding is added on top. */
const CHARACTER_WIDTH = 7.5;
const COLUMN_PADDING = 20;

export class SheetError extends Error {
  constructor(readonly reason: SheetFailure) {
    super(reason);
  }
}

/**
 * The size a ZIP archive says it unpacks to, from its central directory, without unpacking anything.
 * Null when the bytes are not a ZIP. An .xlsx of a few kilobytes can claim gigabytes; that file is
 * refused before the parser allocates for it.
 */
export function zipUnpackedSize(bytes: Uint8Array): number | null {
  if (bytes.length < 22 || bytes[0] !== 0x50 || bytes[1] !== 0x4b) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end-of-central-directory record sits in the last 64 KB, after an optional comment.
  let end = -1;
  for (let index = bytes.length - 22; index >= Math.max(0, bytes.length - 22 - 65_535); index -= 1) {
    if (view.getUint32(index, true) === 0x06054b50) {
      end = index;
      break;
    }
  }
  if (end < 0) return null;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  let total = 0;
  for (let entry = 0; entry < count; entry += 1) {
    if (offset + 46 > bytes.length || view.getUint32(offset, true) !== 0x02014b50) return total;
    total += view.getUint32(offset + 24, true);
    offset += 46 + view.getUint16(offset + 28, true) + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return total;
}

/**
 * A number format the formatter rejects because a currency sign or a unit is written bare
 * (`¥#,##0.00`, `0.00元`), with those characters quoted so it reads them as literal text.
 */
export function quoteFormatLiterals(format: string): string {
  let out = '';
  let index = 0;
  while (index < format.length) {
    const char = format[index] ?? '';
    if (char === '"') {
      const close = format.indexOf('"', index + 1);
      const end = close < 0 ? format.length : close + 1;
      out += format.slice(index, end);
      index = end;
    } else if (char === '[') {
      const close = format.indexOf(']', index + 1);
      const end = close < 0 ? format.length : close + 1;
      out += format.slice(index, end);
      index = end;
    } else if (char === '\\' || char === '_' || char === '*') {
      out += format.slice(index, index + 2);
      index += 2;
    } else if (char.charCodeAt(0) > 127) {
      let end = index + 1;
      while (end < format.length && (format[end] ?? '').charCodeAt(0) > 127) end += 1;
      out += `"${format.slice(index, end)}"`;
      index = end;
    } else {
      out += char;
      index += 1;
    }
  }
  return out;
}

interface OpenSheet {
  info: SheetInfo;
  data: (SheetJS.CellObject | undefined)[][];
  /** Visible row → the sheet's row, when rows are hidden. */
  rowMap: Int32Array | null;
  /** Visible column → the sheet's column. */
  columnMap: Int32Array;
}

function failureOf(cause: unknown): SheetFailure {
  const message = cause instanceof Error ? cause.message : String(cause);
  // "File is password-protected". A damaged archive can also complain about encryption; that one is just invalid.
  return /password/i.test(message) ? 'protected' : 'invalid';
}

export class WorkbookReader {
  private readonly sheets: OpenSheet[] = [];

  constructor(
    private readonly xlsx: SheetJSModule,
    bytes: ArrayBuffer,
  ) {
    const data = new Uint8Array(bytes);
    const unpacked = zipUnpackedSize(data);
    if (unpacked !== null && unpacked > SHEET_MAX_UNPACKED_BYTES) throw new SheetError('too-large');

    let book: SheetJS.WorkBook;
    try {
      book = xlsx.read(data, {
        type: 'array',
        dense: true,
        // Column widths and hidden rows / columns are only read together with the styles.
        cellStyles: true,
        cellHTML: false,
        cellFormula: true,
        bookVBA: false,
        dateNF: SHORT_DATE,
      });
    } catch (cause) {
      throw new SheetError(failureOf(cause));
    }

    book.SheetNames.forEach((name, index) => {
      if (book.Workbook?.Sheets?.[index]?.Hidden) return;
      const sheet = book.Sheets[name];
      if (!sheet || (sheet['!type'] !== undefined && sheet['!type'] !== 'sheet')) return;
      this.sheets.push(this.openSheet(name, sheet));
    });
  }

  get infos(): SheetInfo[] {
    return this.sheets.map((sheet) => sheet.info);
  }

  private openSheet(name: string, sheet: SheetJS.WorkSheet): OpenSheet {
    const data = (sheet['!data'] ?? []) as (SheetJS.CellObject | undefined)[][];
    const ref = typeof sheet['!ref'] === 'string' ? sheet['!ref'] : null;
    let sourceRows = 0;
    let sourceColumns = 0;
    if (ref) {
      try {
        const range = this.xlsx.utils.decode_range(ref);
        // The used range by content: a sheet formatted down to row 1,048,576 holds no rows there.
        sourceRows = Math.min(range.e.r + 1, data.length, SHEET_MAX_ROWS);
        sourceColumns = Math.min(range.e.c + 1, SHEET_MAX_COLUMNS);
      } catch {
        sourceRows = Math.min(data.length, SHEET_MAX_ROWS);
      }
    }

    const columnInfo = sheet['!cols'] ?? [];
    const rowInfo = sheet['!rows'] ?? [];
    const visibleColumns: number[] = [];
    for (let column = 0; column < sourceColumns; column += 1) if (!columnInfo[column]?.hidden) visibleColumns.push(column);
    const columnMap = Int32Array.from(visibleColumns);

    let rowMap: Int32Array | null = null;
    if (rowInfo.some((row) => row?.hidden)) {
      const visibleRows: number[] = [];
      for (let row = 0; row < sourceRows; row += 1) if (!rowInfo[row]?.hidden) visibleRows.push(row);
      rowMap = Int32Array.from(visibleRows);
    }
    const rowCount = rowMap ? rowMap.length : sourceRows;

    const columns: SheetColumn[] = visibleColumns.map((column) => {
      const info = columnInfo[column];
      const characters = info?.wch ?? (info?.wpx !== undefined ? info.wpx / 6 : info?.width);
      return characters !== undefined && characters > 0
        ? { label: columnLabel(column), width: Math.round(characters * CHARACTER_WIDTH + COLUMN_PADDING) }
        : { label: columnLabel(column) };
    });

    // Merged cells, in the coordinates of what is shown: a merge loses its hidden rows and columns.
    const columnAt = new Map<number, number>();
    visibleColumns.forEach((column, index) => columnAt.set(column, index));
    const rowAt = new Map<number, number>();
    if (rowMap) rowMap.forEach((row, index) => rowAt.set(row, index));
    const project = (from: number, to: number, at: Map<number, number> | null, limit: number): [number, number] | null => {
      if (!at) return from < limit ? [from, Math.min(to, limit - 1)] : null;
      let first = -1;
      let last = -1;
      for (let value = from; value <= to; value += 1) {
        const index = at.get(value);
        if (index === undefined) continue;
        if (first < 0) first = index;
        last = index;
      }
      return first < 0 ? null : [first, last];
    };
    const merges: GridRange[] = [];
    for (const merge of (sheet['!merges'] ?? []).slice(0, 20_000)) {
      const rows = project(merge.s.r, merge.e.r, rowMap ? rowAt : null, sourceRows);
      const cols = project(merge.s.c, merge.e.c, columnAt, sourceColumns);
      if (!rows || !cols || (rows[0] === rows[1] && cols[0] === cols[1])) continue;
      merges.push({ top: rows[0], bottom: rows[1], left: cols[0], right: cols[1] });
    }

    const open: OpenSheet = {
      info: { name, rowCount, columnCount: columnMap.length, columns, merges, rowLabels: rowMap !== null, head: [] },
      data,
      rowMap,
      columnMap,
    };
    open.info.head = this.read(open, 0, SHEET_HEAD_ROWS);
    return open;
  }

  /** The text a cell shows. */
  private text(cell: SheetJS.CellObject): string {
    if (cell.t === 'z') return '';
    if (cell.w !== undefined) {
      // A file can carry the bare number as its display text and the format beside it.
      if (cell.t === 'n' && typeof cell.v === 'number' && typeof cell.z === 'string' && cell.z !== 'General' && cell.w === String(cell.v)) {
        cell.w = this.formatNumber(cell.v, cell.z);
      }
      return cell.w;
    }
    let text: string;
    if (cell.t === 'n' && typeof cell.v === 'number') {
      text = this.formatNumber(cell.v, cell.z);
    } else {
      try {
        text = this.xlsx.utils.format_cell(cell);
      } catch {
        text = cell.v === undefined || cell.v === null ? '' : String(cell.v);
      }
    }
    cell.w = text;
    return text;
  }

  private formatNumber(value: number, format: SheetJS.NumberFormat | undefined): string {
    const formatter = this.xlsx.SSF as { format(format: string | number, value: number, options?: { dateNF?: string }): string };
    const code = format ?? 'General';
    try {
      return formatter.format(code, value, { dateNF: SHORT_DATE });
    } catch {
      /* The format holds something the formatter does not know. */
    }
    if (typeof code === 'string') {
      try {
        return formatter.format(quoteFormatLiterals(code), value, { dateNF: SHORT_DATE });
      } catch {
        /* Still not readable: show the plain number. */
      }
    }
    try {
      return formatter.format('General', value);
    } catch {
      return String(value);
    }
  }

  private read(sheet: OpenSheet, start: number, count: number): DataGridRow[] {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(sheet.info.rowCount, from + Math.max(0, Math.floor(count)));
    const rows: DataGridRow[] = [];
    for (let index = from; index < to; index += 1) {
      const source = sheet.rowMap ? (sheet.rowMap[index] ?? index) : index;
      const cells: string[] = [];
      let kinds = '';
      let notes: Record<number, string> | undefined;
      const record = sheet.data[source];
      if (record) {
        let last = -1;
        for (let column = 0; column < sheet.columnMap.length; column += 1) {
          const cell = record[sheet.columnMap[column] ?? column];
          if (!cell) {
            cells.push('');
            kinds += ' ';
            continue;
          }
          const text = this.text(cell);
          cells.push(text);
          kinds += cell.t === 'n' || cell.t === 'd' ? 'n' : cell.t === 'b' ? 'b' : cell.t === 'e' ? 'e' : 's';
          if (text) last = column;
          if (cell.f) (notes ??= {})[column] = `=${cell.f}`;
        }
        cells.length = last + 1;
        kinds = kinds.slice(0, last + 1);
      }
      const row: DataGridRow = { cells, kinds };
      if (sheet.rowMap) row.label = String(source + 1);
      if (notes) row.notes = notes;
      rows.push(row);
    }
    return rows;
  }

  rows(sheetIndex: number, start: number, count: number): DataGridRow[] {
    const sheet = this.sheets[sheetIndex];
    return sheet ? this.read(sheet, start, count) : [];
  }
}
