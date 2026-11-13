/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — library scopes, filters, search, sort, resurfacing and time groups.
 * Pure functions over the workbench state; no React, no daemon calls.
 */
import type { WorkbenchItem, WorkbenchKind, WorkbenchSpace, WorkbenchSpaceColor, WorkbenchStatus } from '@open-design/contracts';
import type { WorkbenchLang } from '../lang';
import { dayKey, hash, isIdea, isLive, seeded } from '../shared/format';

// ── Navigation ──────────────────────────────────────────────────────

export type LibNav =
  | { kind: 'library' }
  | { kind: 'inbox' }
  | { kind: 'starred' }
  | { kind: 'trash' }
  | { kind: 'tag'; tag: string }
  | { kind: 'space'; id: string };

export const navKey = (nav: LibNav): string =>
  nav.kind === 'tag' ? `tag:${nav.tag}` : nav.kind === 'space' ? `space:${nav.id}` : nav.kind;

export const sameNav = (a: LibNav, b: LibNav) => navKey(a) === navKey(b);

export type ViewMode = 'grid' | 'canvas' | 'feed';
export type SortMode = 'newest' | 'oldest' | 'updated' | 'random';
export type Density = 's' | 'm' | 'l';
export type DateRange = 'all' | 'today' | 'week' | 'month' | 'year' | 'custom';
export type ProductionFilter = 'any' | 'with' | 'without' | 'running';

export interface LibraryFilters {
  kinds: WorkbenchKind[];
  statuses: WorkbenchStatus[];
  production: ProductionFilter;
  range: DateRange;
  /** `yyyy-mm-dd`, custom range only. */
  from: string;
  to: string;
}

export const EMPTY_FILTERS: LibraryFilters = { kinds: [], statuses: [], production: 'any', range: 'all', from: '', to: '' };

export function activeFilterCount(f: LibraryFilters): number {
  return (f.kinds.length ? 1 : 0) + (f.statuses.length ? 1 : 0) + (f.production !== 'any' ? 1 : 0) + (f.range !== 'all' ? 1 : 0);
}

/** Density → minimum masonry column width. */
export const DENSITY_COLUMN: Record<Density, number> = { s: 184, m: 236, l: 320 };

// ── Scopes ──────────────────────────────────────────────────────────

/** Library-visible own ideas (not imported posts, not child notes, not trashed). */
export const inLibrary = (item: WorkbenchItem) => isIdea(item) && isLive(item);
export const inInbox = (item: WorkbenchItem) => inLibrary(item) && !item.triagedAt;

export function scopeItems(items: WorkbenchItem[], nav: LibNav): WorkbenchItem[] {
  switch (nav.kind) {
    case 'library': return items.filter(inLibrary);
    case 'inbox': return items.filter(inInbox);
    case 'starred': return items.filter(item => inLibrary(item) && item.starred);
    case 'tag': return items.filter(item => inLibrary(item) && item.tags.includes(nav.tag));
    case 'space': return items.filter(item => inLibrary(item) && item.spaceId === nav.id);
    case 'trash': return items.filter(item => Boolean(item.trashedAt));
  }
}

export interface LibraryCounts {
  library: number;
  inbox: number;
  starred: number;
  tags: number;
  trash: number;
  spaces: Record<string, number>;
}

export function countLibrary(items: WorkbenchItem[]): LibraryCounts {
  const counts: LibraryCounts = { library: 0, inbox: 0, starred: 0, tags: 0, trash: 0, spaces: {} };
  const tags = new Set<string>();
  for (const item of items) {
    if (item.trashedAt) { counts.trash += 1; continue; }
    if (!isIdea(item)) continue;
    counts.library += 1;
    if (!item.triagedAt) counts.inbox += 1;
    if (item.starred) counts.starred += 1;
    if (item.spaceId) counts.spaces[item.spaceId] = (counts.spaces[item.spaceId] ?? 0) + 1;
    item.tags.forEach(tag => tags.add(tag));
  }
  counts.tags = tags.size;
  return counts;
}

