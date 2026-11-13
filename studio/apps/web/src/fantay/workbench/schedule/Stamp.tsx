// fx-governance-allow-raw: a stamp is a perforated picture and the day list rows are cover-and-title rows, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 排期 — 灵感邮票: one perforated stamp per day with captured ideas (the day's
 * picture if any, else its first character); today shows a blank stamp that captures a new idea.
 * Derived from dsh-media-desk client/stamps.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useMemo } from 'react';
import { Plus } from 'lucide-react';
import type { WorkbenchItem } from '@open-design/contracts';
import { Icon, Popover, PopoverContent, PopoverTrigger, cn } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { dayKey, displayItem, fmtTime, isIdea, isLive, kindLabel } from '../shared/format';
import { coverUrl } from '../pages-shared/data';
import { ItemCover } from '../pages-shared/ItemCover';
import styles from './Stamp.module.css';

/** Own ideas by capture day (`YYYY-MM-DD`). */
export function useIdeaDays(items: WorkbenchItem[]): Map<string, WorkbenchItem[]> {
  return useMemo(() => {
    const map = new Map<string, WorkbenchItem[]>();
    for (const item of items) {
      if (!isIdea(item) || !isLive(item)) continue;
      const key = dayKey(item.createdAt);
      const list = map.get(key);
      if (list) list.push(item);
      else map.set(key, [item]);
    }
    for (const list of map.values()) list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return map;
  }, [items]);
}

/** The stamp picture: the first idea of the day that has an image, else the first idea. */
const coverOf = (list: WorkbenchItem[]) => list.find((item) => coverUrl(item)) ?? list[0]!;

export interface StampProps {
  list: WorkbenchItem[] | undefined;
  today: boolean;
  /** Spoken date, e.g. 11月12日. */
  label: string;
  className?: string;
  onOpen(id: string): void;
  onCapture(): void;
}

export function Stamp({ list, today, label, className, onOpen, onCapture }: StampProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  if (!list?.length) {
    if (!today) return null;
    return (
      <button
        type="button"
        className={cn(styles.stamp, styles.blank, className)}
        aria-label={L('今天还没有记录，记一条灵感', 'Nothing captured today — capture an idea')}
        title={L('记一条灵感', 'Capture an idea')}
        onClick={onCapture}
      >
        <Icon icon={Plus} size={12} />
      </button>
    );
  }
  const cover = coverOf(list);
  const face = (
    <>
      <ItemCover item={cover} className={styles.face} />
      {list.length > 1 ? <i className={styles.count}>{list.length}</i> : null}
    </>
  );
  const spoken = L(`${label}的灵感：${displayItem(cover).title}，共 ${list.length} 条`, `Ideas on ${label}: ${displayItem(cover).title}, ${list.length} in total`);
  if (list.length === 1) {
    return (
      <button type="button" className={cn(styles.stamp, className)} aria-label={spoken} title={displayItem(cover).title} onClick={() => onOpen(cover.id)}>
        {face}
      </button>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button type="button" className={cn(styles.stamp, className)} aria-label={spoken}>
          {face}
        </button>
      </PopoverTrigger>
      <PopoverContent width="sm" align="end" className={styles.pop}>
        <p className={styles.popTitle}>{L(`${label} · ${list.length} 条灵感`, `${label} · ${list.length} ideas`)}</p>
        <ul className={styles.popList}>
          {list.map((item) => (
            <li key={item.id}>
              <button type="button" className={styles.popRow} onClick={() => onOpen(item.id)}>
                <ItemCover item={item} className={styles.popThumb} />
                <span className={styles.popText}>
                  <strong>{displayItem(item).title}</strong>
                  <small>
                    {fmtTime(item.createdAt)} · {kindLabel(item.kind, lang)}
                  </small>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
