// fx-governance-allow-raw: a board card is a whole-card drag source with a stretched open target, which no button primitive models
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 内容 — the board: one column per status, cards dragged between columns change
 * the status (`set_status`). The card's "…" menu is the keyboard path for the same moves.
 * Derived from dsh-media-desk client/content.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useState } from 'react';
import { Plus } from 'lucide-react';
import type { WorkbenchItem, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_STATUSES } from '@open-design/contracts';
import { Icon, IconButton, cn } from '../../ui';
import { requestQuickCapture } from '../capture-bus';
import { useL, useWorkbenchLang } from '../lang';
import { displayItem, platformName, statusLabel } from '../shared/format';
import { coverUrl, dragHasItem, readItemDrag, startItemDrag, type MetricTotals } from '../pages-shared/data';
import { ItemCover } from '../pages-shared/ItemCover';
import { ItemMenu, setItemStatus, type ItemActions } from '../pages-shared/ItemMenu';
import page from '../pages-shared/page.module.css';
import { MetricBadge, ProductionBadge, ScheduleBadge } from './parts';
import styles from './ContentPage.module.css';

interface BoardProps {
  items: WorkbenchItem[];
  totals: Map<string, MetricTotals>;
  actions: ItemActions;
  now: Date;
  onCaptureFallback(): void;
}

export function ContentBoard({ items, totals, actions, now, onCaptureFallback }: BoardProps) {
  const L = useL();
  const lang = useWorkbenchLang();
  const [over, setOver] = useState<WorkbenchStatus | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const byId = new Map(items.map((item) => [item.id, item]));

  return (
    <div className={styles.board} role="list" aria-label={L('内容看板', 'Content board')}>
      {WORKBENCH_STATUSES.map((status, columnIndex) => {
        const rows = items.filter((item) => item.status === status);
        return (
          <section
            key={status}
            role="listitem"
            aria-label={statusLabel(status, lang)}
            className={cn(styles.column, page.rise, over === status && styles.columnOver)}
            style={{ animationDelay: `${columnIndex * 40}ms` }}
            onDragOver={(event) => {
              if (!dragHasItem(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'move';
              if (over !== status) setOver(status);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOver((current) => (current === status ? null : current));
            }}
            onDrop={(event) => {
              event.preventDefault();
              setOver(null);
              setDragging(null);
              const id = readItemDrag(event);
              const item = id ? byId.get(id) : undefined;
              if (item) setItemStatus(item, status, L(`移到「${statusLabel(status, 'zh')}」`, `Move to ${statusLabel(status, 'en')}`));
            }}
          >
            <header className={styles.columnHead}>
              <span className={page.statusDot} data-status={status} />
              <h2 className={styles.columnTitle}>{statusLabel(status, lang)}</h2>
              <span className={styles.columnCount}>{rows.length}</span>
              <span className={page.grow} />
              {status === 'idea' ? (
                <IconButton
                  size="xs"
                  aria-label={L('记一条灵感', 'Capture an idea')}
                  onClick={() => {
                    if (!requestQuickCapture({ tab: 'note' })) onCaptureFallback();
                  }}
                >
                  <Icon icon={Plus} />
                </IconButton>
              ) : null}
            </header>
            <div className={styles.columnList}>
              {rows.map((item) => (
                <BoardCard
                  key={item.id}
                  item={item}
                  totals={totals.get(item.id)}
                  actions={actions}
                  now={now}
                  dragging={dragging === item.id}
                  onDragState={setDragging}
                  platformLabel={platformName(item.platform, lang)}
                />
              ))}
              {!rows.length ? <p className={styles.columnEmpty}>{L('拖到这里', 'Drop here')}</p> : null}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({
  item,
  totals,
  actions,
  now,
  dragging,
  onDragState,
  platformLabel,
}: {
  item: WorkbenchItem;
  totals: MetricTotals | undefined;
  actions: ItemActions;
  now: Date;
  dragging: boolean;
  onDragState(id: string | null): void;
  platformLabel: string;
}) {
  const L = useL();
  const shown = displayItem(item);
  const hasCover = Boolean(coverUrl(item));
  return (
    <article
      className={cn(styles.card, dragging && styles.cardDragging)}
      draggable
      onDragStart={(event) => {
        startItemDrag(event, item.id);
        onDragState(item.id);
      }}
      onDragEnd={() => onDragState(null)}
    >
      {hasCover ? <ItemCover item={item} className={styles.cardCover} /> : null}
      <button type="button" className={styles.cardHit} onClick={() => actions.openItem(item.id)} aria-label={L(`打开「${shown.title}」`, `Open “${shown.title}”`)} />
      <strong className={styles.cardTitle}>{shown.title}</strong>
      <div className={styles.cardMeta}>
        {platformLabel ? <span className={styles.cardPlatform}>{platformLabel}</span> : null}
        <ScheduleBadge item={item} now={now} />
        <ProductionBadge item={item} />
        {item.status === 'published' ? <MetricBadge totals={totals} /> : null}
      </div>
      <ItemMenu item={item} actions={actions} className={styles.cardMenu} />
    </article>
  );
}
