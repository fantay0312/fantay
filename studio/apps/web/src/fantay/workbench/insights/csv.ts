/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 复盘 — pasted CSV → `add_metric` rows. One row per line:
 * `platform,date,views,likes,comments,shares,saves` (date first also works). Commas, Chinese
 * commas, tabs and semicolons separate; a header line is skipped; counts accept 1.2万 / 3.4k.
 * Derived from dsh-media-desk client/insights.jsx (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu.
 */
import type { WorkbenchOp, WorkbenchPlatform } from '@open-design/contracts';
import { WORKBENCH_PLATFORMS } from '@open-design/contracts';

export interface CsvMetricRow {
  line: number;
  platform: WorkbenchPlatform;
  /** Local noon of the day, ISO. */
  date: string;
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
}

export interface CsvProblem { line: number; text: string; reason: 'platform' | 'date' | 'both' }

export interface CsvResult { rows: CsvMetricRow[]; problems: CsvProblem[] }

const ALIASES: Record<string, WorkbenchPlatform> = {
  公众号: '公众号', 微信公众号: '公众号', wechat: '公众号', 'wechat oa': '公众号', 'wechat official account': '公众号', mp: '公众号',
  小红书: '小红书', xiaohongshu: '小红书', xhs: '小红书', rednote: '小红书', red: '小红书',
  抖音: '抖音', douyin: '抖音',
  b站: 'B站', 哔哩哔哩: 'B站', bilibili: 'B站', bili: 'B站',
  视频号: '视频号', 微信视频号: '视频号', 'wechat channels': '视频号', channels: '视频号',
  tiktok: 'TikTok', instagram: 'Instagram', ig: 'Instagram', youtube: 'YouTube', yt: 'YouTube', x: 'X', twitter: 'X',
};

export function platformOf(value: string): WorkbenchPlatform | null {
  const text = value.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!text) return null;
  const direct = WORKBENCH_PLATFORMS.find((p) => p.toLowerCase() === text);
  return direct ?? ALIASES[text] ?? null;
}

/** A calendar day → ISO at local noon (so the day survives any timezone shift). */
export function dateOf(value: string, now = new Date()): string | null {
  const text = value.trim();
  if (!text) return null;
  let y: number;
  let m: number;
  let d: number;
  let match = /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})日?(?:[ T].*)?$/.exec(text);
  if (match) {
    y = Number(match[1]);
    m = Number(match[2]);
    d = Number(match[3]);
  } else if ((match = /^(\d{1,2})[-/.月](\d{1,2})日?$/.exec(text))) {
    y = now.getFullYear();
    m = Number(match[1]);
    d = Number(match[2]);
  } else {
    return null;
  }
  const date = new Date(y, m - 1, d, 12, 0, 0, 0);
  if (Number.isNaN(date.getTime()) || date.getMonth() !== m - 1 || date.getDate() !== d) return null;
  return date.toISOString();
}

/** 3200 · 3,200 · 1.2万 · 1.2w · 3.4k · 2.1m → integer; anything else → 0. */
export function countOf(value: string | undefined): number {
  const text = String(value ?? '').trim().toLowerCase().replace(/[\s_]/g, '');
  if (!text) return 0;
  const match = /^(-?\d+(?:\.\d+)?)(万|w|k|千|m|百万|亿)?$/.exec(text);
  if (!match) return 0;
  const scale = { 万: 1e4, w: 1e4, k: 1e3, 千: 1e3, m: 1e6, 百万: 1e6, 亿: 1e8 }[match[2] ?? ''] ?? 1;
  return Math.max(0, Math.round(Number(match[1]) * scale));
}

export function parseMetricsCsv(text: string, now = new Date()): CsvResult {
  const rows: CsvMetricRow[] = [];
  const problems: CsvProblem[] = [];
  const lines = text.split(/\r?\n/);
  let seenContent = false;
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const cols = line.split(/[,，\t;；]/).map((c) => c.trim().replace(/^["'“”]|["'“”]$/g, ''));
    const first = !seenContent;
    seenContent = true;
    // A header has no digit in its first two columns ("平台,日期,…" / "date,platform,…").
    if (first && !/\d/.test(`${cols[0] ?? ''}${cols[1] ?? ''}`)) return;
    const a = cols[0] ?? '';
    const b = cols[1] ?? '';
    let platform = platformOf(a);
    let date = dateOf(b, now);
    if (!platform || !date) {
      const swappedPlatform = platformOf(b);
      const swappedDate = dateOf(a, now);
      if (swappedPlatform && swappedDate) {
        platform = swappedPlatform;
        date = swappedDate;
      } else {
        platform = platform ?? swappedPlatform;
        date = date ?? swappedDate;
      }
    }
    if (!platform || !date) {
      problems.push({ line: index + 1, text: line, reason: !platform && !date ? 'both' : !platform ? 'platform' : 'date' });
      return;
    }
    const [views, likes, comments, shares, saves] = cols.slice(2, 7).map(countOf);
    rows.push({ line: index + 1, platform, date, views: views ?? 0, likes: likes ?? 0, comments: comments ?? 0, shares: shares ?? 0, saves: saves ?? 0 });
  });
  return { rows, problems };
}

export function csvRowsToOps(rows: CsvMetricRow[]): WorkbenchOp[] {
  return rows.map((row) => ({
    op: 'add_metric',
    platform: row.platform,
    date: row.date,
    views: row.views,
    likes: row.likes,
    comments: row.comments,
    shares: row.shares,
    saves: row.saves,
  }));
}
