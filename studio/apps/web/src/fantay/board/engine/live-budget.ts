// SPDX-License-Identifier: AGPL-3.0-only
// Live budget (spec 03 §3.5, plan R6): at most four frame/web/motion iframes and mounted <video> elements are
// live at once, extension bodies included. Everything else shows its cover. Pure: the engine runtime feeds it the
// visible live-capable nodes on settle and on selection/hover/mode/active/doc/building changes, never mid-gesture.
import { intersectionArea } from '../model/geometry';
import type { Rect, Size } from '../model/types';

export const LIVE_BUDGET = 4;
export const LIVE_MIN_SCREEN = { w: 160, h: 100 } as const;
export const HOVER_DWELL_MS = 400;
export const INACTIVE_DEMOTE_MS = 5_000;
/** a node that is already live keeps its slot against a slightly larger newcomer */
export const LIVE_HYSTERESIS = 1.15;

export type LiveKind = 'frame' | 'web' | 'motion' | 'video';

export interface LiveCandidate {
  id: string;
  kind: LiveKind;
  /** node rect in stage px */
  screenRect: Rect;
  /** mode node (navigate/edit/capture), media currently playing, or a body that asked to stay live */
  pinned: boolean;
  selected: boolean;
  hoveredSince: number | null;
  building: boolean;
  currentlyLive: boolean;
  /** false for: missing file, LOD, frame > 2 MB in edit, viewerOnly-blocked, no source */
  eligible: boolean;
}

export interface SelectLiveInput {
  candidates: readonly LiveCandidate[];
  stage: Size;
  now: number;
  boardActive: boolean;
  budget?: number;
}

/** 0 pinned < 1 selected < 2 building < 3 hovered ≥ 400 ms < 4 others */
export function liveClass(candidate: LiveCandidate, now: number): number {
  if (candidate.pinned) return 0;
  if (candidate.selected) return 1;
  if (candidate.building) return 2;
  if (candidate.hoveredSince !== null && now - candidate.hoveredSince >= HOVER_DWELL_MS) return 3;
  return 4;
}

/** Ids granted a live slot, best first (spec 03 §3.5 rules 1–5). */
export function selectLiveIds(input: SelectLiveInput): string[] {
  if (!input.boardActive) return [];
  const budget = Math.max(0, input.budget ?? LIVE_BUDGET);
  if (budget === 0) return [];
  const stageRect: Rect = { x: 0, y: 0, w: input.stage.w, h: input.stage.h };
  const cx = input.stage.w / 2;
  const cy = input.stage.h / 2;
  const ranked: Array<{ id: string; rank: number; area: number; distance: number }> = [];
  for (const candidate of input.candidates) {
    if (!candidate.eligible) continue;
    const visibleArea = intersectionArea(candidate.screenRect, stageRect);
    if (visibleArea <= 0) continue;
    const stageScale = Math.min(1, input.stage.w / 1600, input.stage.h / 1000);
    const tooSmall =
      candidate.screenRect.w < LIVE_MIN_SCREEN.w * stageScale ||
      candidate.screenRect.h < LIVE_MIN_SCREEN.h * stageScale;
    if (tooSmall && !candidate.pinned) continue;
    const r = candidate.screenRect;
    ranked.push({
      id: candidate.id,
      rank: liveClass(candidate, input.now),
      area: visibleArea * (candidate.currentlyLive ? LIVE_HYSTERESIS : 1),
      distance: Math.hypot(r.x + r.w / 2 - cx, r.y + r.h / 2 - cy),
    });
  }
  ranked.sort((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.area !== b.area) return b.area - a.area;
    if (a.distance !== b.distance) return a.distance - b.distance;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return ranked.slice(0, budget).map((entry) => entry.id);
}

/** Earliest future time at which a hovered candidate crosses the dwell threshold (null when none will). */
export function nextHoverDwellAt(candidates: readonly LiveCandidate[], now: number): number | null {
  let next: number | null = null;
  for (const candidate of candidates) {
    if (candidate.hoveredSince === null || !candidate.eligible) continue;
    const at = candidate.hoveredSince + HOVER_DWELL_MS;
    if (at > now && (next === null || at < next)) next = at;
  }
  return next;
}
