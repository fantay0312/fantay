/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — shared labels, dates, numbers and minimal markdown.
 * Derived from dsh-media-desk client/util.js (https://github.com/woniuniuniu/dsh-media-desk),
 * MIT, Copyright (c) 2026 woniuniuniu. Language is passed explicitly (see ../lang.ts).
 */
import type { WorkbenchItem, WorkbenchKind, WorkbenchPlatform, WorkbenchStatus } from '@open-design/contracts';
import { WORKBENCH_PLATFORMS } from '@open-design/contracts';
import type { WorkbenchLang } from '../lang';

const pick = (lang: WorkbenchLang, zh: string, en: string) => (lang === 'zh' ? zh : en);

export const STATUS_LABEL: Record<WorkbenchStatus, [string, string]> = {
  idea: ['灵感', 'Idea'], outline: ['大纲', 'Outline'], draft: ['草稿', 'Draft'], ready: ['待发布', 'Ready'], published: ['已发布', 'Published'],
};
export const statusLabel = (status: WorkbenchStatus, lang: WorkbenchLang) => pick(lang, ...STATUS_LABEL[status]);

export const KIND_LABEL: Record<WorkbenchKind, [string, string]> = {
  note: ['笔记', 'Note'], quote: ['金句', 'Quote'], web: ['网页', 'Link'], image: ['图片', 'Image'], video: ['视频', 'Video'], pdf: ['PDF', 'PDF'], audio: ['语音', 'Audio'],
};
export const kindLabel = (kind: WorkbenchKind, lang: WorkbenchLang) => pick(lang, ...KIND_LABEL[kind]);

const PLATFORM_EN: Partial<Record<WorkbenchPlatform, string>> = { 公众号: 'WeChat OA', 小红书: 'Xiaohongshu', 抖音: 'Douyin', B站: 'Bilibili', 视频号: 'WeChat Channels' };
export const platformName = (platform: string | null | undefined, lang: WorkbenchLang) =>
  !platform ? '' : lang === 'zh' ? platform : PLATFORM_EN[platform as WorkbenchPlatform] ?? platform;

const OVERSEAS = new Set<string>(['TikTok', 'Instagram', 'YouTube', 'X']);
/** Platform order for pickers: English UI lists the overseas platforms first. */
export function platformChoices(lang: WorkbenchLang): WorkbenchPlatform[] {
  const all = [...WORKBENCH_PLATFORMS];
  return lang === 'en' ? [...all.filter(p => OVERSEAS.has(p)), ...all.filter(p => !OVERSEAS.has(p))] : all;
}

/** Where to publish by hand (the desk never posts for the user). */
export const PLATFORM_URL: Record<WorkbenchPlatform, string> = {
  公众号: 'https://mp.weixin.qq.com/', 小红书: 'https://creator.xiaohongshu.com/publish/publish', 抖音: 'https://creator.douyin.com/creator-micro/content/upload',
  B站: 'https://member.bilibili.com/platform/upload/video/frame', 视频号: 'https://channels.weixin.qq.com/platform/post/create', TikTok: 'https://www.tiktok.com/tiktokstudio/upload',
  Instagram: 'https://www.instagram.com/', YouTube: 'https://studio.youtube.com/', X: 'https://x.com/compose/post',
};

export const STYLE_BOARDS = ['科技数码', '旅行探店', 'Vlog 生活', '观点认知', '干货教程', '种草测评', '情感故事', '热点资讯'] as const;

/** FNV-1a string hash, for stable per-item randomness. */
export function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic PRNG in [0, 1). */
export function seeded(seed: number): () => number {
  let s = seed || 1;
  return () => {
    s = Math.imul(s ^ (s >>> 15), 2246822507);
    s = Math.imul(s ^ (s >>> 13), 3266489909);
    s ^= s >>> 16;
    return (s >>> 0) / 4294967296;
  };
}

export const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Sample a spring into a CSS `linear()` easing usable by CSS and WAAPI. */
export function springEasing(stiffness = 170, damping = 20, mass = 1): { easing: string; duration: number } {
  const w0 = Math.sqrt(stiffness / mass);
  const zeta = damping / (2 * Math.sqrt(stiffness * mass));
  const wd = w0 * Math.sqrt(Math.max(1 - zeta * zeta, 1e-4));
  const at = (t: number) => 1 - Math.exp(-zeta * w0 * t) * (Math.cos(wd * t) + ((zeta * w0) / wd) * Math.sin(wd * t));
  let duration = 0.1;
  while (duration < 4 && (Math.abs(at(duration) - 1) > 0.002 || Math.abs(at(duration + 0.05) - 1) > 0.002)) duration += 0.05;
  const points: number[] = [];
  const N = 36;
  for (let i = 0; i <= N; i += 1) points.push(Number(at((i / N) * duration).toFixed(4)));
  points[N] = 1;
  return { easing: `linear(${points.join(',')})`, duration: Math.round(duration * 1000) };
}
export const SPRING_SOFT = springEasing(120, 16);
export const SPRING_SNAP = springEasing(260, 24);

export const pad = (n: number) => String(n).padStart(2, '0');

export function dayKey(date: string | number | Date): string {
  const d = new Date(date);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function fmtTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function fmtDate(iso: string, lang: WorkbenchLang): string {
  const d = new Date(iso);
  return lang === 'en' ? `${MONTHS_SHORT[d.getMonth()]} ${d.getDate()}` : `${d.getMonth() + 1}月${d.getDate()}日`;
}

export function fmtWhen(iso: string | null | undefined, lang: WorkbenchLang): string {
  if (!iso) return pick(lang, '未排期', 'Not scheduled');
  return `${fmtDate(iso, lang)} ${fmtTime(iso)}`;
}

export function relativeDay(iso: string, lang: WorkbenchLang): string {
  const diff = Math.round((new Date(dayKey(iso)).getTime() - new Date(dayKey(new Date())).getTime()) / 86400000);
  if (diff === 0) return pick(lang, '今天', 'Today');
  if (diff === 1) return pick(lang, '明天', 'Tomorrow');
  if (diff === 2) return pick(lang, '后天', 'In 2 days');
  if (diff === -1) return pick(lang, '昨天', 'Yesterday');
  if (diff < 0 && diff > -8) return lang === 'zh' ? `${-diff}天前` : `${-diff} days ago`;
  return fmtDate(iso, lang);
}

/** `<input type="datetime-local">` value for an ISO time. */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 1.2万 / 12K style counts. */
export function compact(n: number | null | undefined, lang: WorkbenchLang): string {
  if (n === null || n === undefined) return '—';
  if (lang === 'en') {
    const short = (value: number, suffix: string) => `${value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '')}${suffix}`;
    if (n >= 999500) return short(n / 1000000, 'M');
    if (n >= 10000) return short(n / 1000, 'K');
    return n.toLocaleString('en-US');
  }
  if (n >= 10000) return `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万`;
  return n.toLocaleString();
}

/** Own ideas (not imported posts, not child notes); used by the idea wall and streak stamps. */
export const isIdea = (item: WorkbenchItem) => !item.parentId && !item.imported;

/** Library-visible: everything except trashed items. */
export const isLive = (item: WorkbenchItem) => !item.trashedAt;

/** Consecutive capture days; if nothing is captured yet today, count back from yesterday. */
export function computeStreak(items: WorkbenchItem[], now = new Date()): number {
  const days = new Set(items.filter(item => isIdea(item) && isLive(item)).map(item => dayKey(item.createdAt)));
  const cursor = new Date(now);
  if (!days.has(dayKey(cursor))) cursor.setDate(cursor.getDate() - 1);
  let streak = 0;
  while (days.has(dayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }
  return streak;
}

/** After production, cards show the final title and the generated cover. */
export function displayItem(item: WorkbenchItem): WorkbenchItem {
  const production = item.production;
  if (!production?.title || production.status === 'running') return item;
  const src = production.cover?.src;
  return { ...item, title: production.title, ...(src ? { kind: 'image' as const, media: { src, w: 3, h: 2 } } : {}) };
}

/** Still image to show for an item (video poster or image src), or null. */
export function posterOf(item: WorkbenchItem): string | null {
  if (!item.media) return null;
  return item.media.poster || (item.kind === 'video' || item.kind === 'audio' || item.kind === 'pdf' ? null : item.media.src);
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

function inline(text: string): string {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>');
}

/** Minimal markdown for previews: escapes first, so model output HTML never runs. */
export function renderMarkdown(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let i = 0;
  const listRow = /^\s*([-*·]|\d+\.)\s+/;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^\s*$/.test(line)) { i += 1; continue; }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) { out.push(`<h${heading[1]!.length}>${inline(heading[2]!)}</h${heading[1]!.length}>`); i += 1; continue; }
    if (/^>\s?/.test(line)) {
      const quote: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) { quote.push(inline(lines[i]!.replace(/^>\s?/, ''))); i += 1; }
      out.push(`<blockquote>${quote.join('<br>')}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1] ?? '')) {
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map(c => inline(c.trim()));
      const head = cells(line);
      i += 2;
      const body: string[][] = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i]!)) { body.push(cells(lines[i]!)); i += 1; }
      out.push(`<table><thead><tr>${head.map(c => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (listRow.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const rows: string[] = [];
      while (i < lines.length && listRow.test(lines[i]!)) { rows.push(`<li>${inline(lines[i]!.replace(listRow, ''))}</li>`); i += 1; }
      out.push(ordered ? `<ol>${rows.join('')}</ol>` : `<ul>${rows.join('')}</ul>`);
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && !/^\s*$/.test(lines[i]!) && !/^(#{1,4}\s|>|\|)/.test(lines[i]!) && !listRow.test(lines[i]!)) { para.push(inline(lines[i]!)); i += 1; }
    if (para.length) out.push(`<p>${para.join('<br>')}</p>`);
    else { out.push(`<p>${inline(line)}</p>`); i += 1; }
  }
  return out.join('');
}

/** Body length: Chinese counts characters (no whitespace); English counts words, each CJK char as one. */
export function textLength(text: string, lang: WorkbenchLang): number {
  if (lang !== 'en') return text.replace(/\s/g, '').length;
  return (text.match(/[一-鿿]|[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []).length;
}
