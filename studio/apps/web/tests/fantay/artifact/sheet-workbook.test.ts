// SPDX-License-Identifier: AGPL-3.0-only
// Workbooks through SheetJS: what a reader sees of a file. Visible sheets only, hidden rows and
// columns left out with their numbers and letters skipping, values as the cells format them, merged
// cells in the coordinates of what is shown, the file's column widths, and files that do not open.
import * as XLSX from '@e965/xlsx';
import { describe, expect, it } from 'vitest';

import { SheetError, WorkbookReader, quoteFormatLiterals, zipUnpackedSize } from '../../../src/fantay/artifact/viewers/sheet/workbook';

function bytesOf(book: XLSX.WorkBook, bookType: XLSX.BookType = 'xlsx'): ArrayBuffer {
  const buffer = XLSX.write(book, { type: 'array', bookType, cellStyles: true }) as ArrayBuffer;
  return buffer;
}

function sampleBook(): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ['2026 年度经营汇总'],
    ['月份', '线上', null, '合计'],
    ['1月', 4260, 600985.7599, null],
    ['2月', 4571, 0.0486, null],
    ['隐藏行', 1, 2, 3],
    ['全年', null, null, null],
  ]);
  sheet.C3.z = '¥#,##0.00';
  sheet.B3.z = '#,##0';
  sheet.C4.z = '0.0%';
  sheet.D3 = { t: 'n', v: 605245.7599, f: 'B3+C3', z: '#,##0.00' };
  sheet.B6 = { t: 'n', v: 8831, f: 'SUM(B3:B4)' };
  sheet.C6 = { t: 'b', v: true };
  sheet.D6 = { t: 'n', v: 46024, z: 'yyyy"年"m"月"d"日"' };
  sheet['!ref'] = 'A1:E6';
  sheet.E2 = { t: 's', v: '隐藏列' };
  sheet['!merges'] = [XLSX.utils.decode_range('A1:E1'), XLSX.utils.decode_range('B2:C2')];
  sheet['!cols'] = [{ wch: 10 }, { wch: 20 }, { wch: 12 }, { wch: 12 }, { wch: 9, hidden: true }];
  sheet['!rows'] = [];
  sheet['!rows'][4] = { hidden: true };
  XLSX.utils.book_append_sheet(book, sheet, '汇总');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['a', 'b'], [1, 2]]), '明细');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([['secret']]), '_内部');
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([]), '空表');
  book.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }, { Hidden: 0 }] };
  return book;
}

