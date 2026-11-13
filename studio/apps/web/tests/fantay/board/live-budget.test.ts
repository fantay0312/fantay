// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  HOVER_DWELL_MS,
  LIVE_BUDGET,
  nextHoverDwellAt,
  selectLiveIds,
  type LiveCandidate,
} from '../../../src/fantay/board/engine/live-budget';

const stage = { w: 1600, h: 1000 };
const NOW = 100_000;

function candidate(id: string, over: Partial<LiveCandidate> = {}): LiveCandidate {
  return {
    id,
    kind: 'frame',
    screenRect: { x: 100, y: 100, w: 400, h: 300 },
    pinned: false,
    selected: false,
    hoveredSince: null,
    building: false,
    currentlyLive: false,
    eligible: true,
    ...over,
  };
}

const select = (candidates: LiveCandidate[], extra: Partial<Parameters<typeof selectLiveIds>[0]> = {}) =>
  selectLiveIds({ candidates, stage, now: NOW, boardActive: true, ...extra });

describe('selectLiveIds', () => {
  it('grants at most four live slots', () => {
    const many = Array.from({ length: 10 }, (_, index) => candidate(`n${index}`, { screenRect: { x: index * 150, y: 0, w: 200, h: 200 } }));
    expect(LIVE_BUDGET).toBe(4);
    expect(select(many)).toHaveLength(4);
    expect(select(many, { budget: 2 })).toHaveLength(2);
  });

  it('orders by class: pinned < selected < building < hovered (dwell) < others', () => {
    const ids = select([
      candidate('other', { screenRect: { x: 0, y: 0, w: 1600, h: 1000 } }),
      candidate('hovered', { hoveredSince: NOW - HOVER_DWELL_MS }),
      candidate('building', { building: true }),
      candidate('selected', { selected: true }),
      candidate('pinned', { pinned: true }),
    ]);
    expect(ids).toEqual(['pinned', 'selected', 'building', 'hovered']);
  });

  it('hover counts only after the 400 ms dwell (399 no, 400 yes)', () => {
    const big = candidate('big', { screenRect: { x: 0, y: 0, w: 900, h: 900 } });
    const others = ['a', 'b', 'c'].map((id, index) => candidate(id, { screenRect: { x: index * 10, y: 0, w: 800, h: 800 } }));
    const hovered = (since: number) => candidate('hovered', { screenRect: { x: 0, y: 0, w: 200, h: 200 }, hoveredSince: since });
    expect(select([big, ...others, hovered(NOW - 399)])).not.toContain('hovered');
    expect(select([big, ...others, hovered(NOW - 400)])).toContain('hovered');
    expect(nextHoverDwellAt([hovered(NOW - 100)], NOW)).toBe(NOW + 300);
    expect(nextHoverDwellAt([hovered(NOW - 400)], NOW)).toBeNull();
  });

  it('within a class: visible area (with ×1.15 hysteresis for live ones), then distance to the centre, then id', () => {
    const area = select([
      candidate('small', { screenRect: { x: 0, y: 0, w: 300, h: 300 } }),
      candidate('large', { screenRect: { x: 0, y: 0, w: 600, h: 600 } }),
    ], { budget: 1 });
    expect(area).toEqual(['large']);
    // a live node keeps its slot against a newcomer up to 15 % larger
    const sticky = select([
      candidate('live', { screenRect: { x: 0, y: 0, w: 400, h: 400 }, currentlyLive: true }),
      candidate('newcomer', { screenRect: { x: 0, y: 0, w: 420, h: 420 } }),
    ], { budget: 1 });
    expect(sticky).toEqual(['live']);
    const overtaken = select([
      candidate('live', { screenRect: { x: 0, y: 0, w: 400, h: 400 }, currentlyLive: true }),
      candidate('newcomer', { screenRect: { x: 0, y: 0, w: 440, h: 440 } }),
    ], { budget: 1 });
    expect(overtaken).toEqual(['newcomer']);
    const centred = select([
      candidate('edge', { screenRect: { x: 0, y: 0, w: 300, h: 300 } }),
      candidate('centre', { screenRect: { x: 650, y: 350, w: 300, h: 300 } }),
    ], { budget: 1 });
    expect(centred).toEqual(['centre']);
    const byId = select([candidate('b'), candidate('a')], { budget: 1 });
    expect(byId).toEqual(['a']);
  });

  it('drops ineligible, off-stage and too-small candidates — a pinned one overrides the minimum size', () => {
    const ids = select([
      candidate('ineligible', { eligible: false }),
      candidate('offstage', { screenRect: { x: 2000, y: 0, w: 400, h: 300 } }),
      candidate('tiny', { screenRect: { x: 0, y: 0, w: 150, h: 99 } }),
      candidate('tinyPinned', { screenRect: { x: 0, y: 0, w: 150, h: 99 }, pinned: true }),
      candidate('ok'),
    ]);
    expect(ids).toEqual(['tinyPinned', 'ok']);
  });

  it('an inactive board has no live slots', () => {
    expect(select([candidate('a', { pinned: true })], { boardActive: false })).toEqual([]);
  });
});
