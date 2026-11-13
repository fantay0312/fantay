'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// Loading, load error and empty board (spec 03 §6.7): the Fantay loader + "Loading board…"; "Couldn't load the board"
// + Retry (04 `store.load()`); for a ready board without nodes a quiet hint — the toolbar is the action surface — under
// a demo of what lands here. A board too short for the demo keeps the glyph.
import { StickyNote } from 'lucide-react';

import { useT } from '../../../i18n';
import { FantayLoader } from '../../brand/FantayLoader';
import { BoardEmptyDemo } from '../../stageshow';
import { Button } from '../../ui/button';
import { useBoardHost, useBoardSelector } from '../context';
import { CHROME_ICON_STROKE } from './icons';
import styles from './chrome.module.css';

export type BoardStatusKind = 'loading' | 'error' | 'empty' | null;

export function BoardStatus() {
  const t = useT();
  const { data } = useBoardHost();
  const kind = useBoardSelector<BoardStatusKind>((state) => {
    if (state.status === 'loading') return 'loading';
    if (state.status === 'error' && state.doc.nodes.size === 0) return 'error';
    if (state.status === 'ready' && state.doc.nodes.size === 0) return 'empty';
    return null;
  });
  if (!kind) return null;
  return (
    <div className={styles.statusLayer} data-testid={`board-status-${kind}`}>
      {kind === 'loading' ? (
        <div className={styles.statusCard} role="status">
          <FantayLoader size={52} label={t('board.loading')} labelClassName={styles.statusBody} decorative />
        </div>
      ) : kind === 'error' ? (
        <div className={styles.statusCard} role="alert" data-interactive="">
          <span className={styles.statusTitle}>{t('board.loadFailed')}</span>
          <Button size="sm" variant="default" data-testid="board-load-retry" onClick={() => void data.store.load()}>
            {t('board.loadRetry')}
          </Button>
        </div>
      ) : (
        <div className={styles.statusCard} data-demo="" data-testid="board-empty">
          <div className={styles.statusDemo}>
            <BoardEmptyDemo />
          </div>
          <span className={styles.statusGlyph} data-demo-fallback="" aria-hidden>
            <StickyNote size={20} strokeWidth={CHROME_ICON_STROKE} />
          </span>
          <span className={styles.statusTitle}>{t('board.empty.title')}</span>
          <span className={styles.statusBody}>{t('board.empty.body')}</span>
        </div>
      )}
    </div>
  );
}
