// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The notebook viewer end to end in jsdom: cells and their outputs in saved order, nothing from the
// file that could run, long outputs folded, the source view, and the states for a file that is not a
// notebook or has no cells.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { artifactFileFamily } from '../../../src/fantay/artifact/file-family';
import { resetArtifactViewState } from '../../../src/fantay/artifact/use-view-state';
import NotebookViewer from '../../../src/fantay/artifact/viewers/NotebookViewer';
import { cellLanguage } from '../../../src/fantay/artifact/viewers/notebook/NotebookPage';
import type { ProjectFile } from '../../../src/types';

const PIXEL = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let body = '';

function notebookFile(size = 2000, mtime = 1): ProjectFile {
  return { name: 'notes/analysis.ipynb', size, mtime, kind: 'binary', mime: 'application/octet-stream' };
}

function show(target: ProjectFile = notebookFile()) {
  return render(<NotebookViewer projectId="p1" file={target} family={artifactFileFamily(target.name, target.mime)} active />);
}

function notebook(cells: unknown[]): string {
  return JSON.stringify({ cells, metadata: { language_info: { name: 'python' } }, nbformat: 4, nbformat_minor: 5 });
}

function code(source: string, outputs: unknown[] = [], count: number | null = 1): unknown {
  return { cell_type: 'code', execution_count: count, metadata: {}, source, outputs };
}

