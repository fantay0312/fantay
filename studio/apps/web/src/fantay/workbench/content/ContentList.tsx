// fx-governance-allow-raw: table headers sort in place and a row title opens the item as text, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 内容 — the list: the same items as the board in a sortable table.
 * Derived from dsh-media-desk client/content.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useMemo, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import type { WorkbenchItem } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';
import { Icon, cn } from '../../ui';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, fmtWhen, kindLabel, platformName, relativeDay, statusLabel } from '../shared/format';
import type { MetricTotals } from '../pages-shared/data';
import { ItemCover } from '../pages-shared/ItemCover';
import { ItemMenu, type ItemActions } from '../pages-shared/ItemMenu';
import page from '../pages-shared/page.module.css';
import { MetricBadge, ProductionBadge, productionState } from './parts';
import styles from './ContentPage.module.css';

type SortKey = 'title' | 'status' | 'platform' | 'scheduledAt' | 'production' | 'data' | 'createdAt';
const PRODUCTION_RANK = { running: 3, done: 4, failed: 1, draft: 2 } as const;

interface ListProps {
  items: WorkbenchItem[];
  totals: Map<string, MetricTotals>;
  actions: ItemActions;
  now: Date;
}

export function ContentList({ items, totals, actions, now }: ListProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'createdAt', dir: -1 });

  const columns: Array<{ key: SortKey; label: string; className?: string }> = [
    { key: 'title', label: L('内容', 'Content'), className: styles.colTitle },
    { key: 'status', label: L('状态', 'Status') },
    { key: 'platform', label: L('平台', 'Platform') },
    { key: 'scheduledAt', label: L('排期', 'Scheduled') },
    { key: 'production', label: L('成稿', 'Draft'), className: styles.colOptional },
    { key: 'data', label: L('数据', 'Results'), className: styles.colNum },
    { key: 'createdAt', label: L('记录于', 'Captured'), className: styles.colOptional },
  ];

  const sorted = useMemo(() => {
    const value = (item: WorkbenchItem): string | number => {
      switch (sort.key) {
        case 'title': return displayItem(item).title.toLowerCase();
        case 'status': return WORKBENCH_STATUSES.indexOf(item.status);
        case 'platform': return item.platform ?? '';
        case 'scheduledAt': return item.scheduledAt ?? '';
        case 'production': {
          const state = productionState(item);
          return state ? PRODUCTION_RANK[state] : 0;
        }
        case 'data': {
          const total = totals.get(item.id);
          return total ? total.views || total.engaged : -1;
        }
        default: return item.createdAt;
      }
    };
    return [...items].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      return (x > y ? 1 : x < y ? -1 : 0) * sort.dir;
    });
  }, [items, sort, totals]);

  return (
    <div className={cn(page.tile, page.rise, styles.tableWrap)}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((column) => {
              const on = sort.key === column.key;
              return (
                <th key={column.key} className={column.className} aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'} scope="col">
                  <button
                    type="button"
                    className={styles.sortButton}
                    data-on={on ? '' : undefined}
                    onClick={() => setSort((current) => ({ key: column.key, dir: current.key === column.key ? (current.dir === 1 ? -1 : 1) : column.key === 'title' || column.key === 'platform' ? 1 : -1 }))}
                  >
                    {column.label}
                    {on ? <Icon icon={sort.dir > 0 ? ArrowUp : ArrowDown} size={12} /> : null}
                  </button>
                </th>
              );
            })}
            <th className={styles.colMenu} aria-label={L('操作', 'Actions')} />
          </tr>
        </thead>
        <tbody>
          {sorted.map((item) => {
            const shown = displayItem(item);
            const overdue = item.scheduledAt && item.status !== 'published' && new Date(item.scheduledAt).getTime() < now.getTime();
            return (
              <tr key={item.id} className={styles.row} onClick={() => actions.openItem(item.id)}>
                <td className={styles.colTitle}>
                  <div className={styles.titleCell}>
                    <ItemCover item={item} className={styles.thumb} />
                    <span className={styles.titleText}>
                      <button
                        type="button"
                        className={styles.titleButton}
                        onClick={(event) => {
                          event.stopPropagation();
                          actions.openItem(item.id);
                        }}
                      >
                        {shown.title}
                      </button>
                      <small>
                        {item.parentId ? `${L('分支', 'Branch')} · ` : ''}
                        {item.imported ? `${L('导入', 'Imported')} · ` : ''}
                        {kindLabel(item.kind, lang)}
                        {item.source ? ` · ${item.source}` : ''}
                      </small>
                    </span>
                  </div>
                </td>
                <td>
                  <span className={page.statusPill}>
                    <span className={page.statusDot} data-status={item.status} />
                    {statusLabel(item.status, lang)}
                  </span>
                </td>
                <td className={styles.nowrap}>{item.platform ? platformName(item.platform, lang) : <span className={page.muted}>—</span>}</td>
                <td className={cn(styles.nowrap, overdue && styles.overdue)}>
                  {item.scheduledAt ? fmtWhen(item.scheduledAt, lang) : <span className={page.muted}>—</span>}
                </td>
                <td className={styles.colOptional}>
                  {productionState(item) ? <ProductionBadge item={item} /> : <span className={page.muted}>—</span>}
                </td>
                <td className={styles.colNum}>
                  {totals.get(item.id) ? <MetricBadge totals={totals.get(item.id)} /> : <span className={page.muted}>—</span>}
                </td>
                <td className={cn(styles.nowrap, styles.colOptional, page.muted)}>{relativeDay(item.createdAt, lang)}</td>
                <td className={styles.colMenu} onClick={(event) => event.stopPropagation()}>
                  <ItemMenu item={item} actions={actions} className={styles.rowMenu} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
