import { describe, expect, it } from 'vitest';

import { BOARD_DEFAULT_SIZES, BOARD_DEVICE_SIZES, BOARD_LAYOUT } from '../src/api/board.js';
import {
  BOARD_GROUP_MIN_SIZE,
  defaultBoardNodeSize,
  deviceForFramePath,
  fitNodeSize,
  layoutColumn,
  layoutGrid,
  layoutRow,
  layoutTidyTopLevel,
  nodeSizeFromAspect,
  placeBoardItems,
  rectsOverlap,
  refitGroupRect,
  sortBoardLayoutItems,
} from '../src/board/index.js';

type Item = { id: string; x: number; y: number; w: number; h: number; parentId?: string; variantLabel?: string; origin?: { batchIndex?: number } };

function item(id: string, x: number, y: number, w: number, h: number, extra: Partial<Item> = {}): Item {
  return { id, x, y, w, h, ...extra };
}

describe('placeBoardItems', () => {
  it('auto: origin on an empty board, a row block for several items', () => {
    expect(placeBoardItems({ nodes: [] }, [{ w: 200, h: 100 }], { mode: 'auto' })).toEqual([{ x: 0, y: 0 }]);
    expect(placeBoardItems({ nodes: [] }, [{ w: 200, h: 100 }, { w: 300, h: 50 }], { mode: 'auto' })).toEqual([{ x: 0, y: 0 }, { x: 280, y: 0 }]);
  });

  it('auto: new cluster clusterGapY below the top-level bounds (children do not count)', () => {
    const nodes = [
      item('aaa', 100, 50, 200, 100),
      item('bbb', 400, 300, 100, 100),
      item('ccc', 5000, 5000, 100, 100, { parentId: 'aaa' }),
      item('ddd', -50, 0, 10, 10, { parentId: 'gone1' }),
    ];
    expect(placeBoardItems({ nodes }, [{ w: 10, h: 10 }], { mode: 'auto' })).toEqual([{ x: -50, y: 400 + BOARD_LAYOUT.clusterGapY }]);
  });

  it('near: right or below the base, walking down past collisions', () => {
    const base = item('aaa', 0, 0, 400, 300);
    expect(placeBoardItems({ nodes: [base] }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'aaa' })).toEqual([{ x: 480, y: 0 }]);
    expect(placeBoardItems({ nodes: [base] }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'aaa', side: 'below' })).toEqual([{ x: 0, y: 380 }]);
    const walls = [base, item('ob1', 480, 0, 300, 300), item('ob2', 480, 380, 300, 300)];
    expect(placeBoardItems({ nodes: walls }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'aaa' })).toEqual([{ x: 480, y: 760 }]);
  });

  it("near: ignores the base's own top-level ancestor and falls back to auto", () => {
    const nodes = [item('grp', 0, 0, 1000, 1000), item('kid', 24, 52, 200, 200, { parentId: 'grp' })];
    expect(placeBoardItems({ nodes }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'kid' })).toEqual([{ x: 304, y: 52 }]);
    expect(placeBoardItems({ nodes }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'missing' })).toEqual([{ x: 0, y: 1160 }]);
    const column = [item('aaa', 0, 0, 400, 300), ...Array.from({ length: 60 }, (_, index) => item(`ob${index}`, 480, index * 380, 300, 300))];
    expect(placeBoardItems({ nodes: column }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'aaa' })).toEqual([
      { x: 0, y: 59 * 380 + 300 + BOARD_LAYOUT.clusterGapY },
    ]);
  });

  it('viewport: centred on the point, else the first free slot of the spiral', () => {
    expect(placeBoardItems({ nodes: [] }, [{ w: 200, h: 100 }], { mode: 'viewport', centerX: 1000, centerY: 500 })).toEqual([{ x: 900, y: 450 }]);
    const obstacle = item('obs', 800, 400, 400, 200);
    const [placed] = placeBoardItems({ nodes: [obstacle] }, [{ w: 200, h: 100 }], { mode: 'viewport', centerX: 1000, centerY: 500 });
    // The spiral needs |dy| ≥ 5 steps of 40 px to clear the obstacle plus the itemGap/2 margin; (5, 5) is the first such slot.
    expect(placed).toEqual({ x: 1100, y: 650 });
    expect(rectsOverlap({ ...placed!, w: 200, h: 100 }, obstacle, BOARD_LAYOUT.itemGap / 2)).toBe(false);
    const wall = item('wal', -20_000, -20_000, 40_000, 40_000);
    expect(placeBoardItems({ nodes: [wall] }, [{ w: 10, h: 10 }], { mode: 'viewport', centerX: 0, centerY: 0 })).toEqual([
      { x: -20_000, y: 20_000 + BOARD_LAYOUT.clusterGapY },
    ]);
  });

  it('at: exact point, rounded; ignoreIds leave nodes out of collisions', () => {
    expect(placeBoardItems({ nodes: [] }, [{ w: 10, h: 10 }], { mode: 'at', x: 10.4, y: -3.6 })).toEqual([{ x: 10, y: -4 }]);
    const nodes = [item('aaa', 0, 0, 400, 300), item('ob1', 480, 0, 300, 300)];
    expect(placeBoardItems({ nodes }, [{ w: 100, h: 100 }], { mode: 'near', nodeId: 'aaa' }, { ignoreIds: ['ob1'] })).toEqual([{ x: 480, y: 0 }]);
  });
});

