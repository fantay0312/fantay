// SPDX-License-Identifier: AGPL-3.0-only
// Delimited text: which encoding the bytes are in, which separator the text uses, and that a file
// read in chunks (with pauses in between) yields the same rows as one read in a single pass.
import { describe, expect, it } from 'vitest';

import { DelimitedTable, type DelimitedProgress } from '../../../src/fantay/artifact/viewers/sheet/delimited';
import { decodeText, decodeWith, detectEncoding } from '../../../src/fantay/artifact/viewers/sheet/text-encoding';

function read(text: string, options: { delimiter?: string; chunkChars?: number; maxRows?: number } = {}): Promise<{ table: DelimitedTable; reports: DelimitedProgress[] }> {
  return new Promise((resolve) => {
    const table = new DelimitedTable();
    const reports: DelimitedProgress[] = [];
    table.parse(text, {
      ...options,
      onProgress: (progress) => {
        reports.push(progress);
        if (progress.done) resolve({ table, reports });
      },
    });
  });
}

const cells = (table: DelimitedTable, start = 0, count = 1000): string[][] => table.window(start, count).map((row) => [...row.cells]);

describe('DelimitedTable', () => {
  it('reads comma-separated rows and drops the empty record after the last line break', async () => {
    const { table } = await read('月份,收入\r\n2026-04,303780\r\n2026-05,312320\r\n');
    expect(table.delimiter).toBe(',');
    expect(table.rowCount).toBe(3);
    expect(table.columnCount).toBe(2);
    expect(cells(table)).toEqual([['月份', '收入'], ['2026-04', '303780'], ['2026-05', '312320']]);
  });

  it('keeps commas, quotes and line breaks that sit inside a quoted cell', async () => {
    const { table } = await read('id,备注\n1,"加急, 当天发"\n2,"贺卡：""生日快乐"""\n3,"第一行\n第二行"\n');
    expect(cells(table)).toEqual([['id', '备注'], ['1', '加急, 当天发'], ['2', '贺卡："生日快乐"'], ['3', '第一行\n第二行']]);
  });

  it('finds a semicolon or a tab separator by itself', async () => {
    expect((await read('门店;城市;面积\n静安店;上海;86,5\n国贸店;北京;120\n')).table.delimiter).toBe(';');
    const tabbed = await read('a\tb\tc\n1\t2\t3\n');
    expect(tabbed.table.delimiter).toBe('\t');
    expect(cells(tabbed.table)).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
  });

  it('uses the separator it is told to, whatever the content looks like', async () => {
    const { table } = await read('a,b\tc\n1,2\t3\n', { delimiter: '\t' });
    expect(cells(table)).toEqual([['a,b', 'c'], ['1,2', '3']]);
  });

  it('keeps a blank line in the middle as an empty row and counts the widest row', async () => {
    const { table } = await read('a,b\n\n1,2,3\n');
    expect(table.rowCount).toBe(3);
    expect(table.columnCount).toBe(3);
    expect(cells(table)[1]).toEqual(['']);
  });

  it('reports an empty file as done with no rows', async () => {
    const { table, reports } = await read('');
    expect(table.rowCount).toBe(0);
    expect(reports).toEqual([{ rowCount: 0, columnCount: 0, done: true, truncated: false }]);
  });

  it('yields the same rows in small chunks as in one pass, and reports as it goes', async () => {
    const lines = ['订单号,客户,备注'];
    for (let index = 0; index < 500; index += 1) {
      lines.push(`SO-${index},客户${index},${index % 7 === 0 ? '"跨行的\n备注, 带逗号"' : '普通'}`);
    }
    const text = `${lines.join('\n')}\n`;
    const whole = await read(text);
    const chunked = await read(text, { chunkChars: 257 });
    expect(chunked.table.rowCount).toBe(501);
    expect(cells(chunked.table)).toEqual(cells(whole.table));
    // Progress arrived before the end, with a growing row count: the file streams in.
    expect(chunked.reports.length).toBeGreaterThan(10);
    expect(chunked.reports[0]?.done).toBe(false);
    const counts = chunked.reports.map((report) => report.rowCount);
    expect([...counts].sort((a, b) => a - b)).toEqual(counts);
    expect(chunked.reports[chunked.reports.length - 1]).toMatchObject({ done: true, rowCount: 501, truncated: false });
  });

  it('answers a request for rows while the rest is still being read', async () => {
    const text = Array.from({ length: 400 }, (_, index) => `${index},行${index}`).join('\n');
    const table = new DelimitedTable();
    const seen: string[][][] = [];
    await new Promise<void>((resolve) => {
      table.parse(text, {
        chunkChars: 300,
        onProgress: (progress) => {
          if (!progress.done) seen.push(table.window(0, 2).map((row) => [...row.cells]));
          else resolve();
        },
      });
    });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen[0]).toEqual([['0', '行0'], ['1', '行1']]);
  });

  it('stops at the row limit and says the rest was left out', async () => {
    const text = Array.from({ length: 50 }, (_, index) => `${index}`).join('\n');
    const { table, reports } = await read(text, { maxRows: 20, chunkChars: 16 });
    expect(table.rowCount).toBe(20);
    expect(table.truncated).toBe(true);
    expect(reports[reports.length - 1]).toMatchObject({ done: true, truncated: true, rowCount: 20 });
  });

  it('gives windows of rows and nothing past the end', async () => {
    const { table } = await read('a\nb\nc\nd\n');
    expect(cells(table, 1, 2)).toEqual([['b'], ['c']]);
    expect(cells(table, 3, 10)).toEqual([['d']]);
    expect(cells(table, 9, 5)).toEqual([]);
  });
});