export interface TagStat { tag: string; count: number }

export function tagStats(items: WorkbenchItem[]): TagStat[] {
  const map = new Map<string, number>();
  for (const item of items) {
    if (!inLibrary(item)) continue;
    for (const tag of item.tags) map.set(tag, (map.get(tag) ?? 0) + 1);
  }
  return [...map].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

// ── Filters, search, sort ───────────────────────────────────────────

const DAY = 86400000;

function inRange(iso: string, f: LibraryFilters, now: Date): boolean {
  if (f.range === 'all') return true;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return false;
  switch (f.range) {
    case 'today': return dayKey(at) === dayKey(now);
    case 'week': return at >= now.getTime() - 7 * DAY;
    case 'month': return at >= now.getTime() - 30 * DAY;
    case 'year': return new Date(at).getFullYear() === now.getFullYear();
    case 'custom': {
      const key = dayKey(at);
      if (f.from && key < f.from) return false;
      if (f.to && key > f.to) return false;
      return true;
    }
  }
}

export function applyFilters(items: WorkbenchItem[], f: LibraryFilters, now = new Date()): WorkbenchItem[] {
  if (!activeFilterCount(f)) return items;
  return items.filter((item) => {
    if (f.kinds.length && !f.kinds.includes(item.kind)) return false;
    if (f.statuses.length && !f.statuses.includes(item.status)) return false;
    if (f.production === 'with' && !item.production) return false;
    if (f.production === 'without' && item.production) return false;
    if (f.production === 'running' && item.production?.status !== 'running') return false;
    return inRange(item.createdAt, f, now);
  });
}

/** Everything a text query can match, lower-cased. */
export function searchText(item: WorkbenchItem): string {
  return [
    item.title, item.body, item.tags.join(' '), item.summary, item.keywords?.join(' '), item.ocrText,
    item.source, item.url, item.production?.title, item.reader?.title, item.reader?.siteName,
    item.highlights?.map(h => h.text).join(' '),
  ].filter(Boolean).join('\n').toLowerCase();
}

export function matchesQuery(item: WorkbenchItem, query: string): boolean {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return true;
  const text = searchText(item);
  return tokens.every(token => text.includes(token));
}

export function sortItems(items: WorkbenchItem[], sort: SortMode, seed: number): WorkbenchItem[] {
  const at = (iso: string | null | undefined) => (iso ? Date.parse(iso) || 0 : 0);
  const list = [...items];
  switch (sort) {
    case 'newest': return list.sort((a, b) => at(b.createdAt) - at(a.createdAt) || a.id.localeCompare(b.id));
    case 'oldest': return list.sort((a, b) => at(a.createdAt) - at(b.createdAt) || a.id.localeCompare(b.id));
    case 'updated': return list.sort((a, b) => at(b.updatedAt ?? b.createdAt) - at(a.updatedAt ?? a.createdAt));
    case 'random': return list.sort((a, b) => hash(`${seed}:${a.id}`) - hash(`${seed}:${b.id}`));
  }
}

// ── Resurfacing ─────────────────────────────────────────────────────

/** Weight toward items that have not come back for a while; starred ones a little more. */
function surfaceWeight(item: WorkbenchItem, now: number): number {
  const last = Date.parse(item.lastSurfacedAt ?? '') || Date.parse(item.createdAt) || now;
  const days = Math.max(0, (now - last) / DAY);
  let weight = 1 + Math.min(days, 180) / 6;
  if (item.lastSurfacedAt && days < 2) weight *= 0.08;
  if (item.starred) weight *= 1.4;
  if (item.media) weight *= 1.15;
  return weight;
}

/** Weighted sample without replacement. */
export function resurfaceBatch(items: WorkbenchItem[], n: number, rand: () => number = Math.random, now = Date.now()): WorkbenchItem[] {
  const pool = items.filter(inLibrary).map(item => ({ item, w: surfaceWeight(item, now) }));
  const out: WorkbenchItem[] = [];
  while (out.length < n && pool.length) {
    const total = pool.reduce((sum, row) => sum + row.w, 0);
    let pick = rand() * total;
    let index = 0;
    for (; index < pool.length - 1; index += 1) {
      pick -= pool[index]!.w;
      if (pick <= 0) break;
    }
    out.push(pool[index]!.item);
    pool.splice(index, 1);
  }
  return out;
}

/** Today's three: deterministic for the day, from items older than three days when there are enough. */
export function todaysResurface(items: WorkbenchItem[], now = new Date()): WorkbenchItem[] {
  const live = items.filter(inLibrary);
  const older = live.filter(item => now.getTime() - (Date.parse(item.createdAt) || 0) > 3 * DAY);
  const pool = older.length >= 6 ? older : live;
  if (pool.length < 4) return [];
  return resurfaceBatch(pool, 3, seeded(hash(dayKey(now))), now.getTime());
}

// ── Spaces ──────────────────────────────────────────────────────────

export const SPACE_COLOR_LABEL: Record<WorkbenchSpaceColor, [string, string]> = {
  blue: ['蓝', 'Blue'], olive: ['橄榄', 'Olive'], pink: ['粉', 'Pink'], violet: ['紫', 'Violet'],
  green: ['绿', 'Green'], orange: ['橙', 'Orange'], red: ['红', 'Red'], gray: ['灰', 'Gray'],
};

export function spaceById(spaces: WorkbenchSpace[], id: string | null | undefined): WorkbenchSpace | null {
  if (!id) return null;
  return spaces.find(space => space.id === id) ?? null;
}

// ── Text helpers ────────────────────────────────────────────────────

export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** The site's own favicon (never a third-party favicon service). */
export function faviconOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    if (!/^https?:$/.test(parsed.protocol)) return null;
    return `${parsed.origin}/favicon.ico`;
  } catch {
    return null;
  }
}

