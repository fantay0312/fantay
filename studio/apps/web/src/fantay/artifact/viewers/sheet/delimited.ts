// SPDX-License-Identifier: AGPL-3.0-only
// Delimited text (CSV, TSV) into rows, through Papa Parse. The text is parsed one chunk at a time
// and the parser is paused between chunks, so the worker that runs this can answer "give me rows
// 400 to 600" while a large file is still being read: the grid fills in as the file streams in.
// No DOM and no worker globals here, so tests run the same code.
import Papa, { type Parser } from 'papaparse';

import type { DataGridRow } from './grid-model';
import { SHEET_MAX_COLUMNS, SHEET_MAX_ROWS } from './sheet-protocol';

/** Characters parsed between two pauses. About ten milliseconds of work. */
const CHUNK_CHARS = 1 << 20;

export interface DelimitedProgress {
  rowCount: number;
  columnCount: number;
  done: boolean;
  /** Rows or columns past the limit were left out. */
  truncated: boolean;
}

export interface DelimitedOptions {
  /** The separator when the file name states it (a tab for .tsv); omit to detect it. */
  delimiter?: string;
  maxRows?: number;
  chunkChars?: number;
  /** Called after every chunk, and once more when the whole text has been read. */
  onProgress(progress: DelimitedProgress): void;
}

export class DelimitedTable {
  private readonly rows: string[][] = [];
  private parser: Parser | null = null;
  private stopped = false;
  columnCount = 0;
  /** The separator in use; known after the first chunk. */
  delimiter = ',';
  done = false;
  truncated = false;

  /**
   * Rows read so far. While the file is still being read, an empty record at the very end is not
   * counted: it is either the line break that ends the file or a blank line the next chunk continues.
   */
  get rowCount(): number {
    let count = this.rows.length;
    if (!this.done) {
      while (count > 0) {
        const last = this.rows[count - 1];
        if (last && (last.length === 0 || (last.length === 1 && last[0] === ''))) count -= 1;
        else break;
      }
    }
    return count;
  }

  /** Starts reading. Returns at once; progress arrives through `onProgress`. */
  parse(text: string, options: DelimitedOptions): void {
    const maxRows = options.maxRows ?? SHEET_MAX_ROWS;
    const report = (): void =>
      options.onProgress({ rowCount: this.rowCount, columnCount: this.columnCount, done: this.done, truncated: this.truncated });
    const finish = (): void => {
      if (this.done) return;
      // A file that ends with a line break has one empty record after it; blank lines at the end
      // are not rows.
      while (this.rows.length > 0) {
        const last = this.rows[this.rows.length - 1];
        if (last && (last.length === 0 || (last.length === 1 && last[0] === ''))) this.rows.pop();
        else break;
      }
      this.done = true;
      this.parser = null;
      report();
    };

    if (text.length === 0) {
      finish();
      return;
    }

    Papa.parse(text, {
      delimiter: options.delimiter ?? '',
      delimitersToGuess: [',', '\t', ';', '|'],
      header: false,
      skipEmptyLines: false,
      chunkSize: options.chunkChars ?? CHUNK_CHARS,
      chunk: (results, parser) => {
        if (this.stopped) {
          parser.abort();
          return;
        }
        this.parser = parser;
        if (results.meta.delimiter) this.delimiter = results.meta.delimiter;
        for (const row of results.data) {
          if (this.rows.length >= maxRows) {
            this.truncated = true;
            break;
          }
          if (row.length > SHEET_MAX_COLUMNS) {
            row.length = SHEET_MAX_COLUMNS;
            this.truncated = true;
          }
          if (row.length > this.columnCount) this.columnCount = row.length;
          this.rows.push(row);
        }
        if (this.truncated && this.rows.length >= maxRows) {
          parser.abort();
          return;
        }
        report();
        // Give way to whatever is waiting (a request for rows), then carry on.
        parser.pause();
        setTimeout(() => {
          if (this.stopped) parser.abort();
          else parser.resume();
        }, 0);
      },
      complete: finish,
      error: finish,
    });
  }

  /** Stops a parse that is still running (the file was closed). */
  stop(): void {
    this.stopped = true;
    this.parser?.abort();
  }

  /** Rows `start` to `start + count`, or fewer when the file has not got that far. */
  window(start: number, count: number): DataGridRow[] {
    const from = Math.max(0, Math.floor(start));
    const to = Math.min(this.rowCount, from + Math.max(0, Math.floor(count)));
    const rows: DataGridRow[] = [];
    for (let index = from; index < to; index += 1) rows.push({ cells: this.rows[index] ?? [] });
    return rows;
  }
}
