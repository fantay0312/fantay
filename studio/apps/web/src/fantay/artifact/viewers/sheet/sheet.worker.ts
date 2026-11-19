// SPDX-License-Identifier: AGPL-3.0-only
// One worker holds one open file: the rows of a CSV or the cells of a workbook. Parsing an untrusted
// spreadsheet can take seconds and a lot of memory; here it cannot freeze the tab, and closing the
// viewer ends the worker, which is the only way that memory is given back. The window asks for rows
// in windows and gets formatted text.
/// <reference lib="webworker" />
import { DelimitedTable } from './delimited';
import type { DataGridRow } from './grid-model';
import { SHEET_HEAD_ROWS, type SheetBook, type SheetInfo, type SheetRequest, type SheetResponse } from './sheet-protocol';
import { decodeText } from './text-encoding';
import { SheetError, WorkbookReader } from './workbook';

type Source = { rows(sheet: number, start: number, count: number): DataGridRow[] };

let source: Source | null = null;

function reply(message: SheetResponse): void {
  self.postMessage(message);
}

function openDelimited(bytes: ArrayBuffer, delimiter: string | undefined): void {
  const { text, encoding } = decodeText(new Uint8Array(bytes));
  const table = new DelimitedTable();
  source = { rows: (_sheet, start, count) => table.window(start, count) };
  let announced = false;
  table.parse(text, {
    delimiter,
    onProgress: (progress) => {
      if (announced) {
        reply({ type: 'progress', ...progress });
        return;
      }
      announced = true;
      const sheet: SheetInfo = {
        name: '',
        rowCount: progress.rowCount,
        columnCount: progress.columnCount,
        columns: [],
        merges: [],
        rowLabels: false,
        head: table.window(0, SHEET_HEAD_ROWS),
      };
      const book: SheetBook = {
        kind: 'delimited',
        sheets: [sheet],
        delimiter: table.delimiter,
        encoding,
        partial: !progress.done,
        truncated: progress.truncated,
      };
      reply({ type: 'ready', book });
    },
  });
}

async function openWorkbook(bytes: ArrayBuffer): Promise<void> {
  const [xlsx, codepages] = await Promise.all([import('@e965/xlsx'), import('@e965/xlsx/dist/cpexcel.full.mjs')]);
  // Legacy .xls files store text in a code page (936 for Simplified Chinese); without the tables
  // that text comes out as noise.
  xlsx.set_cptable(codepages);
  const reader = new WorkbookReader(xlsx, bytes);
  source = reader;
  reply({ type: 'ready', book: { kind: 'workbook', sheets: reader.infos, partial: false, truncated: false } });
}

self.addEventListener('message', (event: MessageEvent<SheetRequest>) => {
  const request = event.data;
  if (request.type === 'rows') {
    reply({ type: 'rows', id: request.id, rows: source ? source.rows(request.sheet, request.start, request.count) : [] });
    return;
  }
  const open = async (): Promise<void> => {
    if (request.format === 'workbook') await openWorkbook(request.bytes);
    else openDelimited(request.bytes, request.format === 'tsv' ? '\t' : undefined);
  };
  open().catch((cause: unknown) => {
    reply({ type: 'failed', reason: cause instanceof SheetError ? cause.reason : 'invalid' });
  });
});