beforeEach(() => {
  resetArtifactViewState();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(body)),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('NotebookViewer', () => {
  it('shows prose, code and each kind of saved output in order', async () => {
    body = notebook([
      { cell_type: 'markdown', source: '# 续订率分析\n\n其中 $x_i$ 是第 $i$ 个月。\n\n| 指标 | 目标 |\n| :-- | --: |\n| 续订率 | 75% |' },
      code('df', [
        {
          output_type: 'execute_result',
          data: {
            'text/html': '<div><style>.x{color:red}</style><table class="dataframe"><tr><th>月份</th></tr><tr><td>5月</td></tr></table><script>window.__ran = true</script><img src="https://example.test/t.gif"></div>',
            'text/plain': 'frame',
          },
        },
      ]),
      code('print("最高", 0.78)', [{ output_type: 'stream', name: 'stdout', text: '最高 0.78\n' }, { output_type: 'stream', name: 'stderr', text: 'UserWarning: 数据缺失\n' }], 2),
      code('plt.show()', [{ output_type: 'display_data', metadata: { 'image/png': { width: 320 } }, data: { 'image/png': PIXEL, 'text/plain': '<Figure>' } }], 3),
      code('1 / 0', [{ output_type: 'error', ename: 'ZeroDivisionError', evalue: 'division by zero', traceback: ['Cell In[4], line 1\n----> 1 1 / 0', 'ZeroDivisionError: division by zero'] }], 4),
      code('', [], null),
    ]);
    const { container } = show();

    await waitFor(() => expect(container.querySelector('h1')?.textContent).toBe('续订率分析'));
    expect(container.querySelector('[data-artifact-bar]')?.textContent).toContain('6 cells · Python');

    // Prose: a table, and TeX typeset once the math engine has loaded (its source until then).
    const prose = container.querySelector('[data-kind="markdown"]')!;
    expect(prose.querySelector('table td')?.textContent).toBe('续订率');
    await waitFor(() => expect(prose.querySelectorAll('[data-math="inline"] .katex')).toHaveLength(2));
    expect(prose.querySelectorAll('code')).toHaveLength(0);

    // Code cells keep their prompts; a cell with nothing in it takes no room.
    const cells = Array.from(container.querySelectorAll('[data-kind="code"]'));
    expect(cells).toHaveLength(4);
    expect(cells.map((cell) => cell.querySelector('span[aria-hidden="true"]')?.textContent)).toEqual(['In [1]', 'In [2]', 'In [3]', 'In [4]']);
    expect(cells[0]?.textContent).toContain('df');

    // The HTML table is there; its style, its script and its remote picture are not.
    const table = cells[0]?.querySelector('[data-output="html"] table');
    expect(table?.textContent).toContain('月份');
    expect(table?.hasAttribute('class')).toBe(false);
    expect(container.querySelector('script, style, img[src^="http"]')).toBeNull();
    expect((window as unknown as { __ran?: boolean }).__ran).toBeUndefined();
    expect(cells[0]?.textContent).toContain('Out [1]');

    // Printed text, then what went to stderr.
    const streams = Array.from(cells[1]?.querySelectorAll('[data-output="stream"] pre') ?? []);
    expect(streams.map((item) => item.textContent)).toEqual(['最高 0.78\n', 'UserWarning: 数据缺失\n']);

    // The figure comes from inside the file, at the size its author saw.
    const image = cells[2]?.querySelector('img');
    expect(image?.getAttribute('src')).toBe(`data:image/png;base64,${PIXEL}`);
    expect(image?.getAttribute('alt')).toBe('Output image of cell 4');
    expect(image?.style.width).toBe('320px');

    // The error is stated once, above its frames.
    const error = cells[3]?.querySelector('[data-output="error"]');
    expect(error?.querySelector('p')?.textContent).toBe('ZeroDivisionError: division by zero');
    expect(error?.querySelector('pre')?.textContent).toBe('Cell In[4], line 1\n----> 1 1 / 0');

    expect(container.textContent).toContain('Saved outputs only. Code is not run here.');
  });

  it('colours code once the highlighter has loaded and keeps the text the same', async () => {
    body = notebook([code('import pandas as pd\nrates = [0.70, 0.71]')]);
    const { container } = show();

    await waitFor(() => expect(container.querySelector('[data-kind="code"] pre')?.textContent).toContain('import pandas as pd'));
    await waitFor(() => expect(container.querySelector('[data-kind="code"] pre.shiki')).not.toBeNull(), { timeout: 4000 });
    const highlighted = container.querySelector('[data-kind="code"] pre.shiki')!;
    expect(highlighted.textContent).toBe('import pandas as pd\nrates = [0.70, 0.71]');
    expect(highlighted.hasAttribute('tabindex')).toBe(false);
    expect(highlighted.querySelector('span[style]')).not.toBeNull();
  });

  it('folds a long output and remembers that the reader opened it', async () => {
    const printed = `${Array.from({ length: 120 }, (_, index) => `row ${index}`).join('\n')}\n`;
    body = notebook([code('for row in rows: print(row)', [{ output_type: 'stream', name: 'stdout', text: printed }])]);
    const first = show();

    const more = await screen.findByRole('button', { name: 'Show all 120 lines' });
    const output = (): string => first.container.querySelector('[data-output="stream"] pre')?.textContent ?? '';
    expect(output()).toContain('row 23');
    expect(output()).not.toContain('row 24');
    expect(more.getAttribute('aria-expanded')).toBe('false');

    fireEvent.click(more);
    expect(output()).toContain('row 119');
    expect(screen.getByRole('button', { name: 'Show less' }).getAttribute('aria-expanded')).toBe('true');
    first.unmount();

    // The tab comes back as a new viewer: what was opened is still open.
    const second = show();
    await screen.findByRole('button', { name: 'Show less' });
    expect(second.container.querySelector('[data-output="stream"] pre')?.textContent).toContain('row 119');
  });

  it('mounts a long notebook in batches and adds more on request', async () => {
    body = notebook(Array.from({ length: 95 }, (_, index) => ({ cell_type: 'markdown', source: `段落 ${index}` })));
    const { container } = show();

    await waitFor(() => expect(container.querySelectorAll('[data-cell]')).toHaveLength(40));
    expect(container.querySelector('[data-artifact-bar]')?.textContent).toContain('95 cells');
    fireEvent.click(screen.getByRole('button', { name: 'Show 40 more cells' }));
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(80);
    fireEvent.click(screen.getByRole('button', { name: 'Show 15 more cells' }));
    expect(container.querySelectorAll('[data-cell]')).toHaveLength(95);
    expect(screen.queryByRole('button', { name: /more cells/ })).toBeNull();
  });

  it('shows the file as source, with wrap and copy, and remembers the view', async () => {
    body = notebook([code('x = 1')]);
    const first = show();
    await waitFor(() => expect(first.container.querySelector('[data-kind="code"]')).not.toBeNull());
    // Reading the notebook needs neither wrap nor copy.
    expect(first.container.querySelector('[data-artifact-action="wrap"]')).toBeNull();

    fireEvent.click(screen.getByRole('radio', { name: 'Source' }));
    await waitFor(() => expect(first.container.querySelector('.cm-content')?.textContent).toContain('"cell_type":"code"'));
    expect(first.container.querySelector('[data-artifact-action="wrap"]')).not.toBeNull();
    expect(first.container.querySelector('[data-artifact-action="copy"]')).not.toBeNull();
    first.unmount();

    const second = show();
    await waitFor(() => expect(second.container.querySelector('.cm-content')?.textContent).toContain('"cell_type":"code"'));
    expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true');
  });

  it('says when the file is not a notebook and offers the source instead', async () => {
    body = '{"cells": "not a list", "nbformat": 4}';
    const { container } = show();

    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain("This file can't be read as a notebook"));
    fireEvent.click(screen.getByRole('button', { name: 'View source' }));
    await waitFor(() => expect(container.querySelector('.cm-content')?.textContent).toContain('"cells": "not a list"'));
    expect(screen.getByRole('radio', { name: 'Source' }).getAttribute('aria-checked')).toBe('true');
  });

  it('says when a notebook has no cells', async () => {
    body = notebook([]);
    const { container } = show();
    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('This notebook has no cells'));
  });

  it('does not fetch a notebook over the size limit', async () => {
    const { container } = show(notebookFile(30 * 1024 * 1024));
    await waitFor(() => expect(container.querySelector('[data-artifact-state="notice"]')?.textContent).toContain('too large'));
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});

describe('cellLanguage', () => {
  it('follows a cell magic, then the kernel language', () => {
    expect(cellLanguage('%%bash\nls', 'python')).toBe('bash');
    expect(cellLanguage('%%sql\nselect 1', 'python')).toBe('sql');
    expect(cellLanguage('%%time\nx = 1', 'python')).toBe('python');
    expect(cellLanguage('x = 1', 'ipython3')).toBe('python');
    expect(cellLanguage('x <- 1', 'r')).toBe('r');
  });
});
