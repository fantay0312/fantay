// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Formulas in a notebook: typeset by KaTeX once the engine is loaded, readable as source before
// that and whenever a formula cannot be set, and never a way for the notebook to put markup of its
// own in the page.
import { beforeAll, describe, expect, it } from 'vitest';

import { loadMathEngine, mathEngineReady, typesetLatexOutput } from '../../../src/fantay/artifact/viewers/notebook/math';
import { markMath, renderNotebookMarkdown } from '../../../src/fantay/artifact/viewers/notebook/notebook-html';
import { parseNotebook } from '../../../src/fantay/artifact/viewers/notebook/parse-notebook';

function dom(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

describe('markMath', () => {
  it('numbers each formula and leaves a mark where it stood', () => {
    const { markdown, formulas } = markMath('where $x_i$ is\n$$\\bar{r} = \\frac{1}{T}$$\nand $y$');
    expect(formulas).toEqual([
      { tex: '\\bar{r} = \\frac{1}{T}', display: true },
      { tex: 'x_i', display: false },
      { tex: 'y', display: false },
    ]);
    expect(markdown).not.toContain('x_i');
    expect(markdown).toContain('`\u20631\u2063`');
    expect(markdown).toContain('```\n\u20630\u2063\n```');
  });

  it('finds no formula in money or in code', () => {
    expect(markMath('costs $5 and $10 each').formulas).toEqual([]);
    expect(markMath('run `echo $HOME and $PATH` now').formulas).toEqual([]);
    expect(markMath('```sh\necho $a $b\n```').formulas).toEqual([]);
  });
});

describe('before the engine is loaded', () => {
  it('keeps formulas readable as their source', () => {
    expect(mathEngineReady()).toBe(false);
    const html = renderNotebookMarkdown('where $x_i$ is');
    expect(dom(html).querySelector('code')?.textContent).toBe('$x_i$');
    expect(html).not.toContain('katex');
    expect(typesetLatexOutput('$x^2$')).toBe('');
  });
});

describe('with the engine loaded', () => {
  beforeAll(async () => {
    await loadMathEngine();
  });

  it('typesets inline and display formulas in place', () => {
    expect(mathEngineReady()).toBe(true);
    const page = dom(renderNotebookMarkdown('续订率 $r_t = \\frac{N^{renew}_t}{N^{due}_t}$ 按月统计。\n\n$$\\bar{r} = \\frac{1}{T}\\sum_{t=1}^{T} r_t$$'));
    const inline = page.querySelector('[data-math="inline"]');
    const display = page.querySelector('[data-math="display"]');
    expect(inline?.tagName).toBe('SPAN');
    expect(inline?.querySelector('.katex')).not.toBeNull();
    expect(display?.tagName).toBe('DIV');
    expect(display?.querySelector('.katex-display')).not.toBeNull();
    // The formula replaced its code block; no mark and no source is left beside it.
    expect(page.querySelector('pre')).toBeNull();
    expect(page.textContent).not.toContain('\u2063');
    expect(page.textContent).toContain('续订率');
  });

  it('still leaves money and code alone', () => {
    const page = dom(renderNotebookMarkdown('costs $5 and $10; run `echo $HOME and $PATH`'));
    expect(page.querySelector('[data-math]')).toBeNull();
    expect(page.querySelector('code')?.textContent).toBe('echo $HOME and $PATH');
  });

  it('writes a formula it cannot set back as its source', () => {
    const page = dom(renderNotebookMarkdown('broken $\\frac{1}{$ here and $$\\begin{nosuchenv} x \\end{nosuchenv}$$'));
    expect(page.querySelector('[data-math]')).toBeNull();
    const shown = Array.from(page.querySelectorAll('code')).map((code) => code.textContent);
    expect(shown).toContain('$\\frac{1}{$');
    expect(shown.some((text) => (text ?? '').includes('\\begin{nosuchenv}'))).toBe(true);
    expect(page.textContent).not.toContain('\u2063');
  });

  it('gives a formula no way to add links, scripts or attributes of its own', () => {
    const page = dom(
      renderNotebookMarkdown(
        [
          '$\\href{javascript:alert(1)}{x}$',
          '$\\url{https://example.com/track}$',
          '$\\htmlStyle{position:fixed;inset:0}{y}$',
          '$\\htmlId{app}{z}$',
          '$\\includegraphics{https://example.com/pixel.png}$',
          '$x<script>alert(1)</script>$',
        ].join('\n\n'),
      ),
    );
    expect(page.querySelector('a')).toBeNull();
    expect(page.querySelector('script')).toBeNull();
    expect(page.querySelector('img')).toBeNull();
    expect(page.querySelector('#app')).toBeNull();
    expect(page.querySelector('[href], [src], [xlink\\:href]')).toBeNull();
    // KaTeX keeps the formula's source as the text of a MathML annotation; text is inert. What must
    // not exist is an attribute that carries it.
    for (const element of Array.from(page.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.value).not.toMatch(/javascript:/i);
        expect(attribute.value).not.toMatch(/position\s*:\s*fixed/i);
        expect(attribute.value).not.toMatch(/example\.com/i);
      }
    }
  });

  it('typesets a kernel formula, with or without its dollar signs', () => {
    expect(typesetLatexOutput('$\\displaystyle \\frac{x^{2}}{2}$')).toContain('katex-display');
    expect(typesetLatexOutput('$$a^2 + b^2 = c^2$$')).toContain('katex-display');
    expect(typesetLatexOutput('\\[ e^{i\\pi} + 1 = 0 \\]')).toContain('katex-display');
    expect(typesetLatexOutput('\\alpha + \\beta')).toContain('katex-display');
  });

  it('gives up on what is not one formula, so the plain form is shown', () => {
    expect(typesetLatexOutput('')).toBe('');
    expect(typesetLatexOutput('$a$ and $b$')).toBe('');
    expect(typesetLatexOutput('\\begin{tabular}{ll} a & b \\end{tabular}')).toBe('');
  });
});

describe('a kernel value given as TeX', () => {
  it('is kept as a formula with its plain form to fall back on', () => {
    const result = parseNotebook(
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: { language_info: { name: 'python' } },
        cells: [
          {
            cell_type: 'code',
            execution_count: 1,
            source: 'x**2/2',
            outputs: [
              { output_type: 'execute_result', execution_count: 1, data: { 'text/latex': '$\\displaystyle \\frac{x^{2}}{2}$', 'text/plain': 'x**2/2' } },
              { output_type: 'display_data', data: { 'text/latex': `\\documentclass{article} ${'x'.repeat(20_001)}`, 'text/plain': 'a long document' } },
            ],
          },
        ],
      }),
    );
    if (!result.ok) throw new Error('not a notebook');
    const outputs = result.notebook.cells[0]?.outputs ?? [];
    expect(outputs[0]).toEqual({ kind: 'latex', source: '$\\displaystyle \\frac{x^{2}}{2}$', fallback: 'x**2/2', result: true });
    expect(outputs[1]).toMatchObject({ kind: 'text', text: 'a long document' });
  });
});
