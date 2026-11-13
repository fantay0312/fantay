// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  CHROME_INSETS,
  LABEL_ALLOWANCE,
  MAX_ZOOM,
  MIN_ZOOM,
  cameraFromViewport,
  clampZoom,
  ensureVisible,
  fitRect,
  screenToWorld,
  viewBoundsWorld,
  viewportFromCamera,
  worldToScreen,
  worldTransform,
  zoomAt,
  zoomAroundCenter,
  type Camera,
} from '../../../src/fantay/board/camera/camera';

const stage = { w: 1200, h: 800 };

describe('camera math', () => {
  it('zoomAt keeps the world point under the pivot fixed', () => {
    const cam: Camera = { x: 120, y: -40, zoom: 0.8 };
    const pivot = { x: 400, y: 300 };
    const before = screenToWorld(cam, pivot);
    const next = zoomAt(cam, 2.5, pivot);
    const after = screenToWorld(next, pivot);
    expect(next.zoom).toBe(2.5);
    expect(after.x).toBeCloseTo(before.x, 9);
    expect(after.y).toBeCloseTo(before.y, 9);
  });

  it('clamps zoom to [MIN_ZOOM, MAX_ZOOM]', () => {
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 100, { x: 0, y: 0 }).zoom).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, zoom: 1 }, 0.0001, { x: 0, y: 0 }).zoom).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
    expect(MIN_ZOOM).toBe(0.05);
    expect(MAX_ZOOM).toBe(8);
  });

  it('round-trips screen ↔ world', () => {
    const cam: Camera = { x: -333.5, y: 77, zoom: 1.75 };
    const world = { x: 512, y: -128 };
    const back = screenToWorld(cam, worldToScreen(cam, world));
    expect(back.x).toBeCloseTo(world.x, 9);
    expect(back.y).toBeCloseTo(world.y, 9);
  });

  it('zoomAroundCenter keeps the stage centre', () => {
    const cam: Camera = { x: 10, y: 20, zoom: 1 };
    const center = screenToWorld(cam, { x: stage.w / 2, y: stage.h / 2 });
    const next = zoomAroundCenter(cam, 2, stage);
    const after = screenToWorld(next, { x: stage.w / 2, y: stage.h / 2 });
    expect(after.x).toBeCloseTo(center.x, 9);
    expect(after.y).toBeCloseTo(center.y, 9);
  });

  it('fitRect centres the rect inside insets, padding and the label allowance, capped at maxZoom', () => {
    const rect = { x: 100, y: 200, w: 1000, h: 500 };
    const cam = fitRect(rect, stage, { maxZoom: 4 });
    const innerW = stage.w - CHROME_INSETS.left - CHROME_INSETS.right;
    const innerH = stage.h - CHROME_INSETS.top - CHROME_INSETS.bottom - LABEL_ALLOWANCE;
    expect(cam.zoom).toBeCloseTo(Math.min((innerW - 160) / rect.w, (innerH - 160) / rect.h), 9);
    const topLeft = worldToScreen(cam, { x: rect.x, y: rect.y });
    const bottomRight = worldToScreen(cam, { x: rect.x + rect.w, y: rect.y + rect.h });
    // horizontally centred in the inset area
    expect(topLeft.x - CHROME_INSETS.left).toBeCloseTo(innerW - (bottomRight.x - CHROME_INSETS.left), 6);
    // the label allowance is reserved above
    expect(topLeft.y).toBeGreaterThanOrEqual(CHROME_INSETS.top + LABEL_ALLOWANCE);
    expect(bottomRight.y).toBeLessThanOrEqual(stage.h - CHROME_INSETS.bottom);
    // a tiny rect stays at maxZoom (default 1)
    expect(fitRect({ x: 0, y: 0, w: 10, h: 10 }, stage).zoom).toBe(1);
  });

  it('worldTransform divides the translate by the layout zoom', () => {
    expect(worldTransform({ x: 100, y: -50, zoom: 2 }, 2)).toBe('translate(50px, -25px) scale(1)');
    expect(worldTransform({ x: 30, y: 60, zoom: 0.5 }, 1)).toBe('translate(30px, 60px) scale(0.5)');
  });

  it('ensureVisible pans minimally and never zooms', () => {
    const cam: Camera = { x: 0, y: 0, zoom: 1 };
    expect(ensureVisible(cam, { x: 100, y: 100, w: 200, h: 100 }, stage)).toBe(cam);
    const right = ensureVisible(cam, { x: 1150, y: 100, w: 200, h: 100 }, stage);
    expect(right.zoom).toBe(1);
    expect(right.y).toBe(0);
    expect(right.x).toBe(1200 - 24 - 1350);
    const above = ensureVisible(cam, { x: 100, y: -300, w: 200, h: 100 }, stage);
    expect(above.y).toBe(324);
    expect(above.x).toBe(0);
  });

  it('viewBoundsWorld grows by the overscan', () => {
    const bounds = viewBoundsWorld({ x: -200, y: -100, zoom: 2 }, stage, 50);
    expect(bounds).toEqual({ x: 50, y: 0, w: 700, h: 500 });
  });

  it('maps 04 viewports (centre + zoom) to cameras and back', () => {
    const viewport = { centerX: 640, centerY: -120, zoom: 1.5 };
    const cam = cameraFromViewport(viewport, stage);
    expect(screenToWorld(cam, { x: stage.w / 2, y: stage.h / 2 })).toEqual({ x: 640, y: -120 });
    expect(viewportFromCamera(cam, stage)).toEqual(viewport);
  });
});