describe('row, grid, column and tidy layouts', () => {
  it('layoutRow wraps at rowWrapWidth (never before a row’s first item)', () => {
    const children = Array.from({ length: 4 }, (_, index) => item(`it${index}`, index, 0, 2000, 100));
    expect(layoutRow(children, { x: 0, y: 0 }, 80, BOARD_LAYOUT.rowWrapWidth, 'input')).toEqual([
      { id: 'it0', x: 0, y: 0 },
      { id: 'it1', x: 2080, y: 0 },
      { id: 'it2', x: 0, y: 180 },
      { id: 'it3', x: 2080, y: 180 },
    ]);
    expect(layoutRow([item('big', 0, 0, 9000, 10), item('nxt', 0, 0, 10, 10)], { x: 5, y: 5 }, 10, 6000, 'input')).toEqual([
      { id: 'big', x: 5, y: 5 },
      { id: 'nxt', x: 5, y: 25 },
    ]);
  });

  it('orders variants naturally, then by batch index, then x; positions by y then x', () => {
    const variants = [
      item('vb1', 0, 0, 10, 10, { variantLabel: 'b' }),
      item('v10', 0, 0, 10, 10, { variantLabel: '10' }),
      item('va1', 0, 0, 10, 10, { variantLabel: 'a' }),
      item('v02', 0, 0, 10, 10, { variantLabel: '2' }),
      item('vx2', 5, 0, 10, 10, { variantLabel: 'x', origin: { batchIndex: 2 } }),
      item('vx1', 9, 0, 10, 10, { variantLabel: 'x', origin: { batchIndex: 1 } }),
    ];
    expect(sortBoardLayoutItems(variants, 'variant').map((entry) => entry.id)).toEqual(['v02', 'v10', 'va1', 'vb1', 'vx1', 'vx2']);
    const positions = [item('ppp', 50, 10, 1, 1), item('qqq', 0, 10, 1, 1), item('rrr', 99, 0, 1, 1)];
    expect(sortBoardLayoutItems(positions, 'position').map((entry) => entry.id)).toEqual(['rrr', 'qqq', 'ppp']);
    expect(layoutRow(variants.slice(0, 4), { x: 0, y: 0 }, BOARD_LAYOUT.variantGap, 6000, 'variant').map((entry) => entry.id)).toEqual(['v02', 'v10', 'va1', 'vb1']);
  });

  it('layoutGrid uses ceil(sqrt(n)) columns of the largest cell by default', () => {
    const children = [item('g01', 0, 0, 100, 50), item('g02', 10, 0, 200, 80), item('g03', 20, 0, 50, 50), item('g04', 0, 10, 10, 10), item('g05', 10, 10, 10, 10)];
    expect(layoutGrid(children, { x: 0, y: 0 }, 10)).toEqual([
      { id: 'g01', x: 0, y: 0 },
      { id: 'g02', x: 210, y: 0 },
      { id: 'g03', x: 420, y: 0 },
      { id: 'g04', x: 0, y: 90 },
      { id: 'g05', x: 210, y: 90 },
    ]);
    expect(layoutGrid(children, { x: 0, y: 0 }, 10, 2).map((entry) => [entry.x, entry.y])).toEqual([[0, 0], [210, 0], [0, 90], [210, 90], [0, 180]]);
    expect(layoutGrid([], { x: 0, y: 0 }, 10)).toEqual([]);
  });

  it('layoutColumn stacks vertically', () => {
    expect(layoutColumn([item('c02', 0, 9, 10, 40), item('c01', 0, 1, 10, 20)], { x: 7, y: 0 }, 5)).toEqual([
      { id: 'c01', x: 7, y: 0 },
      { id: 'c02', x: 7, y: 25 },
    ]);
  });

  it('layoutTidyTopLevel stacks top-level items at the left edge, clusterGapY apart', () => {
    const nodes = [item('aaa', 300, 100, 50, 50), item('bbb', 100, 400, 80, 60), item('kid', 0, 0, 5, 5, { parentId: 'aaa' })];
    expect(layoutTidyTopLevel({ nodes })).toEqual([
      { id: 'aaa', x: 100, y: 100 },
      { id: 'bbb', x: 100, y: 310 },
    ]);
    expect(layoutTidyTopLevel({ nodes: [] })).toEqual([]);
  });

  it('refitGroupRect keeps x/y, wraps children plus groupPad, minimum 160×120', () => {
    expect(refitGroupRect({ x: 0, y: 0, w: 1, h: 1 }, [{ x: 24, y: 52, w: 400, h: 300 }])).toEqual({ x: 0, y: 0, w: 448, h: 376 });
    expect(refitGroupRect({ x: 0, y: 0, w: 999, h: 999 }, [])).toEqual({ x: 0, y: 0, ...BOARD_GROUP_MIN_SIZE });
    expect(refitGroupRect({ x: 0, y: 0, w: 1, h: 1 }, [{ x: 24, y: 52, w: 10, h: 10 }])).toEqual({ x: 0, y: 0, w: 160, h: 120 });
  });
});

