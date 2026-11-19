// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useLayoutEffect, useMemo, useRef, type ReactNode } from 'react';
import type { WorkspaceCollabContext } from '@open-design/contracts';

import type { TimelineCopy } from './copy';
import { TimelineCard } from './TimelineEntry';
import { groupTimelineDays, timelineFollowTarget, type TimelineEntry, type TimelineOrder } from './timeline-model';
import styles from './timeline.module.css';

export function TimelineFeed({ entries, order, copy, locale, context, followed, selectedId, onSelect, onToggleFollow }: {
  entries: readonly TimelineEntry[];
  order: TimelineOrder;
  copy: TimelineCopy;
  locale: string;
  context: WorkspaceCollabContext | null;
  followed: ReadonlySet<string>;
  selectedId?: string;
  onSelect(id: string): void;
  onToggleFollow(key: string): void;
}) {
  const progress = order === 'progress';
  const clock = useMemo(() => new Intl.DateTimeFormat(locale, {
    ...(progress ? { dateStyle: 'medium' } : {}),
    timeStyle: 'short',
  }), [locale, progress]);
  const groups = useMemo(() => progress ? [] : groupTimelineDays(entries, locale), [entries, locale, progress]);
  function card(entry: TimelineEntry) {
    const target = timelineFollowTarget(entry).key;
    return <TimelineCard key={entry.id} entry={entry} copy={copy} clock={clock} context={context}
      progress={progress} selected={entry.id === selectedId} followed={followed.has(target)}
      onSelect={() => onSelect(entry.id)} onToggleFollow={() => onToggleFollow(target)} />;
  }
  if (progress) return <ProgressList entries={entries}>{entries.map(card)}</ProgressList>;
  return groups.map(({ day, items }) => (
    <section key={day} className={styles.day}>
      <h2>{day}</h2>
      <ol>{items.map(card)}</ol>
    </section>
  ));
}

function ProgressList({ entries, children }: { entries: readonly TimelineEntry[]; children: ReactNode }) {
  const list = useRef<HTMLOListElement>(null);
  const previous = useRef(new Map<string, { top: number; index: number }>());
  const animations = useRef(new Map<string, Animation>());
  useLayoutEffect(() => {
    const rows = [...list.current?.children ?? []] as HTMLElement[];
    const current = new Map(rows.map((row, index) => [row.dataset.entryId!, { top: row.offsetTop, index }]));
    const prior = previous.current;
    previous.current = current;
    if (!prior.size || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;

    for (const row of rows) {
      const id = row.dataset.entryId!;
      const from = prior.get(id);
      const to = current.get(id)!;
      if (!row.animate) continue;
      const enteredAtTop = !from && to.index === 0 && entries[0]?.completedAt !== undefined;
      if (!enteredAtTop && (!from || from.index === to.index || from.top === to.top)) continue;
      animations.current.get(id)?.cancel();
      const zIndex = !from || from.index > to.index ? 1 : 0;
      const move = row.animate([
        { transform: `translateY(${from ? from.top - to.top : -12}px)`, opacity: enteredAtTop ? 0.7 : 1, zIndex },
        { transform: 'translateY(0)', opacity: 1, zIndex },
      ], { duration: 320, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      animations.current.set(id, move);
      move.onfinish = () => animations.current.delete(id);
    }
  }, [entries]);
  useEffect(() => {
    const running = animations.current;
    return () => {
      for (const animation of running.values()) animation.cancel();
      running.clear();
    };
  }, []);
  return <ol ref={list} className={styles.progressList} data-testid="project-timeline-progress-list">{children}</ol>;
}
