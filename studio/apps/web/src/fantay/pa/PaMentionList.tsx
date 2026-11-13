// SPDX-License-Identifier: AGPL-3.0-only
// The `@` member list (spec §7.3): docked above the composer card, not portaled, so it never fights a modal's
// z-index. The textarea keeps focus (rows swallow mousedown); the composer owns the highlight and the keyboard.
import { useEffect, useRef } from 'react';
import { Users } from 'lucide-react';

import { useT } from '../../i18n';
import { Icon, cn, menuContentClass, menuItemVariants } from '../ui';
import { PaAvatar } from './PaAvatar';
import { usePa } from './pa-context';
import { isFantay } from './pa-model';
import type { PersonalAgent } from './pa-types';
import styles from './PaComposer.module.css';

export const PA_MENTION_LISTBOX_ID = 'pa-mention-listbox';
export const paMentionOptionId = (i: number) => `pa-mention-opt-${i}`;

export interface PaMentionItem {
  key: string;
  /** What replaces `@query`: `@name`, or the literal `@全体` the server matches. */
  token: string;
  agent: PersonalAgent | null;
  caption: string;
}

export interface PaMentionListProps {
  items: PaMentionItem[];
  active: number;
  closing: boolean;
  onPick(item: PaMentionItem): void;
  onActive(index: number): void;
}

export function PaMentionList({ items, active, closing, onPick, onActive }: PaMentionListProps) {
  const t = useT();
  const { index } = usePa();
  const listRef = useRef<HTMLDivElement>(null);
  const pointer = useRef<{ x: number; y: number } | null>(null);

  /* Keep the highlighted row visible without scrolling anything outside the list. */
  useEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>(`#${paMentionOptionId(active)}`);
    if (!list || !row) return;
    if (row.offsetTop < list.scrollTop) list.scrollTop = row.offsetTop - 6;
    else if (row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)
      list.scrollTop = row.offsetTop + row.offsetHeight - list.clientHeight + 6;
  }, [active]);

  return (
    <div
      ref={listRef}
      id={PA_MENTION_LISTBOX_ID}
      role="listbox"
      aria-label={t('pa.composer.mentionList')}
      data-testid="pa-mention-list"
      data-state={closing ? 'closed' : 'open'}
      className={cn(menuContentClass, styles.mentionList)}
    >
      {items.map((item, i) => (
        <div
          key={item.key}
          id={paMentionOptionId(i)}
          role="option"
          aria-selected={i === active}
          data-highlighted={i === active ? '' : undefined}
          className={cn(menuItemVariants(), styles.mentionRow)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item)}
          onPointerMove={(event) => {
            // A row slid under a resting pointer (keyboard scrolling) must not steal the highlight.
            const last = pointer.current;
            pointer.current = { x: event.clientX, y: event.clientY };
            if (last && last.x === event.clientX && last.y === event.clientY) return;
            if (i !== active) onActive(i);
          }}
        >
          <span className={styles.mentionGlyph} aria-hidden>
            {item.agent ? (
              <PaAvatar agent={item.agent} size={16} fantay={isFantay(index, item.agent.id)} />
            ) : (
              <Icon icon={Users} size={16} />
            )}
          </span>
          <span className={styles.mentionToken}>{item.token}</span>
          {item.caption ? <span className={styles.mentionCaption}>{item.caption}</span> : null}
        </div>
      ))}
    </div>
  );
}
