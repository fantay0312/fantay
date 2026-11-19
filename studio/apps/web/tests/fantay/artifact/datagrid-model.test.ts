// SPDX-License-Identifier: AGPL-3.0-only
// The grid's arithmetic: column letters, the selection and how keys move it (around merged cells
// too), TSV for the clipboard, number detection, the header guess, column widths and range totals.
import { describe, expect, it } from 'vitest';

import {
  GRID_MAX_FIT_COLUMN,
  GRID_MIN_COLUMN,
  clampSelection,
  columnAt,
  columnLabel,
  columnOffsets,
  coverMerges,
  fitColumnWidths,
  formatCount,
  formatStat,
  isNumericText,
  looksLikeHeader,
  mergeAt,
  moveSelection,
  numericColumns,
  parseNumericText,
  rangeStats,
  selectionAt,
  selectionRange,
  toTsv,
  type GridRange,
} from '../../../src/fantay/artifact/viewers/sheet/grid-model';

describe('columnLabel', () => {
  it('counts in letters like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16_383].map(columnLabel)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA', 'XFD']);
  });
});

describe('selection', () => {
  const merges: GridRange[] = [{ top: 1, left: 1, bottom: 2, right: 3 }];

  it('covers the cells between anchor and focus, whichever way it was dragged', () => {
    expect(selectionRange({ anchor: { row: 5, col: 4 }, focus: { row: 2, col: 1 } })).toEqual({ top: 2, left: 1, bottom: 5, right: 4 });
  });

  it('grows over every merged cell it touches, including one reached through another', () => {
    const chain: GridRange[] = [
      { top: 0, left: 0, bottom: 0, right: 2 },
      { top: 0, left: 2, bottom: 3, right: 2 },
      { top: 3, left: 2, bottom: 3, right: 5 },
    ];
    expect(coverMerges({ top: 0, left: 0, bottom: 0, right: 0 }, chain)).toEqual({ top: 0, left: 0, bottom: 3, right: 5 });
    expect(coverMerges({ top: 8, left: 8, bottom: 9, right: 9 }, chain)).toEqual({ top: 8, left: 8, bottom: 9, right: 9 });
  });

  it('finds the merged cell a cell belongs to', () => {
    expect(mergeAt(merges, { row: 2, col: 3 })).toBe(merges[0]);
    expect(mergeAt(merges, { row: 0, col: 3 })).toBeUndefined();
  });

  it('keeps a stored selection inside a file that got smaller', () => {
    const stored = { anchor: { row: 90, col: 7 }, focus: { row: 120, col: 9 } };
    expect(clampSelection(stored, 100, 8)).toEqual({ anchor: { row: 90, col: 7 }, focus: { row: 99, col: 7 } });
    expect(clampSelection(stored, 0, 8)).toBeNull();
    expect(clampSelection(null, 10, 10)).toBeNull();
  });
});

