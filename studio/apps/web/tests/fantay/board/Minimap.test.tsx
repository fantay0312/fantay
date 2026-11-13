// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  cameraCenteredOn,
  MINIMAP_MARGIN,
  MINIMAP_SIZE,
  minimapProjection,
  minimapToWorld,
  minimapViewportRect,
  worldToMinimap,
} from '../../../src/fantay/board/chrome/Minimap';
import { installStageSize, mountBoard, STAGE } from './chrome-fixtures';
import { makeBoard, noteDraft } from './engine-fixtures';

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    /* no storage */
  }
});
afterEach(() => cleanup());

describe('minimap projection (IC canvas-mini-map maths)', () => {
  it('fits the node union ±500 into 200×132, centred', () => {
    const projection = minimapProjection([
      { x: 0, y: 0, w: 1000, h: 500 },
      { x: 2000, y: 1000, w: 1000, h: 500 },
    ]);
    expect(projection.bounds).toEqual({ x: -MINIMAP_MARGIN, y: -MINIMAP_MARGIN, w: 4000, h: 2500 });
    expect(projection.scale).toBeCloseTo(Math.min(MINIMAP_SIZE.w / 4000, MINIMAP_SIZE.h / 2500));
    const centre = worldToMinimap(projection, { x: 1500, y: 750 });
    expect(centre.x).toBeCloseTo(MINIMAP_SIZE.w / 2);
    expect(centre.y).toBeCloseTo(MINIMAP_SIZE.h / 2);
    const back = minimapToWorld(projection, centre);
    expect(back.x).toBeCloseTo(1500);
    expect(back.y).toBeCloseTo(750);
  });

  it('draws the camera view (at least 4×4) and recentres at the current zoom', () => {
    const projection = minimapProjection([{ x: 0, y: 0, w: 1000, h: 1000 }]);
    const view = minimapViewportRect(projection, { x: 0, y: 0, zoom: 1 }, { w: 1000, h: 1000 });
    const topLeft = worldToMinimap(projection, { x: 0, y: 0 });
    expect(view.x).toBeCloseTo(topLeft.x);
    expect(view.w).toBeCloseTo(1000 * projection.scale);
    const tiny = minimapViewportRect(projection, { x: 0, y: 0, zoom: 8 }, { w: 10, h: 10 });
    expect(tiny.w).toBe(4);
    expect(cameraCenteredOn({ x: 100, y: 50 }, { x: 0, y: 0, zoom: 2 }, { w: 800, h: 600 })).toEqual({ x: 400 - 200, y: 300 - 100, zoom: 2 });
  });
});

function openMinimapFromMenu(): void {
  // R7: Show/Hide minimap lives in the board background context menu
  act(() => {
    fireEvent.contextMenu(screen.getByTestId('board-stage'), { clientX: 900, clientY: 700, button: 2 });
  });
  expect(screen.getByTestId('board-context-menu-background')).toBeInTheDocument();
  fireEvent.click(screen.getByTestId('board-menu-minimap'));
}

describe('Minimap', () => {
  it('is hidden by default; the background menu shows it and the choice persists', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0), noteDraft('n_b', 2000, 1000)]) });
    expect(screen.queryByTestId('board-minimap')).toBeNull();
    openMinimapFromMenu();
    expect(screen.getByRole('group', { name: 'Minimap' })).toHaveAttribute('data-testid', 'board-minimap');
    expect(screen.getAllByTestId('board-minimap').length).toBe(1);
    expect(window.localStorage.getItem('fantay.board.prefs.v2')).toContain('"minimapOpen":true');
  });

  it('centres the camera on the clicked world point and follows the camera without React', () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0), noteDraft('n_b', 2000, 1000)]) });
    openMinimapFromMenu();
    const minimap = screen.getByTestId('board-minimap');
    const camera = h.commands().camera;
    const zoom = camera.get().zoom;
    // jsdom: the minimap's box sits at the client origin, so its centre is (100, 66)
    act(() => {
      fireEvent.pointerDown(minimap, { button: 0, pointerId: 3, clientX: MINIMAP_SIZE.w / 2, clientY: MINIMAP_SIZE.h / 2 });
      fireEvent.pointerUp(minimap, { button: 0, pointerId: 3 });
    });
    // the centre of the minimap is the centre of the node union (1140, 610)
    const cam = camera.get();
    expect(cam.zoom).toBe(zoom);
    expect(cam.x).toBeCloseTo(STAGE.w / 2 - 1140 * zoom, 0);
    expect(cam.y).toBeCloseTo(STAGE.h / 2 - 610 * zoom, 0);

    const viewport = screen.getByTestId('board-minimap-viewport');
    const before = viewport.style.transform;
    act(() => {
      camera.set({ x: cam.x - 400, y: cam.y, zoom }, 'program');
      h.frames.flush();
    });
    expect(viewport.style.transform).not.toBe(before);
    expect(viewport.style.width).not.toBe('');
  });
});
