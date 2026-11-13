/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — data helpers shared by the 内容 / 排期 / 复盘 / 风格 pages: the live item list
 * (trashed items never appear on these pages), a minute clock that only ticks while a page is
 * visible, per-item metric totals and the drag payload used by the board and the calendar.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { WorkbenchItem, WorkbenchMetric, WorkbenchState } from '@open-design/contracts';
import { workbenchMediaUrl } from '@open-design/contracts';
import { useWorkbench, workbench, type WorkbenchSnapshot } from '../store';
import { displayItem, isLive, posterOf } from '../shared/format';

export interface WorkbenchPageData {
  snap: WorkbenchSnapshot;
  state: WorkbenchState | null;
  /** Every item that is not in the trash. */
  items: WorkbenchItem[];
  /** First load still running (show skeletons). */
  loading: boolean;
  /** First load failed (show a retry state). */
  error: string | null;
}

/** The store snapshot plus the live items; starts the first load when nobody has yet. */
export function useWorkbenchPageData(): WorkbenchPageData {
  const snap = useWorkbench();
  useEffect(() => {
    if (snap.status === 'idle') void workbench.refresh();
  }, [snap.status]);
  const all = snap.state?.items;
  const items = useMemo(() => (all ?? []).filter(isLive), [all]);
  return {
    snap,
    state: snap.state,
    items,
    loading: !snap.state && (snap.status === 'idle' || snap.status === 'loading'),
    error: !snap.state && snap.status === 'error' ? (snap.error ?? '') : null,
  };
}

/** Current time, re-read every `intervalMs` while `active` and once on every activation. */
export function useNow(active: boolean, intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!active) return undefined;
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), intervalMs);
    return () => window.clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}

/** The last non-null value, so a closing dialog keeps its content through the exit motion. */
export function useLastDefined<T>(value: T | null): T | null {
  const last = useRef(value);
  if (value !== null) last.current = value;
  return value ?? last.current;
}

/** Board/calendar items: everything except branch sketches still in the idea state. */
export const isContentItem = (item: WorkbenchItem) => !(item.parentId && item.status === 'idea');

/** Loadable cover URL for an item (generated cover after production, else its own image/poster). */
export function coverUrl(item: WorkbenchItem): string | null {
  return workbenchMediaUrl(posterOf(displayItem(item)));
}

export interface MetricTotals { views: number; engaged: number; likes: number; saves: number; count: number }

export const engagementOf = (m: Pick<WorkbenchMetric, 'likes' | 'comments' | 'shares' | 'saves'>) =>
  (m.likes || 0) + (m.comments || 0) + (m.shares || 0) + (m.saves || 0);

/** Totals per item id. Rows without an item are skipped. */
export function metricsByItem(metrics: WorkbenchMetric[]): Map<string, MetricTotals> {
  const map = new Map<string, MetricTotals>();
  for (const row of metrics) {
    if (!row.itemId) continue;
    const total = map.get(row.itemId) ?? { views: 0, engaged: 0, likes: 0, saves: 0, count: 0 };
    total.views += row.views || 0;
    total.engaged += engagementOf(row);
    total.likes += row.likes || 0;
    total.saves += row.saves || 0;
    total.count += 1;
    map.set(row.itemId, total);
  }
  return map;
}

// ── drag payload ─────────────────────────────────────────────────────────

export const ITEM_DRAG_TYPE = 'application/x-fantay-workbench-item';

export function startItemDrag(event: DragEvent, id: string): void {
  event.dataTransfer.setData(ITEM_DRAG_TYPE, id);
  event.dataTransfer.setData('text/plain', id);
  event.dataTransfer.effectAllowed = 'move';
}

/** True while one of our item cards is being dragged (types are readable during dragover). */
export function dragHasItem(event: DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes(ITEM_DRAG_TYPE);
}

export function readItemDrag(event: DragEvent): string | null {
  return event.dataTransfer.getData(ITEM_DRAG_TYPE) || null;
}

/** Keyboard shortcuts stay out of text fields, menus and open dialogs. */
export function shortcutBlocked(event: KeyboardEvent): boolean {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return true;
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return true;
  if (target.closest('[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"],[role="group"],[role="radiogroup"],[role="tablist"],[role="toolbar"]')) return true;
  return Boolean(document.querySelector('[role="dialog"][data-state="open"],[role="alertdialog"][data-state="open"]'));
}