describe('moveSelection', () => {
  const size = { rows: 100, cols: 10 };

  it('steps one cell and stops at the edges', () => {
    const start = selectionAt({ row: 0, col: 0 });
    expect(moveSelection(start, 'down', size).focus).toEqual({ row: 1, col: 0 });
    expect(moveSelection(start, 'up', size).focus).toEqual({ row: 0, col: 0 });
    expect(moveSelection(start, 'left', size).focus).toEqual({ row: 0, col: 0 });
    expect(moveSelection(selectionAt({ row: 99, col: 9 }), 'right', size).focus).toEqual({ row: 99, col: 9 });
  });

  it('extends from the anchor with Shift and collapses without it', () => {
    const extended = moveSelection(selectionAt({ row: 4, col: 4 }), 'right', { ...size, extend: true });
    expect(extended).toEqual({ anchor: { row: 4, col: 4 }, focus: { row: 4, col: 5 } });
    const further = moveSelection(extended, 'down', { ...size, extend: true });
    expect(further).toEqual({ anchor: { row: 4, col: 4 }, focus: { row: 5, col: 5 } });
    expect(moveSelection(further, 'down', size)).toEqual(selectionAt({ row: 6, col: 5 }));
  });

  it('jumps by page and to the ends of a row, a column and the grid', () => {
    const start = selectionAt({ row: 40, col: 4 });
    expect(moveSelection(start, 'pageDown', { ...size, page: 20 }).focus).toEqual({ row: 60, col: 4 });
    expect(moveSelection(start, 'pageUp', { ...size, page: 70 }).focus).toEqual({ row: 0, col: 4 });
    expect(moveSelection(start, 'rowStart', size).focus).toEqual({ row: 40, col: 0 });
    expect(moveSelection(start, 'rowEnd', size).focus).toEqual({ row: 40, col: 9 });
    expect(moveSelection(start, 'columnStart', size).focus).toEqual({ row: 0, col: 4 });
    expect(moveSelection(start, 'columnEnd', size).focus).toEqual({ row: 99, col: 4 });
    expect(moveSelection(start, 'gridStart', size).focus).toEqual({ row: 0, col: 0 });
    expect(moveSelection(start, 'gridEnd', size).focus).toEqual({ row: 99, col: 9 });
  });

  it('lands on the first cell of a merged cell and steps past it from inside', () => {
    const merges: GridRange[] = [{ top: 1, left: 1, bottom: 2, right: 3 }];
    const into = moveSelection(selectionAt({ row: 2, col: 0 }), 'right', { ...size, merges });
    expect(into.focus).toEqual({ row: 1, col: 1 });
    expect(moveSelection(into, 'right', { ...size, merges }).focus).toEqual({ row: 1, col: 4 });
    expect(moveSelection(into, 'down', { ...size, merges }).focus).toEqual({ row: 3, col: 1 });
    expect(moveSelection(into, 'left', { ...size, merges }).focus).toEqual({ row: 1, col: 0 });
  });

  it('stays put when a merged cell reaches the edge of the grid', () => {
    const merges: GridRange[] = [{ top: 0, left: 0, bottom: 0, right: 9 }];
    const inside = selectionAt({ row: 0, col: 0 });
    expect(moveSelection(inside, 'right', { ...size, merges })).toEqual(inside);
    expect(moveSelection(inside, 'up', { ...size, merges })).toEqual(inside);
    expect(moveSelection(inside, 'down', { ...size, merges }).focus).toEqual({ row: 1, col: 0 });
  });
});

describe('toTsv', () => {
  it('joins cells with tabs and rows with line breaks', () => {
    expect(toTsv([['a', 'b'], ['1', '2']])).toBe('a\tb\n1\t2');
  });

  it('quotes a cell that holds a tab, a line break or a quote', () => {
    expect(toTsv([['发票抬头：某公司\n税号：9131', 'say "hi"', 'a\tb', '普通']])).toBe('"发票抬头：某公司\n税号：9131"\t"say ""hi"""\t"a\tb"\t普通');
  });
});

describe('isNumericText', () => {
  it('accepts the ways a number is written in a table', () => {
    for (const text of ['0', '42', '-3.5', '+7', '1,204', '12,345,678.90', '.5', '12%', '-0.5%', '1e6', '2.5E-3', '¥98.00', '$1,200', '€15']) {
      expect(isNumericText(text), text).toBe(true);
    }
  });

  it('rejects text that only looks close', () => {
    for (const text of ['', ' ', 'abc', '2026-04', '2026/4/1', '12:30', '1,2,3', '1.2.3', 'SO-001', '是', '-', '%', '¥', '１２', '12 元', '0x1f', 'NaN']) {
      expect(isNumericText(text), text).toBe(false);
    }
  });

  it('reads the value behind the text', () => {
    expect(parseNumericText('1,204.50')).toEqual({ value: 1204.5, percent: false });
    expect(parseNumericText('¥98')).toEqual({ value: 98, percent: false });
    expect(parseNumericText('12.5%')).toEqual({ value: 0.125, percent: true });
    expect(parseNumericText('甲')).toBeNull();
  });
});

describe('looksLikeHeader', () => {
  it('says header when names sit over columns of numbers', () => {
    expect(looksLikeHeader([['月份', '活跃订阅', '收入'], ['2026-04', '4980', '303780'], ['2026-05', '5120', '312320']])).toBe(true);
  });

  it('says data when the first row is numbers like the rest', () => {
    expect(looksLikeHeader([['1', '22.40', '71.2'], ['2', '23.10', '70.8'], ['3', '21.90', '69.5']])).toBe(false);
  });

  it('uses value length for text columns', () => {
    expect(looksLikeHeader([['订单号', '城市'], ['SO-0001', '上海'], ['SO-0002', '北京'], ['SO-0003', '深圳']])).toBe(true);
  });

  it('falls back to distinct, non-empty names for free text', () => {
    expect(looksLikeHeader([['姓名', '备注'], ['王伟', '老客户'], ['李芳', '需要回访一次']])).toBe(true);
    expect(looksLikeHeader([['王伟', '王伟'], ['李芳', '老客户'], ['张敏', '需要回访一次']])).toBe(false);
  });

  it('never takes a row with a blank cell, or an empty file, for a header', () => {
    expect(looksLikeHeader([['名称', ''], ['a', '1']])).toBe(false);
    expect(looksLikeHeader([])).toBe(false);
    expect(looksLikeHeader([[]])).toBe(false);
  });

  it('treats a lone row of names as a header and a lone row of numbers as data', () => {
    expect(looksLikeHeader([['名称', '数量']])).toBe(true);
    expect(looksLikeHeader([['12', '30']])).toBe(false);
  });
});

