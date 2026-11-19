// SPDX-License-Identifier: AGPL-3.0-only
// Formulas in a Markdown document whose preview is an HTML string (the document viewer in
// `components/FileViewer.tsx`). Two steps the preview calls in order:
//  1. `prepareDocumentMath` before Markdown is parsed: each formula becomes a numbered mark inside
//     a code span or a fenced block, so Markdown and the renderer's escaping carry it untouched;
//  2. `restoreDocumentMath` on the renderer's HTML: each mark becomes the typeset formula. The
//     markup put there is what KaTeX built (`trust` off), never the document's. Without the engine,
//     or for text KaTeX cannot set, the formula is shown as its source in the code style.
import type { Formula } from './engine';
import { typesetFormula } from './engine';
import { mathMark } from './find-math';
import { markMath } from './marked-math';

const DELIMITERS = { backslash: true } as const;
const MARK_TEXT = mathMark(0).replace('0', '(\\d+)');
/** A fenced block that holds one mark and nothing else, as the Markdown renderer writes it. */
const MARKED_BLOCK = new RegExp(`<pre><code>${MARK_TEXT}\\n?</code></pre>`, 'g');
const MARKED_SPAN = new RegExp(`<code>${MARK_TEXT}</code>`, 'g');

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function prepareDocumentMath(markdown: string): { markdown: string; formulas: Formula[] } {
  return markMath(markdown, DELIMITERS);
}

export function restoreDocumentMath(html: string, formulas: readonly Formula[]): string {
  if (formulas.length === 0) return html;
  const block = html.replace(MARKED_BLOCK, (whole, index: string) => {
    const formula = formulas[Number(index)];
    if (!formula) return whole;
    const markup = typesetFormula(formula);
    return markup === null ? `<pre><code class="language-math">${escapeHtml(formula.tex)}</code></pre>` : `<div data-math="display">${markup}</div>`;
  });
  return block.replace(MARKED_SPAN, (whole, index: string) => {
    const formula = formulas[Number(index)];
    if (!formula) return whole;
    const markup = typesetFormula(formula);
    if (markup === null) return `<code>${escapeHtml(formula.display ? `$$${formula.tex}$$` : `$${formula.tex}$`)}</code>`;
    return `<span data-math="${formula.display ? 'display' : 'inline'}">${markup}</span>`;
  });
}
