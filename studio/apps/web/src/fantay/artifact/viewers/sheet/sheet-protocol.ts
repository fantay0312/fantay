// SPDX-License-Identifier: AGPL-3.0-only
// What the sheet viewer and its worker say to each other. The worker owns the parsed file (every
// row of a CSV, every cell of a workbook); the window holds only what it draws: the facts about each
// sheet and a few windows of rows. Rows cross the boundary as plain strings, already formatted.
import type { DataGridRow, GridRange } from './grid-model';

export type SheetFormat = 'csv' | 'tsv' | 'workbook';

/** Files larger than this are not parsed (the viewer says so and offers the download). */
export const SHEET_MAX_BYTES = 50 * 1024 * 1024;
/** A parse that runs longer than this is stopped and reported, never left to hang the tab. */
export const SHEET_OPEN_TIMEOUT_MS = 30_000;
/** Rows past this are not read. 28px rows keep the scroll height under the browser's limit. */
export const SHEET_MAX_ROWS = 1_000_000;
/** The last column a spreadsheet can have (XFD). */
export const SHEET_MAX_COLUMNS = 16_384;
/** Rows sent with the first answer, so the grid sizes its columns and paints without asking. */
export const SHEET_HEAD_ROWS = 200;
/** A workbook's archive may not unpack to more than this. */
export const SHEET_MAX_UNPACKED_BYTES = 768 * 1024 * 1024;

export interface SheetColumn {
  /** The column's letters ("A", "AB"); a sheet with hidden columns skips some. */
  label: string;
  /** The width the file asks for, in pixels. */
  width?: number;
}

export interface SheetInfo {
  name: string;
  rowCount: number;
  columnCount: number;
  /** Workbooks only. Delimited text has no column names of its own; the viewer reads the first row. */
  columns: readonly SheetColumn[];
  merges: readonly GridRange[];
  /** True when rows carry their own number (the sheet hides some rows). */
  rowLabels: boolean;
  /** The first rows. */
  head: readonly DataGridRow[];
}

export interface SheetBook {
  kind: 'delimited' | 'workbook';
  sheets: readonly SheetInfo[];
  /** Delimited text: the separator that was used. */
  delimiter?: string;
  /** Delimited text: the encoding the bytes were read in (a TextDecoder label). */
  encoding?: string;
  /** Still reading: the first sheet's row count will grow. */
  partial: boolean;
  /** Rows or columns past the limit were left out. */
  truncated: boolean;
}

/** Why a file did not open. The viewer words each one. */
export type SheetFailure = 'invalid' | 'protected' | 'too-large' | 'timeout';

export type SheetRequest =
  | { type: 'open'; format: SheetFormat; bytes: ArrayBuffer }
  | { type: 'rows'; id: number; sheet: number; start: number; count: number };

export type SheetResponse =
  | { type: 'ready'; book: SheetBook }
  | { type: 'progress'; rowCount: number; columnCount: number; done: boolean; truncated: boolean }
  | { type: 'rows'; id: number; rows: DataGridRow[] }
  | { type: 'failed'; reason: SheetFailure };
