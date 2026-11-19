// SPDX-License-Identifier: AGPL-3.0-only
// Formulas in a notebook. The engine (KaTeX, loaded on first use, `trust` off) is the shared one in
// `artifact/math/engine.ts`, and the marks that carry a formula through Markdown and the sanitiser
// are in `artifact/math/marked-math.ts`. This file adds a kernel's `text/latex` value. Until the
// engine is there (and whenever it cannot set a formula) the formula stays readable as its source.
import { typesetFormula } from '../../math/engine';

export { loadMathEngine, mathEngineReady, resetMathEngineForTests, typesetFormula, useMathEngine, type Formula } from '../../math/engine';
export { mathMark } from '../../math/find-math';
export { typesetMarkedMath } from '../../math/marked-math';

/**
 * A kernel's `text/latex` value: one formula, usually wrapped in `$…$`, `$$…$$` or `\[…\]`.
 * Returns its markup, or '' when it cannot be typeset (the caller then shows the plain form).
 */
export function typesetLatexOutput(source: string): string {
  const text = source.trim();
  const wrapped = /^\$\$([\s\S]+)\$\$$/.exec(text) ?? /^\\\[([\s\S]+)\\\]$/.exec(text) ?? /^\$([\s\S]+)\$$/.exec(text);
  const tex = (wrapped ? (wrapped[1] ?? '') : text).trim();
  if (tex === '' || tex.includes('$')) return '';
  return typesetFormula({ tex, display: true }) ?? '';
}