describe('WorkbookReader', () => {
  const reader = new WorkbookReader(XLSX, bytesOf(sampleBook()));
  const [summary, detail, empty] = reader.infos;

  it('lists the visible sheets in order and leaves hidden ones out', () => {
    expect(reader.infos.map((sheet) => sheet.name)).toEqual(['汇总', '明细', '空表']);
  });

  it('measures a sheet by what is shown: hidden rows and columns do not count', () => {
    expect(summary?.rowCount).toBe(5);
    expect(summary?.columnCount).toBe(4);
    expect(summary?.columns.map((column) => column.label)).toEqual(['A', 'B', 'C', 'D']);
    expect(summary?.rowLabels).toBe(true);
    expect(detail).toMatchObject({ rowCount: 2, columnCount: 2, rowLabels: false });
    expect(empty).toMatchObject({ rowCount: 0, columnCount: 0 });
  });

  it('takes column widths from the file, scaled to the grid', () => {
    const widths = summary?.columns.map((column) => column.width) ?? [];
    expect(widths[0]).toBe(Math.round(10 * 7.5 + 20));
    expect(widths[1]).toBe(Math.round(20 * 7.5 + 20));
    expect(detail?.columns.every((column) => column.width === undefined)).toBe(true);
  });

  it('shows each value as its cell formats it', () => {
    const rows = reader.rows(0, 0, 10);
    expect(rows[0]?.cells).toEqual(['2026 年度经营汇总']);
    expect(rows[2]?.cells).toEqual(['1月', '4,260', '¥600,985.76', '605,245.76']);
    expect(rows[2]?.kinds).toBe('snnn');
    expect(rows[3]?.cells).toEqual(['2月', '4571', '4.9%']);
    // The hidden row 5 is skipped: the next row shown is the sheet's row 6.
    expect(rows[4]?.cells).toEqual(['全年', '8831', 'TRUE', '2026年1月2日']);
    expect(rows[4]?.kinds).toBe('snbn');
    expect(rows).toHaveLength(5);
  });

  it('numbers rows by the sheet, so a hidden row leaves a gap', () => {
    expect(reader.rows(0, 0, 10).map((row) => row.label)).toEqual(['1', '2', '3', '4', '6']);
    expect(reader.rows(1, 0, 10).every((row) => row.label === undefined)).toBe(true);
  });

  it('carries the formula behind a calculated value', () => {
    const rows = reader.rows(0, 0, 10);
    expect(rows[2]?.notes).toEqual({ 3: '=B3+C3' });
    expect(rows[4]?.notes).toEqual({ 1: '=SUM(B3:B4)' });
    expect(rows[0]?.notes).toBeUndefined();
  });

  it('maps merged cells onto what is shown and clips them at a hidden column', () => {
    expect(summary?.merges).toEqual([
      { top: 0, bottom: 0, left: 0, right: 3 },
      { top: 1, bottom: 1, left: 1, right: 2 },
    ]);
  });

  it('sends the first rows along with the sheet', () => {
    expect(summary?.head).toHaveLength(5);
    expect(summary?.head[1]?.cells).toEqual(['月份', '线上', '', '合计']);
  });

  it('reads windows and nothing for a sheet or range that is not there', () => {
    expect(reader.rows(0, 3, 1)).toHaveLength(1);
    expect(reader.rows(0, 99, 5)).toEqual([]);
    expect(reader.rows(7, 0, 5)).toEqual([]);
    expect(reader.rows(2, 0, 5)).toEqual([]);
  });

  it('reads the legacy and OpenDocument formats too', () => {
    for (const bookType of ['biff8', 'xlsb', 'ods'] as const) {
      const other = new WorkbookReader(XLSX, bytesOf(sampleBook(), bookType));
      // SheetJS does not carry sheet visibility through OpenDocument files: a hidden sheet shows there.
      const expected = bookType === 'ods' ? ['汇总', '明细', '_内部', '空表'] : ['汇总', '明细', '空表'];
      expect(other.infos.map((sheet) => sheet.name), bookType).toEqual(expected);
      const first = other.rows(0, 0, 3);
      expect(first[0]?.cells[0], bookType).toBe('2026 年度经营汇总');
      expect(first[2]?.cells.slice(0, 2), bookType).toEqual(['1月', '4,260']);
    }
  });

  it('refuses bytes that are not a workbook', () => {
    const broken = new TextEncoder().encode('PK\u0003\u0004 this is not really a workbook '.repeat(40));
    expect(() => new WorkbookReader(XLSX, broken.buffer)).toThrow(SheetError);
    try {
      new WorkbookReader(XLSX, broken.buffer);
    } catch (cause) {
      expect((cause as SheetError).reason).toBe('invalid');
    }
  });
});

describe('quoteFormatLiterals', () => {
  it('quotes a bare currency sign or unit', () => {
    expect(quoteFormatLiterals('¥#,##0.00')).toBe('"¥"#,##0.00');
    expect(quoteFormatLiterals('0.00元')).toBe('0.00"元"');
    expect(quoteFormatLiterals('yyyy年m月d日')).toBe('yyyy"年"m"月"d"日"');
  });

  it('leaves what is already literal alone', () => {
    expect(quoteFormatLiterals('"¥"#,##0.00')).toBe('"¥"#,##0.00');
    expect(quoteFormatLiterals('[$¥-804]#,##0.00')).toBe('[$¥-804]#,##0.00');
    expect(quoteFormatLiterals('#,##0\\元')).toBe('#,##0\\元');
    expect(quoteFormatLiterals('#,##0.00')).toBe('#,##0.00');
  });
});

describe('zipUnpackedSize', () => {
  it('adds up what the archive says it unpacks to', () => {
    const bytes = new Uint8Array(bytesOf(sampleBook()));
    const size = zipUnpackedSize(bytes);
    expect(size).not.toBeNull();
    expect(size ?? 0).toBeGreaterThan(bytes.length / 4);
  });

  it('says nothing for bytes that are not a ZIP', () => {
    expect(zipUnpackedSize(new TextEncoder().encode('月份,收入\n'))).toBeNull();
    expect(zipUnpackedSize(new Uint8Array(bytesOf(sampleBook(), 'biff8')))).toBeNull();
  });
});
