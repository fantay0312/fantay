// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Formulas and Mermaid blocks in a Markdown document whose preview is an HTML string: formulas are
// taken out before Markdown is parsed and typeset in its output; a Mermaid block gets its drawing
// next to its (hidden) source; a block that stops drawing keeps the drawing it had.
import { beforeAll, describe, expect, it } from 'vitest';

import { renderMarkdownToSafeHtml } from '../../../src/artifacts/markdown';
import {
  DIAGRAM_BLOCK_ATTR,
  drawDocumentDiagram,
  figuresByBlock,
  isDiagramCode,
  type DocumentDiagramOptions,
} from '../../../src/fantay/artifact/embed/markdown-document';
import { prepareDocumentMath, restoreDocumentMath } from '../../../src/fantay/artifact/math/document-math';
import { loadMathEngine, resetMathEngineForTests } from '../../../src/fantay/artifact/math/engine';

function page(markdown: string): HTMLElement {
  const math = prepareDocumentMath(markdown);
  const root = document.createElement('div');
  root.innerHTML = restoreDocumentMath(renderMarkdownToSafeHtml(math.markdown), math.formulas);
  return root;
}

describe('formulas in a Markdown document', () => {
  beforeAll(async () => {
    await loadMathEngine();
  });

  it('typesets inline and display formulas', () => {
    const root = page('面积 $\\pi r^2$，速度 \\(O(1/\\sqrt{n})\\)。\n\n$$\n\\hat{\\pi} = 4 \\cdot \\frac{n_{内}}{n}\n$$');
    expect(root.querySelectorAll('span[data-math="inline"] .katex')).toHaveLength(2);
    expect(root.querySelectorAll('div[data-math="display"] .katex-display')).toHaveLength(1);
    expect(root.textContent).not.toMatch(/\u2063/);
  });

  it('keeps a table with several formulas in a row in its columns', () => {
    const root = page('| 点数 $n$ | 估计值 | 误差 |\n| --- | --- | --- |\n| $10^2$ | 3.24 | $9.8 \\times 10^{-2}$ |');
    const cells = Array.from(root.querySelectorAll('tbody td'));
    expect(cells).toHaveLength(3);
    expect(cells[0]?.querySelector('[data-math="inline"]')).not.toBeNull();
    expect(cells[1]?.textContent).toBe('3.24');
    expect(cells[2]?.querySelector('[data-math="inline"]')).not.toBeNull();
  });

  it('keeps a display formula inside a table cell in its cell', () => {
    const root = page('| 式子 | 说明 |\n| --- | --- |\n| $$x^2$$ | 平方 |');
    expect(root.querySelectorAll('tbody td')).toHaveLength(2);
    expect(root.querySelector('tbody td [data-math="display"]')).not.toBeNull();
  });

  it('leaves money, shell text, code and escaped brackets as Markdown shows them', () => {
    const root = page('一杯咖啡 $5，一包豆子 $12；$PATH 和 $HOME；`$x$`；\\(见下文\\) 和 \\[可选\\]。\n\n```python\nprint("$a$")\n```');
    expect(root.querySelector('[data-math]')).toBeNull();
    expect(root.querySelector('p')?.textContent).toBe('一杯咖啡 $5，一包豆子 $12；$PATH 和 $HOME；$x$；(见下文) 和 [可选]。');
    expect(root.querySelector('pre code')?.textContent).toContain('print("$a$")');
  });

  it('writes text KaTeX cannot set back as its source, escaped', () => {
    const root = page('坏的 $\\notacommand{<img src=x onerror=1>$ 公式');
    expect(root.querySelector('[data-math]')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    expect(root.querySelector('code')?.textContent).toBe('$\\notacommand{<img src=x onerror=1>$');
  });
});

describe('formulas before the engine is loaded', () => {
  it('reads as its source in the code style', () => {
    resetMathEngineForTests();
    const root = page('面积 $\\pi r^2$\n\n$$\nE = mc^2\n$$');
    expect(root.querySelector('[data-math]')).toBeNull();
    expect(root.querySelector('p code')?.textContent).toBe('$\\pi r^2$');
    expect(root.querySelector('pre code.language-math')?.textContent).toBe('E = mc^2');
  });
});

describe('a table row with two code spans', () => {
  it('keeps its column separators (the spans are paired left to right)', () => {
    const root = document.createElement('div');
    root.innerHTML = renderMarkdownToSafeHtml('| a | b | c |\n| --- | --- | --- |\n| `x` | y | `z` |\n| `p|q` | r | s |');
    const rows = Array.from(root.querySelectorAll('tbody tr'));
    expect(Array.from(rows[0]?.querySelectorAll('td') ?? []).map((cell) => cell.textContent)).toEqual(['x', 'y', 'z']);
    expect(Array.from(rows[1]?.querySelectorAll('td') ?? []).map((cell) => cell.textContent)).toEqual(['p|q', 'r', 's']);
  });
});

describe('a Mermaid block in a Markdown document', () => {
  const BLOCK = '[data-block]';
  const options: DocumentDiagramOptions = {
    availableWidth: 640,
    kindLabel: (type) => `kind:${type}`,
    failedNote: (line) => `failed:${line}`,
    staleNote: (line) => `stale:${line}`,
  };

  /** The preview's frame around a code block, as `decorateMarkdownCodeBlocks` writes it. */
  function block(source: string, language = 'mermaid'): { wrapper: HTMLElement; code: HTMLElement } {
    const inert = new DOMParser().parseFromString('<div data-block="0" data-language="MERMAID"><pre><code></code></pre></div>', 'text/html');
    const wrapper = inert.body.firstElementChild as HTMLElement;
    const code = wrapper.querySelector('code') as HTMLElement;
    code.className = `language-${language}`;
    code.textContent = `${source}\n`;
    return { wrapper, code };
  }

  it('knows a Mermaid block by its language', () => {
    expect(isDiagramCode(block('graph TD').code)).toBe(true);
    expect(isDiagramCode(block('x = 1', 'python').code)).toBe(false);
  });

  it('draws next to the source, which stays for the copy button', async () => {
    const { wrapper, code } = block('flowchart LR\n  A[下单] --> B[烘焙]');
    expect(await drawDocumentDiagram(wrapper, code, 'data-language', options)).toBe(true);
    expect(wrapper.getAttribute(DIAGRAM_BLOCK_ATTR)).toBe('drawn');
    expect(wrapper.getAttribute('data-language')).toBe('kind:flowchart');
    expect(wrapper.querySelector('pre')?.hidden).toBe(true);
    expect(wrapper.querySelector('pre')?.textContent).toContain('A[下单] --> B[烘焙]');
    const figure = wrapper.querySelector('[role="img"]');
    expect(figure?.getAttribute('aria-label')).toBe('kind:flowchart');
    expect(figure?.querySelector('svg')).not.toBeNull();
    // Inert like the viewer's drawing: nothing that runs or loads.
    expect(figure?.querySelector('script, image, foreignObject, use')).toBeNull();
  });

  it('keeps the source and says which line when the text does not draw', async () => {
    const { wrapper, code } = block('flowchart TD\n  A --> B[支付定金(30%)]');
    expect(await drawDocumentDiagram(wrapper, code, 'data-language', options)).toBe(true);
    expect(wrapper.getAttribute(DIAGRAM_BLOCK_ATTR)).toBe('failed');
    expect(wrapper.querySelector('pre')?.hidden).toBe(false);
    expect(wrapper.querySelector('[role="note"]')?.textContent).toBe('failed:2');
    expect(wrapper.querySelector('[role="img"]')).toBeNull();
  });

  it('keeps the drawing a block had when an edit stops it drawing', async () => {
    const good = block('flowchart LR\n  A[下单] --> B[烘焙]');
    await drawDocumentDiagram(good.wrapper, good.code, 'data-language', options);
    const shown = figuresByBlock(good.wrapper.ownerDocument, BLOCK);
    expect(shown).toHaveLength(1);

    const broken = block('flowchart LR\n  A[下单] --> B[烘');
    expect(await drawDocumentDiagram(broken.wrapper, broken.code, 'data-language', options, shown[0])).toBe(true);
    expect(broken.wrapper.getAttribute(DIAGRAM_BLOCK_ATTR)).toBe('stale');
    expect(broken.wrapper.querySelector('[role="img"] svg')).not.toBeNull();
    expect(broken.wrapper.querySelector('[role="note"]')?.textContent).toMatch(/^stale:/);
    expect(broken.wrapper.querySelector('pre')?.hidden).toBe(true);
  });

  it('lists one entry per Mermaid block, in order', () => {
    const inert = new DOMParser().parseFromString(
      '<div data-block="0"><pre><code class="language-python">x</code></pre></div>' +
        '<div data-block="1"><pre><code class="language-mermaid">a</code></pre><div data-markdown-figure="flowchart"></div></div>' +
        '<div data-block="2"><pre><code class="language-mermaid">b</code></pre></div>',
      'text/html',
    );
    const figures = figuresByBlock(inert.body, BLOCK);
    expect(figures).toHaveLength(2);
    expect(figures[0]?.getAttribute('data-markdown-figure')).toBe('flowchart');
    expect(figures[1]).toBeNull();
  });
});