describe('sizes and devices', () => {
  it('fitNodeSize matches infinite-canvas (scale down only, minimum 1 px)', () => {
    expect(fitNodeSize(1280, 720)).toEqual({ w: 640, h: 360 });
    expect(fitNodeSize(100, 50)).toEqual({ w: 100, h: 50 });
    expect(fitNodeSize(0, 0)).toEqual({ w: 1, h: 1 });
    expect(fitNodeSize(-5, 10)).toEqual({ w: 1, h: 10 });
    expect(fitNodeSize(2000, 1000, 512, 512)).toEqual({ w: 512, h: 256 });
    const tall = fitNodeSize(300, 900);
    expect(tall.h).toBe(640);
    expect(tall.w).toBeCloseTo(213.333, 2);
  });

  it('nodeSizeFromAspect matches infinite-canvas nodeSizeFromRatio', () => {
    expect(nodeSizeFromAspect('16:9', 640, 640)).toEqual({ w: 640, h: 360 });
    expect(nodeSizeFromAspect('9:16', 960, 540)).toEqual({ w: 303.75, h: 540 });
    expect(nodeSizeFromAspect('1080x1920', 640, 640)).toEqual({ w: 360, h: 640 });
    expect(nodeSizeFromAspect('10:1', 640, 480)).toEqual({ w: 640, h: 480 });
    expect(nodeSizeFromAspect('1:5', 640, 480)).toEqual({ w: 640, h: 480 });
    expect(nodeSizeFromAspect('16:9 cinema', 640, 640)).toEqual({ w: 640, h: 360 });
    expect(nodeSizeFromAspect('wide', 640, 640)).toBeNull();
  });

  it('defaultBoardNodeSize follows spec 04 §4.4.4 and plan R3a', () => {
    expect(defaultBoardNodeSize('frame')).toEqual({ ...BOARD_DEVICE_SIZES.desktop, device: 'desktop' });
    expect(defaultBoardNodeSize('frame', { device: 'mobile' })).toEqual({ w: 390, h: 844, device: 'mobile' });
    expect(defaultBoardNodeSize('web', { device: 'tablet' })).toEqual({ w: 834, h: 1112, device: 'tablet' });
    expect(defaultBoardNodeSize('frame', { projectKind: 'deck' })).toEqual({ w: 1280, h: 720, device: 'custom' });
    expect(defaultBoardNodeSize('frame', { device: 'custom' })).toEqual({ w: 1440, h: 900, device: 'custom' });
    expect(defaultBoardNodeSize('image')).toEqual({ w: 640, h: 640 });
    expect(defaultBoardNodeSize('image', { aspect: '16:9' })).toEqual({ w: 640, h: 360 });
    expect(defaultBoardNodeSize('video')).toEqual({ w: 960, h: 540 });
    expect(defaultBoardNodeSize('audio')).toEqual({ w: 360, h: 120 });
    expect(defaultBoardNodeSize('motion')).toEqual({ w: 960, h: 540 });
    expect(defaultBoardNodeSize('motion', { aspect: '9:16' })).toEqual({ w: 405, h: 720 });
    expect(defaultBoardNodeSize('motion', { aspect: '1:1' })).toEqual({ w: 720, h: 720 });
    expect(defaultBoardNodeSize('generator')).toEqual({ w: 320, h: 272 });
    expect(BOARD_DEFAULT_SIZES.generator).toEqual({ w: 320, h: 272 });
    expect(defaultBoardNodeSize('note')).toEqual(BOARD_DEFAULT_SIZES.note);
    expect(defaultBoardNodeSize('group')).toEqual({ w: 160, h: 120 });
  });

  it('deviceForFramePath', () => {
    const cases: Array<[string, string | null, string | null, string]> = [
      ['index.html', null, null, 'desktop'],
      ['mobile/index.html', null, null, 'mobile'],
      ['index.ios.html', null, null, 'mobile'],
      ['app-android.html', null, null, 'mobile'],
      ['iPhone_15.html', null, null, 'mobile'],
      ['phone.html', null, null, 'mobile'],
      ['smartphone-case.html', null, null, 'desktop'],
      ['tablet/index.html', null, null, 'tablet'],
      ['ipad-pro.html', null, null, 'tablet'],
      ['index.html', 'mobile-ios', null, 'mobile'],
      ['index.html', 'mobile-android', null, 'mobile'],
      ['index.html', 'tablet', null, 'tablet'],
      ['index.html', 'web-desktop', null, 'desktop'],
      ['mobile.html', null, 'deck', 'custom'],
    ];
    for (const [path, platform, projectKind, device] of cases) {
      expect(deviceForFramePath(path, platform, projectKind), path).toBe(device);
    }
  });
});
