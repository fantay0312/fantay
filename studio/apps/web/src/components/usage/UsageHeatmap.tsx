/* SPDX-License-Identifier: AGPL-3.0-only */
/* 53 weeks of daily activity (magpie / Codex), Monday-first columns, in five ink steps rather than a hue. The strip
   above it is Codex's: total, single-day peak, active days and streaks, all from the same series. */
import { useMemo, useState, type KeyboardEvent } from 'react';
import type { AiUsageActivityDay, AiUsageSummary } from '@open-design/contracts';
import { Segmented, SegmentedItem } from '../../fantay/ui';
import {
  count, formatDay, formatMetric, knownCost, metricName, metricValue, moneyDigits, monthName, shiftDay, tokens, weekday, weekdayName,
  type UsageMetricKind,
} from './usage-format';
import { useElementWidth } from './useElementWidth';
import styles from './UsageHeatmap.module.css';

const WEEKS = 53;
const MONTH_ROW = 18;

export function UsageHeatmap({ activity, zh, selectedDay, onSelectDay }: {
  activity: NonNullable<AiUsageSummary['activity']>;
  zh: boolean;
  /** The day the rest of the page shows, when its range is a single day. */
  selectedDay: string | null;
  onSelectDay: (day: string) => void;
}) {
  const [metric, setMetric] = useState<UsageMetricKind>('tokens');
  const [active, setActive] = useState<string | null>(null);
  const [wrapRef, width] = useElementWidth<HTMLDivElement>(600);
  const end = activity.to;

  const model = useMemo(() => {
    const byDay = new Map<string, AiUsageActivityDay>(activity.days.map(day => [day.day, day]));
    const start = shiftDay(end, -(weekday(end) + (WEEKS - 1) * 7));
    const days: string[] = [];
    for (let day = start; day <= end; day = shiftDay(day, 1)) days.push(day);

    const values = days.map(day => metricValue(byDay.get(day), metric)).filter(value => value > 0).sort((a, b) => a - b);
    const quantile = (p: number) => values[Math.floor(p * (values.length - 1))] ?? 0;
    const cuts = [quantile(0.25), quantile(0.5), quantile(0.75)];
    const max = values[values.length - 1] ?? 0;
    const level = (value: number) => {
      if (value <= 0) return 0;
      if (value >= max) return 4;
      return value <= cuts[0]! ? 1 : value <= cuts[1]! ? 2 : value <= cuts[2]! ? 3 : 4;
    };

    let total = 0, peak: { day: string; value: number } | null = null, activeDays = 0, longest = 0, run = 0;
    for (const day of days) {
      const entry = byDay.get(day);
      const value = metricValue(entry, metric);
      total += value;
      if (value > 0 && (!peak || value > peak.value)) peak = { day, value };
      if (entry && entry.requests > 0) {
        activeDays++;
        run++;
        longest = Math.max(longest, run);
      } else run = 0;
    }
    // A streak is still current when today has no request yet but yesterday did.
    let current = 0;
    let cursor = byDay.get(end)?.requests ? end : shiftDay(end, -1);
    while (cursor >= start && (byDay.get(cursor)?.requests ?? 0) > 0) {
      current++;
      cursor = shiftDay(cursor, -1);
    }
    return { byDay, start, days, level, total, peak, activeDays, longest, current };
  }, [activity, end, metric]);

  /* ── Geometry: the cells fill the width, between 6 and 14px ── */
  const labelWidth = zh ? 22 : 30;
  const fit = (gap: number) => Math.floor((width - labelWidth - (WEEKS - 1) * gap) / WEEKS);
  const gap = fit(2) >= 10 ? 3 : 2;
  const cell = Math.max(6, Math.min(14, fit(gap)));
  const pitch = cell + gap;
  const height = MONTH_ROW + 7 * cell + 6 * gap;
  const position = (day: string) => {
    const index = Math.round((Date.parse(`${day}T00:00:00Z`) - Date.parse(`${model.start}T00:00:00Z`)) / 86_400_000);
    return { column: Math.floor(index / 7), row: index % 7 };
  };

  const months: Array<{ column: number; label: string }> = [];
  for (let column = 0; column < WEEKS; column++) {
    const first = shiftDay(model.start, column * 7);
    for (let row = 0; row < 7; row++) {
      const day = shiftDay(first, row);
      if (day.endsWith('-01') && day <= end) {
        const previous = months[months.length - 1];
        if (!previous || column - previous.column >= 3) months.push({ column, label: monthName(day.slice(0, 7), zh) });
      }
    }
  }

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const steps: Record<string, number> = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 };
    if ((event.key === 'Enter' || event.key === ' ') && active) {
      event.preventDefault();
      onSelectDay(active);
      return;
    }
    const step = steps[event.key];
    if (step === undefined) return;
    event.preventDefault();
    setActive(current => {
      const next = shiftDay(current ?? end, step);
      return next < model.start || next > end ? (current ?? end) : next;
    });
  };

  const tip = active ? position(active) : null;
  const tipX = tip ? labelWidth + tip.column * pitch + cell / 2 : 0;
  const tipAlign = tipX < 110 ? 'start' : tipX > width - 110 ? 'end' : 'center';
  const activeEntry = active ? model.byDay.get(active) : undefined;
  const stripDigits = moneyDigits(model.total, model.peak?.value);
  const totalLabel = zh ? `累计${metric === 'tokens' ? ' Token' : metricName(metric, zh)}` : `Total ${metric === 'tokens' ? 'tokens' : metricName(metric, zh).toLowerCase()}`;

  return (
    <section className={styles.section} aria-label={zh ? '活动' : 'Activity'}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <h3 className={styles.title}>{zh ? '活动' : 'Activity'}</h3>
          <p className={styles.caption}>{zh ? '最近 53 周的每日用量，不随上方范围变化' : 'Daily usage over the last 53 weeks, independent of the range above'}</p>
        </div>
        <Segmented size="sm" className={styles.fill} value={metric} onValueChange={value => setMetric(value as UsageMetricKind)} aria-label={zh ? '热力图指标' : 'Heatmap metric'}>
          <SegmentedItem value="tokens">Token</SegmentedItem>
          <SegmentedItem value="requests">{zh ? '请求' : 'Requests'}</SegmentedItem>
          <SegmentedItem value="cost">{zh ? '费用' : 'Cost'}</SegmentedItem>
        </Segmented>
      </div>

      <div className={styles.card}>
        <dl className={styles.strip}>
          <div>
            <dt>{totalLabel}</dt>
            <dd>{metric === 'tokens' ? tokens(model.total) : formatMetric(model.total, metric, stripDigits)}</dd>
          </div>
          <div>
            <dt>{zh ? '单日峰值' : 'Peak day'}</dt>
            <dd>{model.peak ? formatMetric(model.peak.value, metric, stripDigits) : '—'}</dd>
            {model.peak ? <dd className={styles.stripNote}>{formatDay(model.peak.day, zh, end)}</dd> : null}
          </div>
          <div>
            <dt>{zh ? '活跃天数' : 'Active days'}</dt>
            <dd>{zh ? `${count(model.activeDays)} 天` : count(model.activeDays)}</dd>
          </div>
          <div>
            <dt>{zh ? '最长连续' : 'Longest streak'}</dt>
            <dd>{zh ? `${count(model.longest)} 天` : `${count(model.longest)} d`}</dd>
          </div>
          <div>
            <dt>{zh ? '当前连续' : 'Current streak'}</dt>
            <dd>{zh ? `${count(model.current)} 天` : `${count(model.current)} d`}</dd>
          </div>
        </dl>

        <div
          ref={wrapRef}
          className={styles.map}
          tabIndex={0}
          role="group"
          aria-label={zh ? '每日活动热力图。方向键移动，回车查看当天。' : 'Daily activity heatmap. Arrow keys move, Enter shows that day.'}
          onKeyDown={move}
          onFocus={() => setActive(current => current ?? end)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {months.map(month => (
              <text key={month.column} className={styles.label} x={labelWidth + month.column * pitch} y={12}>{month.label}</text>
            ))}
            {[0, 2, 4].map(row => (
              <text key={row} className={styles.label} x={0} y={MONTH_ROW + row * pitch + cell / 2} dominantBaseline="middle">
                {zh ? ['一', '三', '五'][row / 2] : ['Mon', 'Wed', 'Fri'][row / 2]}
              </text>
            ))}
            {model.days.map(day => {
              const { column, row } = position(day);
              const value = metricValue(model.byDay.get(day), metric);
              return (
                <rect
                  key={day}
                  className={styles.cell}
                  data-level={model.level(value)}
                  data-selected={day === selectedDay ? '' : undefined}
                  data-active={day === active ? '' : undefined}
                  x={labelWidth + column * pitch}
                  y={MONTH_ROW + row * pitch}
                  width={cell}
                  height={cell}
                  rx={2}
                  onPointerEnter={() => setActive(day)}
                  onClick={() => onSelectDay(day)}
                />
              );
            })}
          </svg>
          {active && tip ? (
            <div className={styles.tooltip} data-align={tipAlign} style={{ left: tipX, top: MONTH_ROW + tip.row * pitch }} aria-live="polite">
              <strong>{formatDay(active, zh, end)} {weekdayName(active, zh)}</strong>
              <span>
                {activeEntry
                  ? `${tokens(activeEntry.tokens)} Token · ${count(activeEntry.requests)} ${zh ? '次请求' : activeEntry.requests === 1 ? 'request' : 'requests'}`
                  : (zh ? '没有请求' : 'No requests')}
              </span>
              {activeEntry ? <span>{knownCost(activeEntry.costUsd, activeEntry.unknown, activeEntry.requests, zh)}</span> : null}
            </div>
          ) : null}
        </div>

        <div className={styles.foot}>
          <span>{zh ? '点击某一天，查看当天明细' : 'Click a day to inspect it'}</span>
          <span className={styles.scale} aria-hidden="true">
            {zh ? '少' : 'Less'}
            {[0, 1, 2, 3, 4].map(level => <i key={level} data-level={level} />)}
            {zh ? '多' : 'More'}
          </span>
        </div>
      </div>
    </section>
  );
}
