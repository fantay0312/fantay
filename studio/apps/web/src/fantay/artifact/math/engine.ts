// SPDX-License-Identifier: AGPL-3.0-only
// Typesetting TeX with KaTeX, for every place that shows a formula: notebooks, Markdown documents,
// chat messages and Mermaid labels. The engine is a chunk of its own (`katex.ts`), loaded the first
// time something with a formula is shown; until it is there, and whenever it cannot set a formula,
// the caller keeps the formula readable as its source.
//
// A formula is untrusted input like the text around it. KaTeX runs with `trust` off, so the commands
// that take addresses or write attributes (\href, \url, \includegraphics, \htmlClass, \htmlStyle…)
// are refused, and with bounds on macro expansion and on sizes. What it returns is markup it built
// itself (spans, MathML, layout numbers); it never copies markup out of the input.
import { useEffect, useSyncExternalStore } from 'react';

interface MathEngine {
  renderToString(tex: string, options?: Record<string, unknown>): string;
}

export interface Formula {
  tex: string;
  /** Set on a line of its own (`$$…$$`), not inside the sentence. */
  display: boolean;
}

/** Characters of TeX one formula may have; longer ones stay as their source. */
export const MAX_FORMULA_CHARS = 20_000;

let engine: MathEngine | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function mathEngineReady(): boolean {
  return engine !== null;
}

/** Loads KaTeX once. A chunk that failed to load may be asked for again by the next formula. */
export function loadMathEngine(): Promise<void> {
  loading ??= import('./katex').then(
    (module) => {
      engine = ((module as { default?: MathEngine }).default ?? module) as MathEngine;
      for (const listener of [...listeners]) listener();
    },
    () => {
      loading = null;
    },
  );
  return loading;
}

/** True once formulas can be typeset. Asks for the engine only when `wanted`. */
export function useMathEngine(wanted: boolean): boolean {
  const ready = useSyncExternalStore(subscribe, mathEngineReady, () => false);
  useEffect(() => {
    if (wanted && !ready) void loadMathEngine();
  }, [wanted, ready]);
  return ready;
}

/**
 * One formula as markup, or null when the engine is not loaded or cannot set it. `output` is
 * KaTeX's: with MathML for a page (screen readers read it), `html` alone where the formula is drawn
 * inside a picture.
 */
export function typesetFormula(formula: Formula, output: 'htmlAndMathml' | 'html' = 'htmlAndMathml'): string | null {
  if (engine === null || formula.tex.length > MAX_FORMULA_CHARS) return null;
  try {
    return engine.renderToString(formula.tex, {
      displayMode: formula.display,
      throwOnError: true,
      strict: 'ignore',
      trust: false,
      maxExpand: 1000,
      maxSize: 40,
      output,
    });
  } catch {
    return null;
  }
}

export function resetMathEngineForTests(): void {
  engine = null;
  loading = null;
  listeners.clear();
}
