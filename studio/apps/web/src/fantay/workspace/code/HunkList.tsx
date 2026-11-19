// SPDX-License-Identifier: AGPL-3.0-only
// The changes view's fallback: when the turn's edits cannot be undone into one "before" text (see
// `reconstructOriginalText`), each edit is shown on its own, in call order, as a small line diff.
import { useMemo } from 'react';

import { useT } from '../../../i18n';
import { diffLines, type DiffLine } from '../surfaces/line-diff';
import type { TurnFileChange, TurnFileHunk } from '../surfaces/surface-types';
import styles from './CodeSurface.module.css';

/** Rows shown per edit; a whole-file write of a long file would otherwise be the file twice over. */
const MAX_HUNK_ROWS = 400;

interface HunkRows {
  rows: DiffLine[];
  /** Rows left out past the cap. */
  more: number;
}

function hunkRows(hunk: TurnFileHunk): HunkRows {
  const all =
    hunk.before === null
      ? // A whole-file write: every line is new. Nothing to diff against.
        hunk.after
          .replace(/\r?\n$/, '')
          .split(/\r?\n/)
          .map((text, index): DiffLine => ({ type: 'add', text, oldLine: null, newLine: index + 1 }))
      : diffLines(hunk.before, hunk.after);
  return all.length > MAX_HUNK_ROWS
    ? { rows: all.slice(0, MAX_HUNK_ROWS), more: all.length - MAX_HUNK_ROWS }
    : { rows: all, more: 0 };
}

const SIGN: Record<DiffLine['type'], string> = { add: '+', remove: '−', context: '' };

export interface HunkListProps {
  change: TurnFileChange;
  wrap: boolean;
}

export function HunkList({ change, wrap }: HunkListProps): JSX.Element {
  const t = useT();
  const hunks = useMemo(() => change.hunks.map(hunkRows), [change.hunks]);
  return (
    <div className={styles.hunks} data-wrap={wrap} tabIndex={0} aria-label={change.path}>
      {hunks.map((hunk, hunkIndex) => (
        // Hunks are an append-only list in call order, so the index is a stable key.
        <div key={hunkIndex} className={styles.hunk}>
          {hunk.rows.map((line, lineIndex) => (
            <div key={lineIndex} className={styles.hunkLine} data-type={line.type}>
              <span className={styles.hunkSign}>{SIGN[line.type]}</span>
              <span className={styles.hunkText}>{line.text}</span>
            </div>
          ))}
          {hunk.more > 0 ? (
            <div className={styles.hunkMore}>{t('workspace.code.moreItems', { count: hunk.more })}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
