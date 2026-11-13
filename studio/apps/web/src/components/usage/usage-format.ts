/* SPDX-License-Identifier: AGPL-3.0-only */
/* Pure helpers shared by the usage dashboard: number and date formatting, range presets, labels and CSV. */
import type { AiUsageMetric, AiUsageRecord } from '@open-design/contracts';
import { agentDisplayName } from '../../utils/agentLabels';

export type UsageMetricKind = 'tokens' | 'cost' | 'requests';
export type RangePreset = 'today' | '7d' | '30d' | 'mtd' | 'last-month' | '90d';
export interface UsageRange {
  preset: RangePreset | 'custom';
  /** Inclusive local day, `YYYY-MM-DD`. */
  from: string;
  to: string;
}

const DAY_MS = 86_400_000;
export const MAX_RANGE_DAYS = 366;

/* ── Numbers ───────────────────────────────────────────────────────────────────────────── */

export type MoneyDigits = 2 | 4;

/** One precision for amounts shown together (a card row, a table, a tooltip): cents when every non-zero amount is a
 *  dollar or more, otherwise four places, so $0.3840 never sits beside $0.6008 or $12.50 beside $0.0012. */
export function moneyDigits(...values: Array<string | number | null | undefined>): MoneyDigits {
  return values.some(value => {
    const amount = Math.abs(Number(value ?? 0));
    return amount > 0 && amount < 1;
  }) ? 4 : 2;
}

/** A fixed number of places; a real amount too small to show is "<$0.0001", never $0.0000. */
export function money(value: string | number, digits: MoneyDigits = moneyDigits(value)): string {
  const amount = Number(value);
  if (amount > 0 && amount < 0.0001) return '<$0.0001';
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(amount);
}

/** Axis money: two decimals under $100, compact above. */
export function axisMoney(value: number): string {
  if (value >= 1000) return `$${new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(value)}`;
  if (value === 0) return '$0';
  return `$${value < 0.01 ? value.toPrecision(1) : value.toFixed(value < 1 ? 2 : value < 100 ? 1 : 0)}`;
}

/** Token counts read one way everywhere: K / M from a thousand up (93.8K beside 118.5K, never 93,793). */
export function tokens(value: number): string {
  return compactNumber(value);
}

export function compactNumber(value: number): string {
  return new Intl.NumberFormat('en-US', { notation: value >= 1_000 ? 'compact' : 'standard', maximumFractionDigits: 1 }).format(value);
}

export function count(value: number): string {
  return value.toLocaleString('en-US');
}

