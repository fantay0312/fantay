/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 · 灵感 — scatter layout for the infinite canvas. Always computed over every library
 * idea, so filtering and new captures never reshuffle the wall.
 * Derived from dsh-media-desk (https://github.com/woniuniuniu/dsh-media-desk), MIT, Copyright (c) 2026 woniuniuniu
 *   source: client/layout.js
 */
import type { WorkbenchItem } from '@open-design/contracts';
import { displayItem, hash, seeded } from '../shared/format';

/** The centre sentence's footprint; cards are pushed out of it. */
export const HERO = { w: 560, h: 400 };

export interface CardSize { w: number; h: number }

/** Width the canvas draws a card at, plus an estimated height for collision. */
export function cardSize(raw: WorkbenchItem): CardSize {
  const item = displayItem(raw);
  const h = hash(item.id);
  if (item.media && ['image', 'video', 'web'].includes(item.kind)) {
    const width = 176 + (h % 5) * 20;
    const ratio = item.media.h && item.media.w ? Math.min(item.media.h / item.media.w, 1.6) : 0.75;
    return { w: width, h: width * ratio + 70 };
  }
  if (item.kind === 'quote') return { w: 220 + (h % 3) * 20, h: 186 };
  if (item.kind === 'audio') return { w: 232, h: 132 };
  if (item.kind === 'pdf') return { w: 200, h: 236 };
  return { w: 232, h: 186 };
}

export interface ScatterSpot { x: number; y: number; r: number; d: number }

/** Spiral seeding, then iterative overlap pushing. The centre stays clear; hand-placed cards never move. */
export function scatterLayout(items: WorkbenchItem[]): Record<string, ScatterSpot> {
  const ordered = [...items].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || a.id.localeCompare(b.id));
  const rand = seeded(7919);
  const nodes = ordered.map((item, index) => {
    const angle = index * 2.39996 + rand() * 0.5;
    const radius = 220 + 112 * Math.sqrt(index + 1);
    const size = cardSize(item);
    const jitter = (rand() - 0.5) * 7;
    return {
      id: item.id,
      x: item.pos?.x ?? Math.cos(angle) * radius * 1.34,
      y: item.pos?.y ?? Math.sin(angle) * radius * 0.86,
      w: size.w,
      h: size.h,
      fixed: Boolean(item.pos),
      r: item.pos?.r ?? jitter,
    };
  });
  const gap = 20;
  for (let step = 0; step < 240; step += 1) {
    let moved = false;
    for (let i = 0; i < nodes.length; i += 1) {
      const a = nodes[i]!;
      const hx = (a.w + HERO.w) / 2 + gap - Math.abs(a.x);
      const hy = (a.h + HERO.h) / 2 + gap - Math.abs(a.y);
      if (hx > 0 && hy > 0 && !a.fixed) {
        if (hx < hy) a.x += Math.sign(a.x || 1) * hx;
        else a.y += Math.sign(a.y || 1) * hy;
        moved = true;
      }
      for (let j = i + 1; j < nodes.length; j += 1) {
        const b = nodes[j]!;
        if (a.fixed && b.fixed) continue;
        const ox = (a.w + b.w) / 2 + gap - Math.abs(a.x - b.x);
        const oy = (a.h + b.h) / 2 + gap - Math.abs(a.y - b.y);
        if (ox <= 0 || oy <= 0) continue;
        moved = true;
        const horizontal = ox < oy;
        const push = (horizontal ? ox : oy) / 2;
        const dir = horizontal ? Math.sign(a.x - b.x || 1) : Math.sign(a.y - b.y || 1);
        const shareA = b.fixed ? 2 : a.fixed ? 0 : 1;
        const shareB = a.fixed ? 2 : b.fixed ? 0 : 1;
        if (horizontal) {
          a.x += dir * push * shareA;
          b.x -= dir * push * shareB;
        } else {
          a.y += dir * push * shareA;
          b.y -= dir * push * shareB;
        }
      }
    }
    if (!moved) break;
  }
  return Object.fromEntries(nodes.map(n => [n.id, { x: Math.round(n.x), y: Math.round(n.y), r: n.r, d: n.fixed ? 0 : ((hash(n.id) % 13) - 6) / 100 }]));
}
