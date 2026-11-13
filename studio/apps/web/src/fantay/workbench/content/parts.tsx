/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 内容 — the small facts a content card or row shows: production state, schedule
 * and published numbers.
 * Derived from dsh-media-desk client/content.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { CalendarClock, CircleAlert, CircleCheck, Eye, FileText, Heart } from 'lucide-react';
import type { WorkbenchItem } from '@open-design/contracts';
import { Icon, Spinner, cn } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { compact, fmtTime, relativeDay } from '../shared/format';
import type { MetricTotals } from '../pages-shared/data';
import styles from './ContentPage.module.css';

export type ProductionState = 'running' | 'done' | 'failed' | 'draft' | null;

export function productionState(item: WorkbenchItem): ProductionState {
  const status = item.production?.status;
  if (status === 'running') return 'running';
  if (status === 'done') return 'done';
  if (status === 'failed') return 'failed';
  if (item.drafts?.article || item.drafts?.script) return 'draft';
  return null;
}

export function ProductionBadge({ item, className }: { item: WorkbenchItem; className?: string }) {
  const L = useL();
  const state = productionState(item);
  if (!state) return null;
  const label = {
    running: L('成稿中', 'Producing'),
    done: L('已成稿', 'Produced'),
    failed: L('成稿失败', 'Failed'),
    draft: L('有草稿', 'Has draft'),
  }[state];
  return (
    <span className={cn(styles.badge, className)} data-tone={state}>
      {state === 'running' ? <Spinner size="sm" /> : null}
      {state === 'done' ? <Icon icon={CircleCheck} size={12} /> : null}
      {state === 'failed' ? <Icon icon={CircleAlert} size={12} /> : null}
      {state === 'draft' ? <Icon icon={FileText} size={12} /> : null}
      {label}
    </span>
  );
}

export function ScheduleBadge({ item, now }: { item: WorkbenchItem; now: Date }) {
  const L = useL();
  const lang = useWorkbenchLang();
  if (!item.scheduledAt || item.status === 'published') return null;
  const overdue = new Date(item.scheduledAt).getTime() < now.getTime();
  return (
    <span className={styles.badge} data-tone={overdue ? 'overdue' : 'scheduled'} title={overdue ? L('排期时间已过，还没标为已发布', 'Past its slot and not marked published') : undefined}>
      <Icon icon={CalendarClock} size={12} />
      {relativeDay(item.scheduledAt, lang)} {fmtTime(item.scheduledAt)}
    </span>
  );
}

export function MetricBadge({ totals }: { totals: MetricTotals | undefined }) {
  const L = useL();
  const lang = useWorkbenchLang();
  if (!totals || (!totals.views && !totals.engaged)) return null;
  return totals.views ? (
    <span className={styles.badge} data-tone="metric" title={L(`${totals.views.toLocaleString()} 播放 · ${totals.engaged.toLocaleString()} 互动`, `${totals.views.toLocaleString()} views · ${totals.engaged.toLocaleString()} engagements`)}>
      <Icon icon={Eye} size={12} />
      {compact(totals.views, lang)}
    </span>
  ) : (
    <span className={styles.badge} data-tone="metric" title={L(`${totals.engaged.toLocaleString()} 互动`, `${totals.engaged.toLocaleString()} engagements`)}>
      <Icon icon={Heart} size={12} />
      {compact(totals.engaged, lang)}
    </span>
  );
}
