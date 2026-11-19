// SPDX-License-Identifier: AGPL-3.0-only
// One formula in running text that React draws (chat messages, notes). Typeset by the shared engine
// once it is loaded. Until then, and whenever the text is not a formula KaTeX can set, the reader
// sees exactly what was written, delimiters included, as plain text: a false match costs nothing.
'use client';

import { memo } from 'react';

import { typesetFormula, useMathEngine } from './engine';
import styles from './MathView.module.css';

/** Typeset markup by formula, so a message that is drawn again on every streamed word sets each formula once. */
const MAX_REMEMBERED = 600;
const remembered = new Map<string, string | null>();

function typeset(tex: string, display: boolean): string | null {
  const key = `${display ? 'd' : 'i'}\n${tex}`;
  const known = remembered.get(key);
  if (known !== undefined) return known;
  const markup = typesetFormula({ tex, display });
  if (remembered.size >= MAX_REMEMBERED) {
    const oldest = remembered.keys().next().value;
    if (oldest !== undefined) remembered.delete(oldest);
  }
  remembered.set(key, markup);
  return markup;
}

export interface MathViewProps {
  tex: string;
  /** Set on a line of its own. */
  display: boolean;
  /** The text as written, shown when the formula cannot be typeset. */
  written: string;
}

export const MathView = memo(function MathView({ tex, display, written }: MathViewProps): JSX.Element {
  const ready = useMathEngine(true);
  const markup = ready ? typeset(tex, display) : null;
  if (markup === null) {
    return display ? (
      <span className={styles.written} data-math-source="display">
        {written}
      </span>
    ) : (
      <span data-math-source="inline">{written}</span>
    );
  }
  return display ? (
    <span className={styles.display} data-math="display" dangerouslySetInnerHTML={{ __html: markup }} />
  ) : (
    <span className={styles.inline} data-math="inline" dangerouslySetInnerHTML={{ __html: markup }} />
  );
});

/** Test seam. */
export function forgetTypesetMath(): void {
  remembered.clear();
}
