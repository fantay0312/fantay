// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/tests/canvas-focus-viewport.test.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: bun:test → vitest; node shape `{position, width, height}` → board rect
// `{x, y, w, h}` and viewport `{x, y, k}` → camera `{x, y, zoom}` through a small adapter.
import { expect, test } from 'vitest';

import { focusViewportForNode } from '../../../src/fantay/board/camera/focus-viewport';

type IcNode = { position: { x: number; y: number }; width: number; height: number };

const asRect = (node: IcNode) => ({ x: node.position.x, y: node.position.y, w: node.width, h: node.height });
const asSize = (size: { width: number; height: number }) => ({ w: size.width, h: size.height });
function focus(node: IcNode, size: { width: number; height: number }, frame?: Parameters<typeof focusViewportForNode>[2]) {
  const cam = focusViewportForNode(asRect(node), asSize(size), frame);
  return { x: cam.x, y: cam.y, k: cam.zoom };
}

// Mirrors the canvas transform: screen = viewport.offset + world * viewport.k, origin at top-left.
function projectPoint(world: { x: number; y: number }, viewport: { x: number; y: number; k: number }) {
  return { x: viewport.x + world.x * viewport.k, y: viewport.y + world.y * viewport.k };
}

function nodeCenter(node: IcNode) {
  return { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
}

test('centers the node in the viewport', () => {
  const size = { width: 900, height: 600 };
  const node = { position: { x: 1234, y: -567 }, width: 340, height: 240 };
  const screen = projectPoint(nodeCenter(node), focus(node, size));
  expect(screen.x).toBeCloseTo(size.width / 2, 6);
  expect(screen.y).toBeCloseTo(size.height / 2, 6);
});

test('clamps the zoom to [0.05, 1] and still centers oversized nodes', () => {
  const size = { width: 1000, height: 800 };
  const huge = { position: { x: 40, y: 80 }, width: 20000, height: 20000 };
  const hugeViewport = focus(huge, size);
  expect(hugeViewport.k).toBe(0.05);
  const screen = projectPoint(nodeCenter(huge), hugeViewport);
  expect(screen.x).toBeCloseTo(size.width / 2, 6);
  expect(screen.y).toBeCloseTo(size.height / 2, 6);
  expect(focus({ position: { x: 0, y: 0 }, width: 40, height: 40 }, size).k).toBe(1);
  expect(focus({ position: { x: 0, y: 0 }, width: 4000, height: 4000 }, size).k).toBeCloseTo(0.12, 6);
});

test('keeps an open overlay inside the viewport, leaving a smaller gap below the panel', () => {
  const size = { width: 900, height: 600 };
  const node = { position: { x: 0, y: 0 }, width: 340, height: 500 };
  const above = 62;
  const below = 316;
  const viewport = focus(node, size, { above, below });
  const top = viewport.y + node.position.y * viewport.k - above;
  const bottom = viewport.y + (node.position.y + node.height) * viewport.k + below;
  expect(top).toBeGreaterThanOrEqual(0);
  expect(bottom).toBeLessThanOrEqual(size.height);
  expect(size.height - bottom).toBeCloseTo(top / 3, 6);
  // The open panel must shrink the node compared to focusing it alone.
  expect(viewport.k).toBeLessThan(focus(node, size).k);
});

test('keeps the panel clear of the bottom dock, leaving a smaller gap below it', () => {
  const size = { width: 900, height: 700 };
  const node = { position: { x: 0, y: 0 }, width: 340, height: 240 };
  const bottomInset = 76;
  const below = 316;
  const viewport = focus(node, size, { below, bottomInset });
  const top = viewport.y + node.position.y * viewport.k;
  const bottom = viewport.y + (node.position.y + node.height) * viewport.k + below;
  const usableBottom = size.height - bottomInset;
  expect(bottom).toBeLessThanOrEqual(usableBottom);
  expect(usableBottom - bottom).toBeCloseTo(top / 3, 6);
});