export function percent(ratio: number): string {
  if (!Number.isFinite(ratio)) return '—';
  const value = ratio * 100;
  if (value === 0 || value === 100) return `${value}%`;
  // Never round a share up to a whole 100% (or down to 0%): 99.97% reads as 99.9%.
  if (value > 99) return `${(Math.floor(value * 10) / 10).toFixed(1)}%`;
  if (value < 10) return `${(Math.max(0.1, Math.round(value * 10) / 10)).toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

export function metricValue(metric: AiUsageMetric | undefined, kind: UsageMetricKind): number {
  if (!metric) return 0;
  if (kind === 'tokens') return metric.tokens;
  if (kind === 'requests') return metric.requests;
  return Number(metric.costUsd);
}

export function formatMetric(value: number, kind: UsageMetricKind, digits?: MoneyDigits): string {
  if (kind === 'cost') return money(value, digits);
  if (kind === 'tokens') return tokens(value);
  return count(value);
}

export function formatAxis(value: number, kind: UsageMetricKind): string {
  if (kind === 'cost') return axisMoney(value);
  return compactNumber(value);
}

/** Known cost with the requests that have none named beside it: an unavailable cost is never shown as $0. */
export function knownCost(costUsd: string, unknown: number, requests: number, zh: boolean): string {
  if (requests > 0 && unknown >= requests) return zh ? '费用未提供' : 'Cost not provided';
  if (unknown > 0) return zh ? `${money(costUsd)}（${count(unknown)} 次未提供费用）` : `${money(costUsd)} (${count(unknown)} without cost)`;
  return money(costUsd);
}

export function metricName(kind: UsageMetricKind, zh: boolean): string {
  if (kind === 'tokens') return 'Token';
  if (kind === 'cost') return zh ? '费用' : 'Cost';
  return zh ? '请求' : 'Requests';
}

/** A round axis top and step for `max`, with 3 to 5 intervals. */
export function niceScale(max: number, integer = false): { top: number; step: number } {
  if (!(max > 0)) return integer ? { top: 4, step: 1 } : { top: 1, step: 0.25 };
  const rough = max / 4;
  const power = 10 ** Math.floor(Math.log10(rough));
  let step = [1, 2, 2.5, 5, 10].map(n => n * power).find(n => n >= rough) ?? 10 * power;
  if (integer) step = Math.max(1, Math.ceil(step));
  return { top: Math.ceil(max / step - 1e-9) * step, step };
}

/** `11月2日` / `Nov 2`, never with a year: for axis labels. */
export function shortDay(key: string, zh: boolean): string {
  const month = Number(key.slice(5, 7));
  const day = Number(key.slice(8, 10));
  return zh ? `${month}月${day}日` : `${MONTHS_EN[month - 1]} ${day}`;
}

/* ── Days ──────────────────────────────────────────────────────────────────────────────── */

export function dayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export const todayKey = () => dayKey(new Date());
const dayTime = (key: string) => Date.parse(`${key}T00:00:00Z`);
export const shiftDay = (key: string, amount: number) => new Date(dayTime(key) + amount * DAY_MS).toISOString().slice(0, 10);
export const daySpan = (from: string, to: string) => Math.round((dayTime(to) - dayTime(from)) / DAY_MS) + 1;
/** 0 = Monday … 6 = Sunday. */
export const weekday = (key: string) => (new Date(dayTime(key)).getUTCDay() + 6) % 7;
export const monthOf = (key: string) => key.slice(0, 7);

export function shiftMonth(month: string, amount: number): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  const date = new Date(Date.UTC(year, value - 1 + amount, 1));
  return date.toISOString().slice(0, 7);
}

export function daysInMonth(month: string): number {
  const [year, value] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(year, value, 0)).getUTCDate();
}

const WEEKDAYS_ZH = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const WEEKDAYS_EN = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS_EN = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayName(key: string, zh: boolean): string {
  return (zh ? WEEKDAYS_ZH : WEEKDAYS_EN)[weekday(key)]!;
}

export function monthName(month: string, zh: boolean, withYear = false): string {
  const [year, value] = month.split('-').map(Number) as [number, number];
  if (zh) return withYear ? `${year} 年 ${value} 月` : `${value}月`;
  return withYear ? `${MONTHS_EN[value - 1]} ${year}` : MONTHS_EN[value - 1]!;
}

/** `11月2日` / `Nov 2`; the year is added when it is not the current one. */
export function formatDay(key: string, zh: boolean, today = todayKey()): string {
  const [year, month, day] = key.split('-').map(Number) as [number, number, number];
  const withYear = key.slice(0, 4) !== today.slice(0, 4);
  if (zh) return `${withYear ? `${year}年` : ''}${month}月${day}日`;
  return `${MONTHS_EN[month - 1]} ${day}${withYear ? `, ${year}` : ''}`;
}

export function formatRange(from: string, to: string, zh: boolean, today = todayKey()): string {
  if (from === to) return formatDay(from, zh, today);
  return `${formatDay(from, zh, today)} – ${formatDay(to, zh, today)}`;
}

export function presetRange(preset: RangePreset, today = todayKey()): UsageRange {
  switch (preset) {
    case 'today':
      return { preset, from: today, to: today };
    case '7d':
      return { preset, from: shiftDay(today, -6), to: today };
    case '30d':
      return { preset, from: shiftDay(today, -29), to: today };
    case '90d':
      return { preset, from: shiftDay(today, -89), to: today };
    case 'mtd':
      return { preset, from: `${monthOf(today)}-01`, to: today };
    case 'last-month': {
      const month = shiftMonth(monthOf(today), -1);
      return { preset, from: `${month}-01`, to: `${month}-${String(daysInMonth(month)).padStart(2, '0')}` };
    }
  }
}

export function presetLabel(preset: RangePreset, zh: boolean): string {
  const labels: Record<RangePreset, [string, string]> = {
    today: ['今天', 'Today'],
    '7d': ['7 天', '7d'],
    '30d': ['30 天', '30d'],
    mtd: ['本月', 'This month'],
    'last-month': ['上月', 'Last month'],
    '90d': ['90 天', '90d'],
  };
  return labels[preset][zh ? 0 : 1];
}

/* ── Labels ────────────────────────────────────────────────────────────────────────────── */

export function providerLabel(id: string): string {
  return agentDisplayName(id) ?? id;
}

export function projectLabel(projectId: string | null | undefined, projectName: string | undefined, zh: boolean): string {
  if (projectName) return projectName;
  if (projectId) return zh ? '已归档项目' : 'Archived project';
  return zh ? '未绑定项目' : 'No project';
}

const STATUS_ZH: Record<string, string> = {
  pending: '处理中', prepared: '已就绪', reserved: '已预留', queued: '排队中', running: '执行中', processing: '处理中',
  succeeded: '已完成', completed: '已完成', done: '已完成', finished: '已完成', failed: '失败', canceled: '已取消',
  cancelled: '已取消', expired: '已过期', needs_review: '待核对', unknown: '待对账',
};
const STATUS_EN: Record<string, string> = {
  pending: 'Pending', prepared: 'Prepared', reserved: 'Reserved', queued: 'Queued', running: 'Running', processing: 'Processing',
  succeeded: 'Done', completed: 'Done', done: 'Done', finished: 'Done', failed: 'Failed', canceled: 'Cancelled',
  cancelled: 'Cancelled', expired: 'Expired', needs_review: 'Needs review', unknown: 'Unreconciled',
};

export function statusLabel(status: string, zh: boolean): string {
  return (zh ? STATUS_ZH : STATUS_EN)[status] ?? status;
}

export type StatusTone = 'done' | 'failed' | 'pending' | 'muted';

export function statusTone(status: string): StatusTone {
  if (status === 'failed' || status === 'expired') return 'failed';
  if (['pending', 'prepared', 'reserved', 'queued', 'running', 'processing', 'needs_review'].includes(status)) return 'pending';
  if (['succeeded', 'completed', 'done', 'finished'].includes(status)) return 'done';
  return 'muted';
}

export const isFailed = (record: AiUsageRecord) => statusTone(record.status) === 'failed';

/* ── CSV ───────────────────────────────────────────────────────────────────────────────── */

function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Downloads rows as a UTF-8 CSV (with a BOM so spreadsheet apps read Chinese correctly). */
export function downloadCsv(filename: string, header: string[], rows: Array<Array<string | number | null | undefined>>): void {
  const text = [header, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([`﻿${text}`], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
