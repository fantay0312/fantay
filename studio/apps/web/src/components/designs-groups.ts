// SPDX-License-Identifier: AGPL-3.0-only
// The 全部项目 gallery's time shelves: pure, so the bucket edges stay testable without a render.
import type { ProjectDisplayStatus } from '../types';

export type DesignTimeBucket = 'today' | 'week' | 'month' | 'earlier';

export const DESIGN_TIME_BUCKETS = ['today', 'week', 'month', 'earlier'] as const satisfies readonly DesignTimeBucket[];

export const DESIGN_BUCKET_LABEL_KEYS = {
  today: 'designs.groupToday',
  week: 'designs.groupWeek',
  month: 'designs.groupMonth',
  earlier: 'designs.groupEarlier',
} as const satisfies Record<DesignTimeBucket, string>;

/** Calendar days from local midnight, so a project touched at 23:59 yesterday is never "today". */
export function designTimeBucket(ts: number, now: number): DesignTimeBucket {
  const today = new Date(now);
  const dayStart = (daysAgo: number) =>
    new Date(today.getFullYear(), today.getMonth(), today.getDate() - daysAgo).getTime();
  if (ts >= dayStart(0)) return 'today';
  if (ts >= dayStart(6)) return 'week';
  if (ts >= dayStart(29)) return 'month';
  return 'earlier';
}

export interface DesignTimeGroup<T> {
  bucket: DesignTimeBucket;
  items: T[];
}

/** Keeps each bucket's incoming order and drops the empty ones. */
export function groupDesignItems<T extends { updatedAt: number }>(
  items: readonly T[],
  now: number,
): DesignTimeGroup<T>[] {
  const buckets = new Map<DesignTimeBucket, T[]>();
  for (const item of items) {
    const bucket = designTimeBucket(item.updatedAt, now);
    const shelf = buckets.get(bucket);
    if (shelf) shelf.push(item);
    else buckets.set(bucket, [item]);
  }
  return DESIGN_TIME_BUCKETS.flatMap((bucket) => {
    const shelf = buckets.get(bucket);
    return shelf ? [{ bucket, items: shelf }] : [];
  });
}

/** A run that has not settled: it is working, or it stopped to ask the owner something. */
export function isActiveDesignStatus(status: ProjectDisplayStatus | undefined): boolean {
  return status === 'running' || status === 'queued' || status === 'awaiting_input';
}
