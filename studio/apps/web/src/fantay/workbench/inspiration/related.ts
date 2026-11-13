/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — related ideas while typing, and similar items for the inspector.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
 *   source: client/related.js — terms, relatedIdeas, relatedLayout. Similar-item ranking adds
 *   tags, AI keywords, dominant colours and space on top of the same term matching.
 */
import type { WorkbenchItem } from '@open-design/contracts';

const STOP_EN = new Set('a an and are as at be but by can do for from how i if in into is it its me my of on or our so that the this to was we what when why with you your'.split(' '));
const STOP_ZH = new Set(['怎么', '什么', '为什么', '一个', '我们', '你们', '他们', '这个', '那个', '如何', '可以', '就是', '不是', '没有', '自己', '还是', '因为', '所以', '但是', '已经', '现在', '真的', '一下', '一些', '的是', '了一']);

export interface Term { term: string; weight: number }

/** Split a sentence into match terms: English words; a CJK run whole plus its adjacent pairs. */
export function terms(text: string): Term[] {
  const out = new Map<string, number>();
  const add = (term: string, weight: number) => { if (!out.has(term) || (out.get(term) ?? 0) < weight) out.set(term, weight); };
  for (const word of text.toLowerCase().match(/[a-z0-9][a-z0-9+#.-]*/g) ?? []) {
    const clean = word.replace(/[.-]+$/, '');
    if (clean.length >= 2 && !STOP_EN.has(clean)) add(clean, 1);
  }
  for (const run of text.match(/[一-鿿]+/g) ?? []) {
    if (run.length >= 2 && run.length <= 6) add(run, 1.5);
    for (let i = 0; i + 2 <= run.length; i += 1) {
      const pair = run.slice(i, i + 2);
      if (!STOP_ZH.has(pair)) add(pair, 0.5);
    }
  }
  return [...out].map(([term, weight]) => ({ term, weight }));
}

function has(haystack: string, term: string): boolean {
  if (!haystack) return false;
  // Latin terms match on a word start, so "ai" does not hit "again".
  if (/^[a-z0-9]/.test(term)) return new RegExp(`(^|[^a-z0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(haystack);
  return haystack.includes(term);
}

interface Fields { title: string; tags: string; body: string }

function fieldsOf(item: WorkbenchItem): Fields {
  return {
    title: `${item.title ?? ''} ${item.production?.title ?? ''}`.toLowerCase(),
    tags: [...item.tags, ...(item.keywords ?? [])].join(' ').toLowerCase(),
    body: `${item.body ?? ''} ${item.summary ?? ''} ${item.ocrText ?? ''} ${item.production?.article ?? ''} ${item.source ?? ''}`.toLowerCase(),
  };
}

function termScore(list: Term[], fields: Fields): { score: number; strong: boolean } {
  let score = 0;
  let strong = false;
  for (const { term, weight } of list) {
    if (has(fields.title, term)) { score += 3 * weight; strong ||= weight >= 1; }
    else if (has(fields.tags, term)) { score += 2 * weight; strong ||= weight >= 1; }
    else if (has(fields.body, term)) { score += weight; strong ||= weight >= 1; }
  }
  return { score, strong };
}

/** Rank ideas against a sentence; returns the best ids, most related first. */
export function relatedIdeas(items: WorkbenchItem[], query: string, limit = 6): string[] {
  const list = terms(query);
  if (!list.length) return [];
  const scored: Array<{ id: string; score: number; at: number }> = [];
  for (const item of items) {
    const { score, strong } = termScore(list, fieldsOf(item));
    // A whole word anywhere counts; stray two-character fragments must add up first.
    if (strong || score >= 3) scored.push({ id: item.id, score, at: Date.parse(item.createdAt) || 0 });
  }
  return scored.sort((a, b) => b.score - a.score || b.at - a.at).slice(0, limit).map(row => row.id);
}

/**
 * Related cards line up in columns left and right of the centre sentence: the most related sit
 * nearest, and a new column opens outward when one is full. Returns each card's centre point.
 */
export function relatedLayout(cards: Array<{ id: string; w: number; h: number }>): Record<string, { x: number; y: number }> {
  const MAX_H = 640;
  const GAP = 20;
  const sides: Record<'-1' | '1', Array<typeof cards>> = { '-1': [[]], '1': [[]] };
  cards.forEach((card, index) => {
    const side = sides[index % 2 === 0 ? '-1' : '1'];
    let column = side[side.length - 1]!;
    const used = column.reduce((sum, c) => sum + c.h + GAP, 0);
    if (column.length && used + card.h > MAX_H) side.push((column = []));
    column.push(card);
  });
  const out: Record<string, { x: number; y: number }> = {};
  for (const sign of [-1, 1] as const) {
    sides[String(sign) as '-1' | '1'].forEach((column, k) => {
      const total = column.reduce((sum, c) => sum + c.h, 0) + GAP * (column.length - 1);
      let y = -total / 2;
      for (const card of column) {
        out[card.id] = { x: sign * (430 + k * 300), y: Math.round(y + card.h / 2) };
        y += card.h + GAP;
      }
    });
  }
  return out;
}

// ── Similar items (inspector) ───────────────────────────────────────

function rgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** "Redmean" colour distance, 0 … ~765. */
export function colorDistance(a: string, b: string): number {
  const x = rgb(a);
  const y = rgb(b);
  if (!x || !y) return 999;
  const r = (x[0] + y[0]) / 2;
  const dr = x[0] - y[0];
  const dg = x[1] - y[1];
  const db = x[2] - y[2];
  return Math.sqrt((2 + r / 256) * dr * dr + 4 * dg * dg + (2 + (255 - r) / 256) * db * db);
}

function paletteCloseness(a: string[] | undefined, b: string[] | undefined): number {
  if (!a?.length || !b?.length) return 0;
  let best = 0;
  for (const x of a.slice(0, 3)) for (const y of b.slice(0, 3)) best = Math.max(best, 1 - colorDistance(x, y) / 160);
  return Math.max(0, best);
}

export interface SimilarHit { id: string; score: number; reasons: Array<'tags' | 'keywords' | 'colors' | 'words' | 'space'> }

/** Items most like `target`: shared tags and keywords, near colours, shared words, same space. */
export function similarItems(target: WorkbenchItem, items: WorkbenchItem[], limit = 6): SimilarHit[] {
  const list = terms(`${target.title} ${target.summary ?? ''} ${target.body.slice(0, 240)}`).filter(t => t.weight >= 1).slice(0, 24);
  const tags = new Set(target.tags.map(tag => tag.toLowerCase()));
  const keywords = new Set((target.keywords ?? []).map(k => k.toLowerCase()));
  const out: SimilarHit[] = [];
  for (const item of items) {
    if (item.id === target.id) continue;
    const reasons: SimilarHit['reasons'] = [];
    let score = 0;
    const sharedTags = item.tags.filter(tag => tags.has(tag.toLowerCase())).length;
    if (sharedTags) { score += 3 * sharedTags; reasons.push('tags'); }
    const sharedKeywords = (item.keywords ?? []).filter(k => keywords.has(k.toLowerCase()) || tags.has(k.toLowerCase())).length;
    if (sharedKeywords) { score += 2 * sharedKeywords; reasons.push('keywords'); }
    const colors = paletteCloseness(target.media?.colors, item.media?.colors);
    if (colors > 0.35) { score += 3 * colors; reasons.push('colors'); }
    if (list.length) {
      const { score: words, strong } = termScore(list, fieldsOf(item));
      if (strong && words >= 3) { score += Math.min(words, 12) / 2; reasons.push('words'); }
    }
    if (target.spaceId && item.spaceId === target.spaceId && score > 0) { score += 0.75; reasons.push('space'); }
    if (score >= 2) out.push({ id: item.id, score, reasons });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
