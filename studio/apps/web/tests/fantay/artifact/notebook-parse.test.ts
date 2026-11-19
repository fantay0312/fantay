// SPDX-License-Identifier: AGPL-3.0-only
// Reading `.ipynb`: untrusted JSON in, typed cells and outputs out. Nothing is trusted, nothing runs.
import { describe, expect, it } from 'vitest';

import { MAX_CELLS, parseNotebook, terminalText, type Notebook } from '../../../src/fantay/artifact/viewers/notebook/parse-notebook';

function read(value: unknown): Notebook {
  const result = parseNotebook(typeof value === 'string' ? value : JSON.stringify(value));
  if (!result.ok) throw new Error(`not a notebook: ${result.reason}`);
  return result.notebook;
}

function notebookWith(cells: unknown[], metadata: unknown = { language_info: { name: 'python' } }): unknown {
  return { cells, metadata, nbformat: 4, nbformat_minor: 5 };
}

const E = '\u001b[';

describe('parseNotebook', () => {
  it('reads cells in order with their kind, source and execution count', () => {
    const notebook = read(
      notebookWith([
        { cell_type: 'markdown', source: ['# 标题\n', '正文'] },
        { cell_type: 'code', execution_count: 3, source: 'print(1)', outputs: [] },
        { cell_type: 'code', execution_count: null, source: [], outputs: [] },
        { cell_type: 'raw', source: 'raw text' },
      ]),
    );
    expect(notebook.cells.map((cell) => [cell.kind, cell.source, cell.executionCount])).toEqual([
      ['markdown', '# 标题\n正文', null],
      ['code', 'print(1)', 3],
      ['code', '', null],
      ['raw', 'raw text', null],
    ]);
    expect(notebook.totalCells).toBe(4);
  });

  it('names the language as a person writes it', () => {
    expect(read(notebookWith([])).languageLabel).toBe('Python');
    expect(read(notebookWith([], { kernelspec: { language: 'R', display_name: 'R 4.4' } })).language).toBe('r');
    expect(read(notebookWith([], { kernelspec: { display_name: 'Deno' } })).languageLabel).toBe('Deno');
    expect(read(notebookWith([], {})).languageLabel).toBe('');
  });

  it('joins consecutive writes to the same stream and keeps stderr apart', () => {
    const [cell] = read(
      notebookWith([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'stream', name: 'stdout', text: ['a\n'] },
            { output_type: 'stream', name: 'stdout', text: 'b\n' },
            { output_type: 'stream', name: 'stderr', text: 'warn\n' },
            { output_type: 'stream', name: 'stdout', text: 'c\n' },
          ],
        },
      ]),
    ).cells;
    expect(cell?.outputs).toEqual([
      { kind: 'stream', name: 'stdout', text: 'a\nb\n', clipped: false },
      { kind: 'stream', name: 'stderr', text: 'warn\n', clipped: false },
      { kind: 'stream', name: 'stdout', text: 'c\n', clipped: false },
    ]);
  });

  it('prefers a picture, then HTML, then Markdown, then plain text', () => {
    const outputs = read(
      notebookWith([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            { output_type: 'display_data', metadata: { 'image/png': { width: 640, height: 400 } }, data: { 'image/png': 'iVBORw0K\nGgo=', 'text/html': '<b>x</b>', 'text/plain': 'fig' } },
            { output_type: 'execute_result', data: { 'text/html': ['<table>', '</table>'], 'text/plain': 'frame' } },
            { output_type: 'display_data', data: { 'text/markdown': '**done**', 'text/plain': 'done' } },
            { output_type: 'execute_result', data: { 'text/plain': ['42'] } },
            { output_type: 'display_data', data: { 'application/json': { a: 1 } } },
            { output_type: 'display_data', data: { 'image/svg+xml': '<svg xmlns="http://www.w3.org/2000/svg"/>' } },
            { output_type: 'display_data', data: { 'application/vnd.widget+json': {} } },
          ],
        },
      ]),
    ).cells[0]?.outputs;
    expect(outputs).toEqual([
      { kind: 'image', src: 'data:image/png;base64,iVBORw0KGgo=', width: 640, result: false },
      { kind: 'html', html: '<table></table>', fallback: 'frame', result: true },
      { kind: 'markdown', source: '**done**', result: false },
      { kind: 'text', text: '42', clipped: false, result: true },
      { kind: 'text', text: '{\n  "a": 1\n}', clipped: false, result: false },
      { kind: 'image', src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg"/>')}`, width: null, result: false },
    ]);
  });

  it('refuses a picture that is not base64', () => {
    const outputs = read(
      notebookWith([
        { cell_type: 'code', source: '', outputs: [{ output_type: 'display_data', data: { 'image/png': 'javascript:alert(1)', 'text/plain': 'fallback' } }] },
      ]),
    ).cells[0]?.outputs;
    expect(outputs).toEqual([{ kind: 'text', text: 'fallback', clipped: false, result: false }]);
  });

  it('states an error once and keeps only the frames of its traceback', () => {
    const outputs = read(
      notebookWith([
        {
          cell_type: 'code',
          source: '',
          outputs: [
            {
              output_type: 'error',
              ename: 'ZeroDivisionError',
              evalue: 'division by zero',
              traceback: [
                `${E}0;31m---------------------------------------------------------------------------${E}0m`,
                `${E}0;31mZeroDivisionError${E}0m                         Traceback (most recent call last)`,
                `Cell ${E}0;32mIn[7], line 5${E}0m\n${E}0;32m----> 5${E}0m renewal_rate(0, 0)\n`,
                `${E}0;31mZeroDivisionError${E}0m: division by zero`,
              ],
            },
          ],
        },
      ]),
    ).cells[0]?.outputs;
    expect(outputs).toEqual([
      { kind: 'error', name: 'ZeroDivisionError', message: 'division by zero', traceback: 'Cell In[7], line 5\n----> 5 renewal_rate(0, 0)', clipped: false },
    ]);
  });

  it('clips a huge output and marks it instead of failing the notebook', () => {
    const outputs = read(
      notebookWith([{ cell_type: 'code', source: '', outputs: [{ output_type: 'stream', name: 'stdout', text: 'x'.repeat(500_000) }] }]),
    ).cells[0]?.outputs;
    expect(outputs?.[0]).toMatchObject({ kind: 'stream', clipped: true });
    expect(outputs?.[0]?.kind === 'stream' ? outputs[0].text.length : 0).toBe(400_000);
  });

  it('reads attachments of a Markdown cell and ignores outputs it should not have', () => {
    const [cell] = read(
      notebookWith([
        {
          cell_type: 'markdown',
          source: '![图](attachment:a.png)',
          attachments: { 'a.png': { 'image/png': 'AAAA' }, 'b.txt': { 'text/plain': 'no' } },
          outputs: [{ output_type: 'stream', name: 'stdout', text: 'x' }],
        },
      ]),
    ).cells;
    expect(cell?.attachments).toEqual({ 'a.png': 'data:image/png;base64,AAAA' });
    expect(cell?.outputs).toEqual([]);
  });

  it('keeps no more cells than the cap and says how many there were', () => {
    const notebook = read(notebookWith(Array.from({ length: MAX_CELLS + 5 }, () => ({ cell_type: 'markdown', source: 'x' }))));
    expect(notebook.cells).toHaveLength(MAX_CELLS);
    expect(notebook.totalCells).toBe(MAX_CELLS + 5);
  });

  it('converts a format 3 notebook', () => {
    const notebook = read({
      nbformat: 3,
      metadata: { name: 'old' },
      worksheets: [
        {
          cells: [
            { cell_type: 'heading', level: 2, source: 'Title' },
            {
              cell_type: 'code',
              language: 'python',
              input: ['1 + 1'],
              prompt_number: 4,
              outputs: [
                { output_type: 'pyout', prompt_number: 4, text: ['2'] },
                { output_type: 'stream', stream: 'stderr', text: 'careful\n' },
                { output_type: 'pyerr', ename: 'NameError', evalue: 'x', traceback: ['NameError: x'] },
              ],
            },
          ],
        },
      ],
    });
    expect(notebook.cells[0]).toMatchObject({ kind: 'markdown', source: '## Title' });
    expect(notebook.cells[1]).toMatchObject({ kind: 'code', source: '1 + 1', executionCount: 4 });
    expect(notebook.cells[1]?.outputs).toEqual([
      { kind: 'text', text: '2', clipped: false, result: true },
      { kind: 'stream', name: 'stderr', text: 'careful\n', clipped: false },
      { kind: 'error', name: 'NameError', message: 'x', traceback: '', clipped: false },
    ]);
  });

  it('says why a file is not a notebook', () => {
    expect(parseNotebook('not json')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseNotebook('[1, 2]')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseNotebook('{"cells": "nope", "nbformat": 4}')).toEqual({ ok: false, reason: 'invalid' });
    expect(parseNotebook('{"nbformat": 2, "worksheet": {}}')).toEqual({ ok: false, reason: 'version' });
  });

  it('survives fields of the wrong type', () => {
    const notebook = read(notebookWith([null, 7, { cell_type: 'code', source: 5, outputs: 'x', execution_count: 'one' }, { cell_type: 'code', outputs: [null, { output_type: 'stream' }, { output_type: 'error' }] }], 'bad'));
    expect(notebook.cells.map((cell) => [cell.kind, cell.source, cell.executionCount, cell.outputs.length])).toEqual([
      ['raw', '', null, 0],
      ['raw', '', null, 0],
      ['code', '', null, 0],
      ['code', '', null, 0],
    ]);
  });
});

describe('terminalText', () => {
  it('lets a carriage return redraw the line, as a progress bar does', () => {
    expect(terminalText(' 10%|█\r 50%|█████\r100%|██████████\ndone\r\n')).toBe('100%|██████████\ndone\n');
  });

  it('drops colour codes', () => {
    expect(terminalText(`${E}32mok${E}0m`)).toBe('ok');
  });
});
