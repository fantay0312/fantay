// SPDX-License-Identifier: AGPL-3.0-only
// The whiteboard's camera: fit never enlarges, a zoom keeps the point under the pointer, and the
// remembered centre lands on the same drawing point after the drawing's bounds grow.
import { describe, expect, it } from 'vitest';

import {
  CAMERA_PAD,
  MAX_ZOOM,
  MIN_ZOOM,
  centreFor,
  centrePoint,
  clampZoom,
  fitZoom,
  frameOffset,
  pictureAt,
  rasterScale,
  scrollToPut,
} from '../../../src/fantay/artifact/viewers/whiteboard/camera';

describe('fitZoom', () => {
  it('shows the whole picture and never enlarges it', () => {
    expect(fitZoom({ width: 200, height: 100 }, { width: 1000, height: 800 })).toBe(1);
    expect(fitZoom({ width: 2000, height: 500 }, { width: 1048, height: 800 })).toBeCloseTo((1048 - CAMERA_PAD * 2) / 2000);
    expect(fitZoom({ width: 100000, height: 100000 }, { width: 400, height: 400 })).toBe(MIN_ZOOM);
  });
  it('clamps zoom to the range', () => {
    expect(clampZoom(100)).toBe(MAX_ZOOM);
    expect(clampZoom(0)).toBe(MIN_ZOOM);
    expect(clampZoom(Number.NaN)).toBe(1);
  });
});

describe('pictureAt and scrollToPut', () => {
  const viewport = { width: 600, height: 400 };
  const natural = { width: 1200, height: 900 };
  it('are inverse: a point put under the pointer is found there again', () => {
    const point = { x: 812, y: 345 };
    const at = { x: 120, y: 300 };
    const scroll = scrollToPut(point, at, viewport, natural, 2);
    const found = pictureAt(scroll, at, viewport, natural, 2);
    expect(found.x).toBeCloseTo(point.x);
    expect(found.y).toBeCloseTo(point.y);
  });
  it('centres a picture smaller than the window', () => {
    expect(frameOffset(600, 100, 1)).toBe(250);
    expect(frameOffset(600, 1000, 1)).toBe(CAMERA_PAD);
  });
});

describe('remembered centre', () => {
  const viewport = { width: 600, height: 400 };
  it('is kept in scene coordinates and lands on the same point after the bounds grow', () => {
    const before = { width: 1000, height: 800 };
    const centre = centreFor({ x: 700, y: 500 }, viewport, before, 1.5, { x: -20, y: -20 });
    expect(centre.space).toBe('scene');
    // The agent drew something further up and left: the picture's corner moved.
    const point = centrePoint(centre, { x: -320, y: -220 });
    expect(point).not.toBeNull();
    if (!point) return;
    const old = pictureAt({ x: 700, y: 500 }, { x: 300, y: 200 }, viewport, before, 1.5);
    expect(point.x).toBeCloseTo(old.x + 300);
    expect(point.y).toBeCloseTo(old.y + 200);
  });
  it('falls back to picture coordinates without an origin', () => {
    const centre = centreFor({ x: 0, y: 0 }, viewport, { width: 2000, height: 2000 }, 1, null);
    expect(centre.space).toBe('picture');
    expect(centrePoint(centre, null)).toEqual({ x: centre.x, y: centre.y });
    expect(centrePoint({ x: 1, y: 2, space: 'scene' }, null)).toBeNull();
  });
});

describe('rasterScale', () => {
  it('draws at twice the size, within canvas limits', () => {
    expect(rasterScale({ width: 800, height: 600 })).toBe(2);
    expect(rasterScale({ width: 8000, height: 1000 })).toBeCloseTo(8192 / 8000);
    expect(rasterScale({ width: 6000, height: 6000 }) * 6000).toBeLessThanOrEqual(Math.sqrt(32_000_000) + 1);
  });
});
