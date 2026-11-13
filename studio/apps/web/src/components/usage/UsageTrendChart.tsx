/* SPDX-License-Identifier: AGPL-3.0-only */
/* The range's trend as stacked bars: one bar per hour (a single day) or per day, split by model, provider or project
   in an ink ramp — darkest is the largest series, at the bottom of every stack. Hand-rolled SVG at real pixels. */
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { AiUsageBucket, AiUsageSummary } from '@open-design/contracts';
import { Segmented, SegmentedItem } from '../../fantay/ui';
import {
  count, daySpan, formatAxis, formatDay, formatMetric, formatRange, metricName, metricValue, money, moneyDigits, niceScale, providerLabel, shiftDay,
  shortDay, weekdayName, type UsageMetricKind,
} from './usage-format';
import { useElementWidth } from './useElementWidth';
import styles from './UsageTrendChart.module.css';

export type UsageSplit = 'model' | 'provider' | 'project';

/** Six ink steps; with more series than that the smallest ones fold into 其他. */
const MAX_SERIES = 6;
const OTHER = '\u0000other';
const ALL = '\u0000all';

interface Series {
  key: string;
  label: string;
  total: number;
  shade: number;
}

const pad2 = (value: number) => String(value).padStart(2, '0');
/** Between two phrases of a read-out line; the non-breaking space keeps the dot at the end of a line, never its start. */
const SEP = ' · ';

export type ReadoutSide = 'right' | 'left' | 'over';

/** Where the hovered day's read-out goes in a plot `width` wide: beside the day's column (centred at `columnX`, `gap`
 *  clear of its bar), on the side it prefers when all `tipWidth` of it fits there, else on the other side; when neither
 *  side has room it lies over the plot, centred on the column and held inside both edges. `x` is the read-out's left
 *  edge, or its right edge on the left side. */
export function placeReadout({ columnX, gap, tipWidth, width, preferLeft }: {
  columnX: number;
  gap: number;
  tipWidth: number;
  width: number;
  preferLeft: boolean;
}): { side: ReadoutSide; x: number } {
  const fitsRight = columnX + gap + tipWidth <= width;
  const fitsLeft = columnX - gap - tipWidth >= 0;
  const side: ReadoutSide = preferLeft
    ? (fitsLeft ? 'left' : fitsRight ? 'right' : 'over')
    : (fitsRight ? 'right' : fitsLeft ? 'left' : 'over');
  if (side === 'right') return { side, x: columnX + gap };
  if (side === 'left') return { side, x: columnX - gap };
  const shown = Math.min(tipWidth, width);
  return { side, x: Math.min(Math.max(0, columnX - shown / 2), width - shown) };
}

/** A routed model id (`vendor/route/model`) is told apart by its last segment, so the route sits before it in a
 *  quieter tone and gives way first when the name has to be cut. Other labels come back whole. */
function SeriesName({ label, routed, className }: { label: string; routed: boolean; className?: string }) {
  const at = routed ? label.lastIndexOf('/') : -1;
  return (
    <span className={`${styles.seriesName} ${className ?? ''}`} title={label}>
      {at > 0 && at < label.length - 1 ? <span className={styles.seriesRoute}>{label.slice(0, at + 1)}</span> : null}
      <span className={styles.seriesTail}>{at > 0 && at < label.length - 1 ? label.slice(at + 1) : label}</span>
    </span>
  );
}

function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.min(radius, width / 2, height);
  return `M${x},${y + height}V${y + r}Q${x},${y} ${x + r},${y}H${x + width - r}Q${x + width},${y} ${x + width},${y + r}V${y + height}Z`;
}

