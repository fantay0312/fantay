// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Formulas and Mermaid fences in the chat Markdown renderer: formulas are typeset wherever text is
// emitted (paragraphs, bold, table cells, list items), text that only looks like a formula stays as
// written, and a Mermaid fence becomes a diagram block only once it is closed.
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { loadMathEngine } from '../../../src/fantay/artifact/math/engine';
import { renderMarkdown } from '../../../src/runtime/markdown';

function show(markdown: string, options?: Parameters<typeof renderMarkdown>[1]): HTMLElement {
  return render(<div>{renderMarkdown(markdown, options)}</div>).container;
}

beforeAll(async () => {
  await act(async () => {
    await loadMathEngine();
  });
});

afterEach(cleanup);

describe('formulas in a chat message', () => {
  it('typesets inline and display formulas in every delimiter form', () => {
    const container = show('面积 $\\pi r^2$，速度 \\(O(1/\\sqrt{n})\\)。\n\n$$\nE = mc^2\n$$\n\n\\[\n\\Pr(A) = \\frac{1}{2}\n\\]');
    expect(container.querySelectorAll('[data-math="inline"] .katex')).toHaveLength(2);
    expect(container.querySelectorAll('[data-math="display"] .katex-display')).toHaveLength(2);
    // Nothing of the delimiters or the marks is left in the text.
    expect(container.textContent).not.toMatch(/\$|\\\(|\u2063/);
  });

  it('keeps subscripts and asterisks inside a formula out of the emphasis rules', () => {
    const container = show('given $x_i$ and $y_i$, then $a * b * c$');
    expect(container.querySelectorAll('[data-math="inline"]')).toHaveLength(3);
    expect(container.querySelector('em')).toBeNull();
  });

  it('typesets inside bold text, list items and table cells', () => {
    const container = show('**关键是 $x^2$**\n\n- 第一项 $a$\n- 第二项 $b$\n\n| 点数 $n$ | 误差 |\n| --- | --- |\n| $10^2$ | $9.8 \\times 10^{-2}$ |');
    expect(container.querySelector('strong [data-math="inline"]')).not.toBeNull();
    expect(container.querySelectorAll('li [data-math="inline"]')).toHaveLength(2);
    expect(container.querySelectorAll('th [data-math="inline"]')).toHaveLength(1);
    expect(container.querySelectorAll('td [data-math="inline"]')).toHaveLength(2);
    // The table still has its two columns.
    expect(container.querySelectorAll('tbody td')).toHaveLength(2);
  });

  it('leaves money, shell text, code and escaped brackets exactly as written', () => {
    const text = '一杯咖啡 $5，一包豆子 $12；$PATH:$HOME；`$x$`；\\(见下文\\)';
    const container = show(text);
    expect(container.querySelector('[data-math]')).toBeNull();
    expect(container.textContent).toBe('一杯咖啡 $5，一包豆子 $12；$PATH:$HOME；$x$；\\(见下文\\)');
  });

  it('shows text KaTeX cannot set as it was written', () => {
    const container = show('this $\\notacommand{$ stays');
    expect(container.querySelector('[data-math]')).toBeNull();
    expect(container.textContent).toBe('this $\\notacommand{$ stays');
  });

  it('never lets a formula write an address or a handler', () => {
    const container = show('$\\href{javascript:alert(1)}{x}$ and $\\htmlStyle{color:red}{y}$');
    expect(container.querySelector('a[href]')).toBeNull();
    for (const element of Array.from(container.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.value).not.toMatch(/javascript:/i);
      }
    }
  });

  it('typesets a closed math fence and leaves an open one as code', () => {
    const closed = show('```math\n\\int_0^1 x\\,dx\n```');
    expect(closed.querySelector('[data-math="display"] .katex-display')).not.toBeNull();
    const open = show('```math\n\\int_0^1 x');
    expect(open.querySelector('[data-math]')).toBeNull();
    expect(open.querySelector('pre code')?.textContent).toBe('\\int_0^1 x');
  });

  it('can be turned off', () => {
    const container = show('面积 $\\pi r^2$', { math: false });
    expect(container.querySelector('[data-math]')).toBeNull();
    expect(container.textContent).toBe('面积 $\\pi r^2$');
  });
});

describe('a Mermaid fence in a chat message', () => {
  const FLOW = '```mermaid\nflowchart LR\n  A[下单] --> B[烘焙]\n```';

  it('is a diagram block once the fence is closed', async () => {
    const container = show(FLOW);
    const block = container.querySelector('[data-md-diagram]');
    expect(block).not.toBeNull();
    // The source is one click away and can be copied; the drawing code arrives as its own chunk.
    expect(block?.querySelectorAll('button')).toHaveLength(2);
    await waitFor(() => expect(container.querySelector('[data-diagram-figure]')).not.toBeNull());
  });

  it('stays a code block while the fence is still being written', () => {
    const container = show('```mermaid\nflowchart LR\n  A[下单] --> B[烘');
    expect(container.querySelector('[data-md-diagram]')).toBeNull();
    expect(container.querySelector('pre code')?.textContent).toContain('flowchart LR');
  });

  it('stays a code block when diagrams are off', () => {
    const container = show(FLOW, { diagrams: false });
    expect(container.querySelector('[data-md-diagram]')).toBeNull();
    expect(container.querySelector('.md-code-lang')?.textContent).toBe('mermaid');
  });
});
