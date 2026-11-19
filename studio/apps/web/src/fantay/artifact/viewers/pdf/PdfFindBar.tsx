// SPDX-License-Identifier: AGPL-3.0-only
// The find field: it floats over the top right of the pages, like a browser's, so the bar keeps its
// handful of controls. Enter goes to the next occurrence, Shift+Enter to the previous one, Escape
// closes. The count says where the reader is among the occurrences, in words when there are none.
// It stays mounted while closed, so it can leave as smoothly as it arrives.
'use client';

import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { forwardRef, type KeyboardEvent } from 'react';

import { useT } from '../../../../i18n';
import { IconButton, Input } from '../../../ui';
import styles from '../PdfViewer.module.css';
import type { PdfFind } from './use-pdf-find';

export interface PdfFindBarProps {
  find: PdfFind;
  onClose(): void;
}

export const PdfFindBar = forwardRef<HTMLInputElement, PdfFindBarProps>(function PdfFindBar({ find, onClose }, ref) {
  const t = useT();
  const hasQuery = find.query.trim() !== '';
  const none = hasQuery && !find.searching && find.total === 0;

  let count = '';
  if (hasQuery) {
    if (find.total > 0) count = `${find.ordinal} / ${find.total}`;
    else count = find.searching ? t('artifact.pdf.findSearching') : t('artifact.pdf.findNone');
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      find.step(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div className={styles.find} data-open={find.open ? '' : undefined} data-pdf-find="" role="search" aria-label={t('artifact.pdf.find')}>
      <div className={styles.findRow}>
        <Search className={styles.findIcon} size={14} strokeWidth={1.75} aria-hidden="true" />
        <Input
          ref={ref}
          variant="bare"
          inputSize="auto"
          className={styles.findInput}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={find.query}
          placeholder={t('artifact.pdf.findPlaceholder')}
          aria-label={t('artifact.pdf.find')}
          onChange={(event) => find.setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        {count ? (
          <span className={styles.findCount} data-none={none ? '' : undefined} role="status" aria-live="polite">
            {count}
          </span>
        ) : null}
        <IconButton size="xs" aria-label={t('artifact.pdf.findPrevious')} tooltipSide="bottom" shortcut="shift+enter" disabled={find.total === 0} onClick={() => find.step(-1)}>
          <ChevronUp aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
        <IconButton size="xs" aria-label={t('artifact.pdf.findNext')} tooltipSide="bottom" shortcut="enter" disabled={find.total === 0} onClick={() => find.step(1)}>
          <ChevronDown aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
        <IconButton size="xs" aria-label={t('common.close')} tooltipSide="bottom" shortcut="escape" onClick={onClose}>
          <X aria-hidden="true" strokeWidth={1.75} />
        </IconButton>
      </div>
      {find.searchedPages !== null && hasQuery ? <p className={styles.findNote}>{t('artifact.pdf.findPartial', { pages: find.searchedPages })}</p> : null}
    </div>
  );
});