describe('column widths', () => {
  const measure = (text: string): number => text.length * 10;

  it('takes the widest of header and cells, padded and clamped', () => {
    const widths = fitColumnWidths({
      columnCount: 3,
      headerWidths: [20, 20, 40],
      sample: [{ cells: ['1', '手冲壶', 'x'.repeat(200)] }, { cells: ['22', '滤杯 01', ''] }],
      measure,
    });
    expect(widths[0]).toBe(GRID_MIN_COLUMN);
    expect(widths[1]).toBe(5 * 10 + 22);
    expect(widths[2]).toBe(GRID_MAX_FIT_COLUMN);
  });

  it('prefers the width the file asks for and skips measuring past the limit', () => {
    const widths = fitColumnWidths({ columnCount: 4, headerWidths: [], sample: [{ cells: ['a', 'b', 'c', 'dddddddddddddddddddd'] }], measure, preset: [180, undefined, 5], limit: 3 });
    expect(widths[0]).toBe(180);
    expect(widths[1]).toBe(GRID_MIN_COLUMN);
    expect(widths[2]).toBe(GRID_MIN_COLUMN);
    expect(widths[3]).toBe(104);
  });

  it('turns widths into edges and finds the column under a point', () => {
    const offsets = columnOffsets([50, 100, 30]);
    expect(offsets).toEqual([0, 50, 150, 180]);
    expect([0, 49, 50, 149, 150, 179, 180, 9999, -5].map((x) => columnAt(offsets, x))).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 0]);
    expect(columnAt([0], 10)).toBe(0);
  });
});

describe('numericColumns', () => {
  it('calls a column numeric when most of its filled cells are numbers', () => {
    const sample = [{ cells: ['SO-1', '12.50', '', '5%'] }, { cells: ['SO-2', '8', '', ''] }, { cells: ['SO-3', '暂无', '', '10%'] }];
    expect(numericColumns(sample, 5)).toEqual([false, true, false, true, false]);
  });

  it('goes by the declared kind when there is one, and ignores absent values', () => {
    const sample = [{ cells: ['1001', 'NULL', '3'], kinds: 'szn' }, { cells: ['1002', '7', '4'], kinds: 'snn' }];
    expect(numericColumns(sample, 3)).toEqual([false, true, true]);
  });

  it('does not judge columns past the limit', () => {
    expect(numericColumns([{ cells: ['1', '2', '3'] }], 3, 2)).toEqual([true, true, false]);
  });
});

describe('range totals', () => {
  it('sums the numbers in a range and leaves text out', () => {
    const rows = [{ cells: ['咖啡豆', '1,200.50', '12%'] }, { cells: ['滤纸', '300', '8%'] }, { cells: ['合计', '', ''] }];
    expect(rangeStats(rows, 1, 1)).toEqual({ numbers: 2, sum: 1500.5, percent: false });
    expect(rangeStats(rows, 2, 2)).toMatchObject({ numbers: 2, percent: true });
    expect(rangeStats(rows, 0, 0)).toEqual({ numbers: 0, sum: 0, percent: false });
  });

  it('trusts the declared kind over the text', () => {
    // A product code that happens to be digits is text, not a number to add up.
    expect(rangeStats([{ cells: ['1001', '5'], kinds: 'sn' }, { cells: ['1002', '7'], kinds: 'sn' }], 0, 1)).toEqual({ numbers: 2, sum: 12, percent: false });
  });

  it('gives nothing while a row of the range is not loaded', () => {
    expect(rangeStats([{ cells: ['1'] }, undefined], 0, 0)).toBeNull();
  });

  it('formats counts and totals', () => {
    expect(formatCount(1204)).toBe('1,204');
    expect(formatStat(1500.456, false)).toBe('1,500.46');
    expect(formatStat(0.125, true)).toBe('12.5%');
  });
});
