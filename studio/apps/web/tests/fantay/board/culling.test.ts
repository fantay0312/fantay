// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  computeVisibleIds,
  cullBounds,
  edgeInView,
  isLod,
  LOD_MIN_SCREEN_PX,
  OVERSCAN_WORLD_MIN,
  overscanWorld,
  sameIdList,
} from '../../../src/fantay/board/engine/culling';
import { nodesInOrder, toEngineDoc } from '../../../src/fantay/board/model/contract-adapter';
import { frameDraft, groupDraft, makeBoard, noteDraft, PROJECT_ID } from './engine-fixtures';

const stage = { w: 1000, h: 800 };

function docOf(drafts: Parameters<typeof makeBoard>[0]) {
  return toEngineDoc(makeBoard(drafts), PROJECT_ID);
}

describe('culling', () => {
  it('overscan = max(280, 0.25 × max(stage) / zoom)', () => {
    expect(overscanWorld({ x: 0, y: 0, zoom: 1 }, stage)).toBe(OVERSCAN_WORLD_MIN);
    expect(overscanWorld({ x: 0, y: 0, zoom: 0.5 }, stage)).toBe(500);
    expect(overscanWorld({ x: 0, y: 0, zoom: 0.1 }, stage)).toBe(2500);
    expect(cullBounds({ x: 0, y: 0, zoom: 1 }, stage)).toEqual({ x: -280, y: -280, w: 1560, h: 1360 });
  });

  it('keeps nodes inside the view plus overscan, drops the rest, in paint order', () => {
    const doc = docOf([
      noteDraft('n_inside', 100, 100),
      noteDraft('n_overscan', 1100, 100), // right of the stage, within 280 px
      noteDraft('n_far', 5000, 5000),
      noteDraft('n_left', -500, 0), // ends at -220: inside the overscan
    ]);
    const ids = computeVisibleIds({ nodesInOrder: nodesInOrder(doc), cam: { x: 0, y: 0, zoom: 1 }, stage });
    expect(ids).toEqual(['n_inside', 'n_overscan', 'n_left']);
  });

  it('never renders hidden nodes; always-included ids stay (selection, live, preview)', () => {
    const doc = docOf([
      { ...noteDraft('n_hidden', 100, 100), hidden: true } as Parameters<typeof makeBoard>[0][number],
      noteDraft('n_far', 9000, 9000),
    ]);
    const ids = computeVisibleIds({
      nodesInOrder: nodesInOrder(doc),
      cam: { x: 0, y: 0, zoom: 1 },
      stage,
      alwaysInclude: new Set(['n_far', 'n_hidden']),
    });
    expect(ids).toEqual(['n_far']);
  });

  it('tests a dragged node at its preview rect', () => {
    const doc = docOf([noteDraft('n_dragged', 9000, 9000)]);
    const ids = computeVisibleIds({
      nodesInOrder: nodesInOrder(doc),
      cam: { x: 0, y: 0, zoom: 1 },
      stage,
      previewRects: new Map([['n_dragged', { x: 10, y: 10, w: 280, h: 220 }]]),
    });
    expect(ids).toEqual(['n_dragged']);
  });

  it('a group is visible on its own rect; its children are tested independently', () => {
    const doc = docOf([
      groupDraft('n_group', 0, 0, 6000, 400),
      { ...noteDraft('n_child_far', 5500, 50), parentId: 'n_group' } as Parameters<typeof makeBoard>[0][number],
      { ...noteDraft('n_child_near', 50, 50), parentId: 'n_group' } as Parameters<typeof makeBoard>[0][number],
    ]);
    const ids = computeVisibleIds({ nodesInOrder: nodesInOrder(doc), cam: { x: 0, y: 0, zoom: 1 }, stage });
    expect(ids).toEqual(['n_group', 'n_child_near']);
  });

  it('edgeInView uses the bezier hull (endpoints widened by the curvature)', () => {
    const bounds = { x: 0, y: 0, w: 1000, h: 800 };
    expect(edgeInView({ x: 100, y: 100, w: 100, h: 100 }, { x: 400, y: 100, w: 100, h: 100 }, bounds)).toBe(true);
    // both endpoints left of the view, but the curve bulges in: start + curvature (min 50) crosses x = 0
    expect(edgeInView({ x: -130, y: 100, w: 100, h: 100 }, { x: -20, y: 100, w: 100, h: 100 }, bounds)).toBe(true);
    expect(edgeInView({ x: -2000, y: 100, w: 100, h: 100 }, { x: -1500, y: 100, w: 100, h: 100 }, bounds)).toBe(false);
    expect(edgeInView({ x: 100, y: 2000, w: 100, h: 100 }, { x: 400, y: 2000, w: 100, h: 100 }, bounds)).toBe(false);
  });

  it('LOD below 24 screen px on the long side', () => {
    expect(isLod({ w: 200, h: 100 }, 0.1)).toBe(true); // 20 px
    expect(isLod({ w: 240, h: 100 }, 0.1)).toBe(false); // 24 px
    expect(LOD_MIN_SCREEN_PX).toBe(24);
  });

  it('compares id lists in O(n)', () => {
    expect(sameIdList(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(sameIdList(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(sameIdList(['a'], ['a', 'b'])).toBe(false);
  });

  it('frames use their contract rects', () => {
    const doc = docOf([frameDraft('n_page', -2000, 0, 'index.html')]);
    expect(computeVisibleIds({ nodesInOrder: nodesInOrder(doc), cam: { x: 0, y: 0, zoom: 1 }, stage })).toEqual([]);
    expect(computeVisibleIds({ nodesInOrder: nodesInOrder(doc), cam: { x: 2000, y: 0, zoom: 1 }, stage })).toEqual(['n_page']);
  });
});