describe('text encoding', () => {
  const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

  it('reads UTF-8 with and without a byte-order mark', () => {
    expect(detectEncoding(utf8('客户,金额\n王伟,12\n'))).toBe('utf-8');
    const marked = new Uint8Array([0xef, 0xbb, 0xbf, ...utf8('客户,金额')]);
    expect(decodeText(marked)).toEqual({ text: '客户,金额', encoding: 'utf-8' });
  });

  it('recognises GBK text, which is not valid UTF-8', () => {
    // "客户名称,所在城市" in GBK.
    const gbk = new Uint8Array([0xbf, 0xcd, 0xbb, 0xa7, 0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xcb, 0xf9, 0xd4, 0xda, 0xb3, 0xc7, 0xca, 0xd0]);
    expect(detectEncoding(gbk)).toBe('gb18030');
    expect(decodeText(gbk).text).toBe('客户名称,所在城市');
  });

  it('falls through to a western encoding when the bytes fit no East Asian one', () => {
    // "café,naïve\n" in Windows-1252: 0xE9 and 0xEF are followed by bytes no double-byte encoding allows.
    const latin = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x2c, 0x6e, 0x61, 0xef, 0x76, 0x65, 0x0a]);
    const { text, encoding } = decodeText(latin);
    expect(encoding).toBe('windows-1252');
    expect(text).toBe('café,naïve\n');
  });

  it('reads UTF-16 with a mark, and without one from its zero bytes', () => {
    const body = 'name,qty\nbean,12\n';
    const le = new Uint8Array(2 + body.length * 2);
    le.set([0xff, 0xfe]);
    for (let index = 0; index < body.length; index += 1) le[2 + index * 2] = body.charCodeAt(index);
    expect(decodeText(le)).toEqual({ text: body, encoding: 'utf-16le' });
    expect(detectEncoding(le.subarray(2))).toBe('utf-16le');
  });

  it('decodes with a named encoding and survives an unknown name', () => {
    expect(decodeWith(utf8('表格'), 'utf-8')).toBe('表格');
    expect(decodeWith(utf8('表格'), 'no-such-encoding')).toBe('表格');
  });
});
