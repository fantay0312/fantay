// SPDX-License-Identifier: AGPL-3.0-only
// Previous, "3 / 12", next: where the reader is in something paged (PDF pages, slides, chapters,
// sheets of a notebook). Drawn like the zoom control next to it, so the bar's two "how I look at it"
// controls match. The count is tabular so the control does not change width while paging.
'use client';

import { ChevronLeft, ChevronRight } from 'lucide-react';

import { useT } from '../../../i18n';
import { Icon, Toolbar, ToolbarControl } from '../../ui';

export interface ArtifactPagerProps {
  /** 1-based. */
  page: number;
  /** 0 while the count is not known yet. */
  count: number;
  onPage(page: number): void;
  /** Accessible name of the group, e.g. "Pages" or "Slides". */
  label: string;
  previousLabel?: string;
  nextLabel?: string;
}

export function ArtifactPager({ page, count, onPage, label, previousLabel, nextLabel }: ArtifactPagerProps): JSX.Element {
  const t = useT();
  const ready = count > 0;
  const current = ready ? Math.min(count, Math.max(1, page)) : 0;
  return (
    <Toolbar aria-label={label} data-artifact-pager="" className="h-7 gap-px rounded-pill p-0.5 shadow-ring">
      <ToolbarControl
        label={previousLabel ?? t('artifact.pager.previous')}
        side="bottom"
        disabled={!ready || current <= 1}
        className="size-6"
        onClick={() => onPage(current - 1)}
      >
        <Icon icon={ChevronLeft} size="sm" />
      </ToolbarControl>
      <span
        className="min-w-12 px-1.5 text-center font-mono text-label font-semibold leading-tight tabular-nums text-ink"
        aria-live="polite"
      >
        {ready ? `${current} / ${count}` : '—'}
      </span>
      <ToolbarControl
        label={nextLabel ?? t('artifact.pager.next')}
        side="bottom"
        disabled={!ready || current >= count}
        className="size-6"
        onClick={() => onPage(current + 1)}
      >
        <Icon icon={ChevronRight} size="sm" />
      </ToolbarControl>
    </Toolbar>
  );
}
