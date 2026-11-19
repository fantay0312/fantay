// SPDX-License-Identifier: AGPL-3.0-only
import { useState } from 'react';
import { ListTree } from 'lucide-react';

import { useI18n } from '../../../../i18n';
import { DashNavItem } from '../../../shell/sidebar/dash';
import { cn } from '../../../ui/cn';
import { TIMELINE_COPY } from './copy';
import type { TimelineNote } from './timeline-model';

const SIDEBAR_UPDATE_LIMIT = 6;

export function TimelineSidebarRows({ notes, activeId, nested, onOpen }: {
  notes: readonly TimelineNote[];
  activeId?: string;
  nested: boolean;
  onOpen(noteId: string): void;
}) {
  const { locale } = useI18n();
  const copy = TIMELINE_COPY[locale.startsWith('zh') ? 'zh' : 'en'];
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? notes : notes.slice(0, SIDEBAR_UPDATE_LIMIT);
  return (
    <ul className="m-0 list-none p-0" aria-label={nested ? copy.note : copy.recent}>
      {visible.map(note => (
        <li key={note.id}>
          <DashNavItem
            data-sidebar-row=""
            data-testid="fantay-sidebar-timeline-note"
            data-note-id={note.id}
            active={activeId === note.id}
            icon={<ListTree aria-hidden className="size-3.5 text-info-ink" />}
            className={cn('h-7 text-label font-normal', nested && 'ps-[23px]')}
            title={note.text}
            onClick={() => onOpen(note.id)}
          >
            {note.text}
          </DashNavItem>
        </li>
      ))}
      {!showAll && notes.length > SIDEBAR_UPDATE_LIMIT ? <li>
        <DashNavItem className={cn('h-7 text-label font-normal text-ink-soft', nested ? 'ps-[43px]' : 'ps-[36px]')}
          onClick={() => setShowAll(true)}>{copy.more}</DashNavItem>
      </li> : null}
    </ul>
  );
}
