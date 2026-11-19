// SPDX-License-Identifier: AGPL-3.0-only
// Formulas in Markdown that is rendered to HTML (notebook cells, Markdown documents). The formulas
// are taken out before Markdown is parsed and put back after the result has been sanitised:
//  - `markMath` replaces each formula by a numbered mark inside a code span or a fenced block, so
//    Markdown and the sanitiser carry it through untouched;
//  - `typesetMarkedMath` finds those marks in the sanitised markup and puts the typeset formula
//    there. This runs after the allow-list on purpose: a typeset formula is markup KaTeX built, not
//    the document's;
//  - `protectMath` is for when the engine is not loaded: the formula stays readable as its source.
import { typesetFormula, type Formula } from './engine';
import { mathMark, replaceMath, soleMathMark, type FindMathOptions } from './find-math';

/**
 * Keeps TeX readable when it cannot be typeset. Markdown would eat it (`x_i` and `y_i` become one
 * italic run, `\\` loses a slash), so each formula is set as code: display math as a block, inline
 * math as a span, shown as its source, exactly as written.
 */
export function protectMath(markdown: string, options?: FindMathOptions): string {
  return replaceMath(
    markdown,
    (tex) => `\n\n\`\`\`math\n${tex}\n\`\`\`\n\n`,
    (tex) => `\`$${tex}$\``,
    options,
  );
}

/**
 * The same formulas, each replaced by a numbered mark in a code span or block, so Markdown and the
 * sanitiser carry it through untouched and `typesetMarkedMath` can put the typeset formula there.
 */
export function markMath(markdown: string, options?: FindMathOptions): { markdown: string; formulas: Formula[] } {
  const formulas: Formula[] = [];
  const mark = (tex: string, display: boolean): string => {
    formulas.push({ tex, display });
    return mathMark(formulas.length - 1);
  };
  const marked = replaceMath(
    markdown,
    // Inside a sentence, a list item or a table cell the formula stays in place, as a code span.
    (tex, _written, alone) => (alone ? `\n\n\`\`\`\n${mark(tex, true)}\n\`\`\`\n\n` : `\`${mark(tex, true)}\``),
    (tex) => `\`${mark(tex, false)}\``,
    options,
  );
  return { markdown: marked, formulas };
}

/** The element a typeset formula sits in: `data-math` says whether it is set on its own line. */
export function formulaHolder(formula: Formula, markup: string, owner: Document = document): HTMLElement {
  const holder = owner.createElement(formula.display ? 'div' : 'span');
  holder.setAttribute('data-math', formula.display ? 'display' : 'inline');
  holder.innerHTML = markup;
  return holder;
}

/**
 * Replaces each marked code span or block in sanitised markup by its typeset formula. A formula
 * the engine cannot set is written back as its source, in the code style it already has.
 */
export function typesetMarkedMath(root: ParentNode, formulas: readonly Formula[]): void {
  if (formulas.length === 0) return;
  for (const code of Array.from(root.querySelectorAll('code'))) {
    const index = soleMathMark(code.textContent ?? '');
    const formula = index === null ? undefined : formulas[index];
    if (!formula) continue;
    const markup = typesetFormula(formula);
    if (markup === null) {
      code.textContent = formula.display ? formula.tex : `$${formula.tex}$`;
      continue;
    }
    const block = code.parentElement?.tagName === 'PRE' ? code.parentElement : null;
    (formula.display && block ? block : code).replaceWith(formulaHolder(formula, markup, code.ownerDocument));
  }
}