export function UsageTrendChart({ data, zh, today, projectNames, allowProjectSplit, compact = false }: {
  data: AiUsageSummary;
  zh: boolean;
  today: string;
  projectNames: Map<string, string>;
  allowProjectSplit: boolean;
  compact?: boolean;
}) {
  const [metricState, setMetric] = useState<UsageMetricKind>('tokens');
  const [splitState, setSplit] = useState<UsageSplit>('model');
  const [active, setActive] = useState<number | null>(null);
  const [focusSeries, setFocusSeries] = useState<string | null>(null);
  const [plotRef, width] = useElementWidth<HTMLDivElement>(compact ? 300 : 600);
  const tipRef = useRef<HTMLDivElement>(null);
  /** The read-out's own width, re-read whenever what it shows changes, so it is placed where all of it fits. */
  const [tipWidth, setTipWidth] = useState(200);
  const metric: UsageMetricKind = compact ? 'tokens' : metricState;
  const split: UsageSplit = splitState === 'project' && !allowProjectSplit ? 'model' : splitState;

  useLayoutEffect(() => {
    const measured = tipRef.current?.offsetWidth ?? 0;
    if (measured > 0) setTipWidth(previous => (previous === measured ? previous : measured));
  }, [active, data, metric, split, width, zh]);

  const model = useMemo(() => {
    const hourly = data.bucket === 'hour';
    const starts = hourly
      ? Array.from({ length: 24 }, (_, hour) => `${data.from}T${pad2(hour)}`)
      : Array.from({ length: daySpan(data.from, data.to) }, (_, index) => shiftDay(data.from, index));
    const byStart = new Map(data.series.map(bucket => [bucket.start, bucket]));
    const buckets = starts.map(start => ({ start, bucket: byStart.get(start) }));

    const labelOf = (key: string) => {
      if (split === 'provider') return providerLabel(key);
      if (split === 'project') return projectNames.get(key) ?? (key ? (zh ? '已归档项目' : 'Archived project') : (zh ? '未绑定项目' : 'No project'));
      return key;
    };
    let series: Series[];
    if (compact) {
      series = [{ key: ALL, label: metricName(metric, zh), total: buckets.reduce((sum, item) => sum + metricValue(item.bucket, metric), 0), shade: 0 }];
    } else {
      const totals = new Map<string, number>();
      for (const bucket of data.series) {
        for (const [key, value] of Object.entries(bucket.groups[split])) totals.set(key, (totals.get(key) ?? 0) + metricValue(value, metric));
      }
      const ranked = [...totals].filter(([, total]) => total > 0).sort((a, b) => b[1] - a[1]);
      const keep = ranked.length > MAX_SERIES ? MAX_SERIES - 1 : ranked.length;
      series = ranked.slice(0, keep).map(([key, total], index) => ({ key, label: labelOf(key), total, shade: index }));
      if (ranked.length > keep) {
        series.push({ key: OTHER, label: zh ? '其他' : 'Other', total: ranked.slice(keep).reduce((sum, [, total]) => sum + total, 0), shade: MAX_SERIES - 1 });
      }
    }

    const stacks = buckets.map(({ bucket }) => {
      const total = metricValue(bucket, metric);
      if (!bucket || total <= 0) return { total, parts: [] as Array<{ key: string; value: number; shade: number }> };
      if (compact) return { total, parts: [{ key: ALL, value: total, shade: 0 }] };
      let rest = total;
      const parts = series.filter(item => item.key !== OTHER).map(item => {
        const value = metricValue(bucket.groups[split][item.key], metric);
        rest -= value;
        return { key: item.key, value, shade: item.shade };
      });
      if (rest > total * 1e-9 && series.some(item => item.key === OTHER)) parts.push({ key: OTHER, value: rest, shade: MAX_SERIES - 1 });
      return { total, parts: parts.filter(part => part.value > 0) };
    });

    const peak = Math.max(0, ...stacks.map(stack => stack.total));
    const scale = niceScale(peak, metric !== 'cost');
    const ticks: number[] = [];
    for (let value = 0; value <= scale.top + scale.step / 2; value += scale.step) ticks.push(value);
    return { hourly, buckets, series, stacks, scale, ticks };
  }, [compact, data, metric, projectNames, split, zh]);

  /* ── Geometry ── */
  const height = compact ? 112 : 208;
  const tickLabels = model.ticks.map(value => formatAxis(value, metric));
  const left = Math.max(28, Math.max(...tickLabels.map(label => label.length)) * 7 + 10);
  const top = 8;
  const bottom = 24;
  const plotWidth = Math.max(1, width - left);
  const plotHeight = height - top - bottom;
  const n = model.buckets.length;
  const slot = plotWidth / n;
  const barWidth = Math.min(28, Math.max(2, slot * (n > 60 ? 0.72 : 0.6)));
  const yOf = (value: number) => top + plotHeight - (value / model.scale.top) * plotHeight;

  const labelEvery = (() => {
    if (model.hourly) return [1, 2, 3, 4, 6, 12].find(step => step * slot >= 44) ?? 12;
    return Math.max(1, Math.ceil((zh ? 64 : 52) / slot));
  })();
  const showLabel = (index: number) => (model.hourly ? index % labelEvery === 0 : (n - 1 - index) % labelEvery === 0);
  const xLabel = (start: string) => (model.hourly ? `${start.slice(11)}:00` : shortDay(start, zh));

  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys: Record<string, (current: number) => number> = {
      ArrowRight: current => Math.min(n - 1, current + 1),
      ArrowLeft: current => Math.max(0, current - 1),
      Home: () => 0,
      End: () => n - 1,
    };
    const next = keys[event.key];
    if (!next) return;
    event.preventDefault();
    setActive(current => next(current ?? n - 1));
  };

  const caption = model.hourly
    ? (zh ? `按小时 · ${formatDay(data.from, zh, today)}` : `Hourly · ${formatDay(data.from, zh, today)}`)
    : (zh ? `按天 · ${formatRange(data.from, data.to, zh, today)}` : `Daily · ${formatRange(data.from, data.to, zh, today)}`);

  const legendDigits = moneyDigits(...model.series.map(item => item.total));
  const activeItem = active === null ? null : model.buckets[active];
  const activeStack = active === null ? null : model.stacks[active];
  // The read-out sits beside the hovered day, clear of its bar: to the right, or to the left once past the middle, on
  // whichever side has room for all of it; only a plot too narrow for either side lays it over the bars.
  const columnX = active === null ? 0 : left + (active + 0.5) * slot;
  const readout = placeReadout({
    columnX,
    gap: Math.max(barWidth, 6) / 2 + 10,
    tipWidth,
    width,
    preferLeft: columnX > left + plotWidth * 0.55,
  });

  const routed = split === 'model';

  return (
    <figure className={styles.chart} data-compact={compact}>
      <div className={styles.head}>
        <div className={styles.titles}>
          <figcaption className={styles.title}>{compact ? (zh ? '每日 Token' : 'Daily tokens') : (zh ? '趋势' : 'Trend')}</figcaption>
          {compact ? null : <p className={styles.caption}>{caption}</p>}
        </div>
        {compact ? null : (
          <div className={styles.controls}>
            <Segmented className={styles.fill} value={metric} onValueChange={value => setMetric(value as UsageMetricKind)} aria-label={zh ? '图表指标' : 'Chart metric'}>
              {(['tokens', 'cost', 'requests'] as const).map(kind => <SegmentedItem key={kind} value={kind}>{metricName(kind, zh)}</SegmentedItem>)}
            </Segmented>
            <Segmented className={styles.fill} value={split} onValueChange={value => setSplit(value as UsageSplit)} aria-label={zh ? '拆分维度' : 'Split by'}>
              <SegmentedItem value="model">{zh ? '按模型' : 'By model'}</SegmentedItem>
              <SegmentedItem value="provider">{zh ? '按来源' : 'By source'}</SegmentedItem>
              {allowProjectSplit ? <SegmentedItem value="project">{zh ? '按项目' : 'By project'}</SegmentedItem> : null}
            </Segmented>
          </div>
        )}
      </div>

      <div className={styles.card}>
        <div
          ref={plotRef}
          className={styles.plot}
          tabIndex={0}
          role="group"
          aria-label={zh ? `${metricName(metric, zh)}柱状图，${caption}。方向键逐个查看。` : `${metricName(metric, zh)} bar chart, ${caption}. Use arrow keys to inspect.`}
          onKeyDown={move}
          onFocus={() => setActive(current => current ?? n - 1)}
          onBlur={() => setActive(null)}
          onPointerLeave={() => setActive(null)}
        >
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
            {model.ticks.map((value, index) => (
              <g key={value}>
                <line className={index === 0 ? styles.baseline : styles.grid} x1={left} x2={width} y1={Math.round(yOf(value)) + 0.5} y2={Math.round(yOf(value)) + 0.5} />
                <text className={styles.axisText} x={left - 8} y={yOf(value)} textAnchor="end" dominantBaseline="middle">{tickLabels[index]}</text>
              </g>
            ))}
            {active !== null ? <rect className={styles.highlight} x={left + active * slot} y={top} width={slot} height={plotHeight} rx={4} /> : null}
            {model.stacks.map((stack, index) => {
              // A day without requests draws nothing: the baseline already says zero. Any real amount gets at least
              // 2px, so a small day is never mistaken for an empty one.
              if (stack.total <= 0) return null;
              const x = left + index * slot + (slot - barWidth) / 2;
              let base = top + plotHeight;
              const totalHeight = Math.max(2, (stack.total / model.scale.top) * plotHeight);
              const unit = totalHeight / stack.total;
              return (
                <g key={index} className={styles.column} data-muted={active !== null && active !== index ? '' : undefined}>
                  {stack.parts.map((part, partIndex) => {
                    const isTop = partIndex === stack.parts.length - 1;
                    const segment = part.value * unit;
                    const y = base - segment;
                    base = y;
                    const dim = focusSeries !== null && focusSeries !== part.key;
                    const drawn = isTop ? segment : Math.max(0, segment - 1);
                    if (drawn <= 0) return null;
                    return isTop ? (
                      <path key={part.key} d={roundedTop(x, y, barWidth, drawn, 3)} className={styles.bar} data-shade={part.shade} data-dim={dim || undefined} />
                    ) : (
                      <rect key={part.key} x={x} y={y + 1} width={barWidth} height={drawn} className={styles.bar} data-shade={part.shade} data-dim={dim || undefined} />
                    );
                  })}
                </g>
              );
            })}
            {model.buckets.map((item, index) => showLabel(index) ? (
              <text key={item.start} className={styles.axisText} x={left + (index + 0.5) * slot} y={height - 6} textAnchor="middle">{xLabel(item.start)}</text>
            ) : null)}
            {model.buckets.map((item, index) => (
              <rect key={`hit-${item.start}`} className={styles.hit} x={left + index * slot} y={0} width={slot} height={height} onPointerEnter={() => setActive(index)} />
            ))}
          </svg>
          {activeItem && activeStack ? (
            <div ref={tipRef} className={styles.tooltip} data-side={readout.side} style={{ left: readout.x }} aria-live="polite">
              <BucketTooltip
                start={activeItem.start}
                bucket={activeItem.bucket}
                stack={activeStack}
                series={model.series}
                metric={metric}
                hourly={model.hourly}
                routed={routed}
                zh={zh}
                today={today}
              />
            </div>
          ) : null}
        </div>

        {!compact && model.series.length ? (
          <ul className={styles.legend} onPointerLeave={() => setFocusSeries(null)}>
            {model.series.map(item => (
              <li key={item.key} onPointerEnter={() => setFocusSeries(item.key)} data-dim={focusSeries !== null && focusSeries !== item.key ? '' : undefined}>
                <span className={styles.swatch} data-shade={item.shade} aria-hidden="true" />
                <SeriesName label={item.label} routed={routed && item.key !== OTHER} className={styles.legendName} />
                <span className={styles.legendValue}>{formatMetric(item.total, metric, legendDigits)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!compact && metric === 'cost' ? (
          <p className={styles.note}>
            {zh
              ? `只计入已知费用（TokenToSea 回执 + 供应方报告）。${data.totals.unknown ? `${count(data.totals.unknown)} 次请求未提供费用，不计为零，也不按价格估算。` : ''}`
              : `Known cost only (TokenToSea receipts + provider reports).${data.totals.unknown ? ` ${count(data.totals.unknown)} requests have no cost; they are not counted as zero or estimated.` : ''}`}
          </p>
        ) : null}
      </div>
    </figure>
  );
}

function BucketTooltip({ start, bucket, stack, series, metric, hourly, routed, zh, today }: {
  start: string;
  bucket: AiUsageBucket | undefined;
  stack: { total: number; parts: Array<{ key: string; value: number; shade: number }> };
  series: Series[];
  metric: UsageMetricKind;
  hourly: boolean;
  routed: boolean;
  zh: boolean;
  today: string;
}) {
  const day = start.slice(0, 10);
  const hour = hourly ? Number(start.slice(11)) : null;
  const title = hour === null
    ? `${formatDay(day, zh, today)} ${weekdayName(day, zh)}`
    : `${formatDay(day, zh, today)} ${pad2(hour)}:00–${pad2((hour + 1) % 24)}:00`;
  const values = new Map(stack.parts.map(part => [part.key, part.value]));
  const rows = series.filter(item => (values.get(item.key) ?? 0) > 0);
  const digits = moneyDigits(stack.total, ...stack.parts.map(part => part.value), bucket?.chargedUsd, bucket?.reportedUsd);
  return (
    <>
      <strong className={styles.tooltipTitle}>{title}</strong>
      {!bucket ? <span className={styles.tooltipEmpty}>{zh ? '没有请求' : 'No requests'}</span> : (
        <>
          {rows.length > 1 || (rows.length === 1 && rows[0]!.label !== metricName(metric, zh)) ? (
            <ul className={styles.tooltipRows}>
              {rows.map(item => (
                <li key={item.key}>
                  <span className={styles.swatch} data-shade={item.shade} aria-hidden="true" />
                  <SeriesName label={item.label} routed={routed && item.key !== OTHER} className={styles.tooltipName} />
                  <span>{formatMetric(values.get(item.key) ?? 0, metric, digits)}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <div className={styles.tooltipTotal}>
            <span>{zh ? '合计' : 'Total'}</span>
            <span>{formatMetric(stack.total, metric, digits)}</span>
          </div>
          <div className={styles.tooltipMeta}>
            {metric === 'cost'
              ? `${zh ? '已扣费' : 'Charged'} ${money(bucket.chargedUsd, digits)}${SEP}${zh ? '报告' : 'Reported'} ${money(bucket.reportedUsd, digits)}${bucket.unknown ? (zh ? `${SEP}${count(bucket.unknown)} 次未提供费用` : `${SEP}${count(bucket.unknown)} without cost`) : ''}`
              : `${count(bucket.requests)} ${zh ? '次请求' : bucket.requests === 1 ? 'request' : 'requests'}`}
            {bucket.failed ? `${SEP}${zh ? `${count(bucket.failed)} 次失败` : `${count(bucket.failed)} failed`}` : ''}
          </div>
        </>
      )}
    </>
  );
}
