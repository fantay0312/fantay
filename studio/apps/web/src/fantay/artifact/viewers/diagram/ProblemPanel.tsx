// SPDX-License-Identifier: AGPL-3.0-only
// A diagram that does not parse, said in words: which line, what the parser wanted there, and the
// line itself with a caret under the place it stopped, so the reader sees the mistake before
// opening anything. One way out: "查看源码", which opens the source at that line. The look follows
// the frame's own notice (glyph tile, 14px title, 13px description) so it reads as the same state.
'use client';

import { FileWarning } from 'lucide-react';

import { useT } from '../../../../i18n';
import { Button } from '../../../ui';
import styles from '../DiagramViewer.module.css';
import { lineExcerpt, type DiagramProblem } from './problems';

type ParseProblem = Extract<DiagramProblem, { kind: 'syntax' | 'semantic' }>;

export interface ProblemPanelProps {
  problem: ParseProblem;
  onShowSource(line: number | null): void;
}

export function ProblemPanel({ problem, onShowSource }: ProblemPanelProps): JSX.Element {
  const t = useT();
  const { line, column, lineText } = problem;
  const title =
    problem.kind === 'syntax'
      ? line !== null
        ? t('artifact.diagram.error.syntax', { line: String(line) })
        : t('artifact.diagram.error.syntaxNoLine')
      : line !== null
        ? t('artifact.diagram.error.semanticLine', { line: String(line) })
        : t('artifact.diagram.error.semantic');
  const excerpt = line !== null && lineText !== null && lineText.trim() !== '' ? lineExcerpt(lineText, column) : null;

  return (
    <div className={styles.problem} data-artifact-state="notice" data-diagram-problem={problem.kind}>
      <span className={styles.problemGlyph}>
        <FileWarning aria-hidden="true" size={22} strokeWidth={1.5} />
      </span>
      <p className={styles.problemTitle}>{title}</p>
      <p className={styles.problemHint}>{t(problem.hint.key, problem.hint.params)}</p>
      {excerpt && line !== null ? (
        <figure className={styles.excerpt} aria-label={t('artifact.diagram.lineLabel', { line: String(line) })}>
          <span className={styles.excerptGutter} aria-hidden="true">
            {line}
          </span>
          <code className={styles.excerptCode}>{excerpt.text}</code>
          {excerpt.caret !== null ? (
            <>
              <span aria-hidden="true" />
              {/* Padded with the line's own characters, hidden, so the caret lines up under wide
                  (CJK) glyphs as well as narrow ones. */}
              <span className={styles.excerptCaret} aria-hidden="true">
                <span className={styles.excerptPad}>{excerpt.text.slice(0, excerpt.caret)}</span>^
              </span>
            </>
          ) : null}
        </figure>
      ) : null}
      <div className={styles.problemActions}>
        <Button size="sm" variant="primary" onClick={() => onShowSource(line)}>
          {t('artifact.notebook.showSource')}
        </Button>
      </div>
    </div>
  );
}