export const isUrl = (text: string) => /^https?:\/\/\S+$/i.test(text.trim());

/** First sentence, up to `max` characters (the original desk's title rule). */
export function titleFromText(text: string, max = 60): string {
  const first = text.trim().split(/[。！？\n]|[.!?](?=\s|$)/)[0] ?? '';
  return (first || text.trim()).slice(0, max);
}

/** Minutes to read: CJK ~400 chars/min, Latin ~220 words/min. */
export function estimateMinutes(text: string): number {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  const words = (text.replace(/[一-鿿]/g, ' ').match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
  return Math.max(1, Math.round(cjk / 400 + words / 220));
}

export function readMinutesOf(item: WorkbenchItem): number | null {
  if (item.readMinutes) return item.readMinutes;
  if (item.reader?.text) return estimateMinutes(item.reader.text);
  if (item.kind === 'note' && item.body.length > 280) return estimateMinutes(item.body);
  return null;
}

export function fmtDuration(sec: number | undefined): string | null {
  if (!sec || !Number.isFinite(sec)) return null;
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtBytes(bytes: number | undefined): string {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1).replace(/\.0$/, '')} MB`;
}

// ── Feed time groups ────────────────────────────────────────────────

export function timeGroup(iso: string, lang: WorkbenchLang, now = new Date()): { key: string; label: string } {
  const at = new Date(iso);
  const today = new Date(dayKey(now)).getTime();
  const day = new Date(dayKey(at)).getTime();
  const diff = Math.round((today - day) / DAY);
  const zh = lang === 'zh';
  if (diff <= 0) return { key: 'today', label: zh ? '今天' : 'Today' };
  if (diff === 1) return { key: 'yesterday', label: zh ? '昨天' : 'Yesterday' };
  if (diff < 7) return { key: 'week', label: zh ? '这周早些时候' : 'Earlier this week' };
  if (at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth()) return { key: 'month', label: zh ? '本月' : 'This month' };
  const key = `${at.getFullYear()}-${at.getMonth()}`;
  const label = zh
    ? `${at.getFullYear() === now.getFullYear() ? '' : `${at.getFullYear()}年`}${at.getMonth() + 1}月`
    : at.toLocaleString('en-US', { month: 'long', ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }) });
  return { key, label };
}
