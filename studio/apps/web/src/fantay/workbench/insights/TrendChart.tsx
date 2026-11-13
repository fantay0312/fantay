/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — one series over time on one axis: a 2px line over a faint area, a
 * recessive grid, crosshair + tooltip on hover, and ←/→ to walk the days from the keyboard.
 * Derived from dsh-media-desk client/insights.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import { useLayoutEffect, useRef, useState } from 'react';
import type { WorkbenchLang } from '../lang';
import { compact, fmtDate } from '../shared/format';
import styles from './InsightsPage.module.css';

export interface TrendPoint { date: string; value: number; secondary?: number }

export function niceMax(value: number): number {
  if (value <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((n) => n * pow >= value) ?? 10;
  return step * pow;
}

const PAD = { l: 46, r: 14, t: 14, b: 26 };

export function TrendChart({
  points,
  lang,
  label,
  valueText,
  secondaryText,
}: {
  points: TrendPoint[];
  lang: WorkbenchLang;
  /** Accessible summary of the chart. */
  label: string;
  /** Tooltip headline for a value, e.g. "3,200 播放". */
  valueText(value: number): string;
  secondaryText?(value: number): string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 240 });
  const [hover, setHover] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = () => setSize({ width: Math.max(el.clientWidth, 200), height: Math.max(el.clientHeight, 160) });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { width, height } = size;
  const n = points.length;
  const peak = Math.max(0, ...points.map((p) => p.value));
  const max = niceMax(peak);
  const x = (i: number) => PAD.l + (n <= 1 ? 0.5 : i / (n - 1)) * (width - PAD.l - PAD.r);
  const y = (v: number) => PAD.t + (1 - v / max) * (height - PAD.t - PAD.b);
  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ');
  const area = n ? `${line} L${x(n - 1).toFixed(1)} ${y(0)} L${x(0).toFixed(1)} ${y(0)} Z` : '';
  const ticks = [0, 0.5, 1].map((t) => t * max);
  const every = Math.max(1, Math.ceil(n / Math.max(Math.floor((width - PAD.l) / 64), 2)));
  const point = hover === null ? null : points[hover];
  const dayIso = (date: string) => `${date.slice(0, 10)}T12:00:00`;

  const onMove = (clientX: number, rect: DOMRect) => {
    if (!n) return;
    const ratio = (clientX - rect.left - PAD.l) / Math.max(width - PAD.l - PAD.r, 1);
    setHover(Math.max(0, Math.min(n - 1, Math.round(ratio * (n - 1)))));
  };

  return (
    <div className={styles.chart} ref={box}>
      <svg
        width={width}
        height={height}
        role="img"
        aria-label={label}
        tabIndex={0}
        className={styles.chartSvg}
        onPointerMove={(event) => onMove(event.clientX, event.currentTarget.getBoundingClientRect())}
        onPointerLeave={() => setHover(null)}
        onBlur={() => setHover(null)}
        onKeyDown={(event) => {
          if (!n) return;
          if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
            event.preventDefault();
            event.stopPropagation();
            const step = event.key === 'ArrowLeft' ? -1 : 1;
            setHover((current) => Math.max(0, Math.min(n - 1, (current ?? (step > 0 ? -1 : n)) + step)));
          } else if (event.key === 'Escape') {
            setHover(null);
          }
        }}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line x1={PAD.l} x2={width - PAD.r} y1={y(tick)} y2={y(tick)} className={styles.chartGrid} />
            <text x={PAD.l - 8} y={y(tick) + 4} textAnchor="end" className={styles.chartAxis}>
              {compact(tick, lang)}
            </text>
          </g>
        ))}
        {points.map((p, i) => {
          // every Nth day, plus the last day when it is not crowding the previous label
          const lastShown = Math.floor((n - 1) / every) * every;
          const show = i % every === 0 || (i === n - 1 && n - 1 - lastShown >= every / 2);
          return show ? (
            <text key={p.date} x={x(i)} y={height - 7} textAnchor="middle" className={styles.chartAxis}>
              {Number(p.date.slice(5, 7))}/{Number(p.date.slice(8, 10))}
            </text>
          ) : null;
        })}
        {n ? <path d={area} className={styles.chartArea} /> : null}
        {n ? <path key={line.length} d={line} className={styles.chartLine} pathLength={1} /> : null}
        {point && hover !== null ? (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={PAD.t} y2={height - PAD.b} className={styles.chartCross} />
            <circle cx={x(hover)} cy={y(point.value)} r={4.5} className={styles.chartDot} />
          </g>
        ) : null}
      </svg>
      {point && hover !== null ? (
        <div
          className={styles.chartTip}
          style={{ left: Math.max(0, Math.min(x(hover) + 12, width - 160)), top: Math.max(0, y(point.value) - 64) }}
          role="status"
        >
          <small>{fmtDate(dayIso(point.date), lang)}</small>
          <b>{valueText(point.value)}</b>
          {secondaryText && typeof point.secondary === 'number' ? <small>{secondaryText(point.secondary)}</small> : null}
        </div>
      ) : null}
    </div>
  );
}
