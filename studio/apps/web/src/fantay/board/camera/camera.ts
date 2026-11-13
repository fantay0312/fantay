/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/Stage.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the world transform with layout zoom
 *   (L56-58), zoom about a pivot (L79-90), fit with padding (L422-449) and the fly easing (L359-360) as pure
 *   functions over a {x, y, zoom} camera; chrome insets, label allowance, ensureVisible and the 04 viewport
 *   mapping are Fantay additions (spec 03 §3.2).
 */
import type { BoardViewport } from '@open-design/contracts';

import type { Insets, Point, Rect, Size } from '../model/types';

/** screen = world * zoom + (x, y), screen relative to the stage's top-left corner. */
export interface Camera { x: number; y: number; zoom: number }

export const MIN_ZOOM = 0.05;
export const MAX_ZOOM = 8;
/** = MAX_ZOOM so settled views stay crisp. */
export const LAYOUT_ZOOM_MAX = 8;
export const ZOOM_STEP = 1.25;
export const WHEEL_ZOOM_K = 0.01;
export const WHEEL_DELTA_CLAMP = 40;
/** A mouse notch reports about 4 px on macOS and 100 px on Windows: both become one 11–21% zoom step. */
export const MOUSE_WHEEL_DELTA_MIN = 12;
export const MOUSE_WHEEL_DELTA_MAX = 24;
/** A trackpad gesture keeps panning this long after its last recognisable event. */
export const TRACKPAD_GESTURE_MS = 160;
export const SETTLE_MS = 250;
export const FLY_MS = 600;
export const FIT_PADDING = 80;
export const LABEL_ALLOWANCE = 28;
/** toolbar 44 + 16 margin + 28 context-bar half */
export const CHROME_INSETS: Insets = { top: 16, right: 16, bottom: 88, left: 16 };
/** A maximized node fills the stage above the context bar (dock bottom 68 + bar 40 + 8 gap). */
export const MAXIMIZE_INSETS: Insets = { top: 12, right: 12, bottom: 116, left: 12 };
export const MAXIMIZE_MAX_ZOOM = 2;
/** Camera of an empty board. */
export const EMPTY_BOARD_CAMERA: Camera = { x: 80, y: 80, zoom: 1 };

/** The wheel fields `isTrackpadWheel` reads; `wheelDeltaY` is Chromium's legacy tick value. */
export interface WheelSample {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  wheelDeltaY?: number;
}

/**
 * Chromium reports a trackpad's pixel deltas as wheelDeltaY = -3 × deltaY; a notched wheel never satisfies
 * that (macOS 4.000244 px ↔ -12, Windows 100 px ↔ -120). Sideways motion also means a trackpad.
 */
export function isTrackpadWheel(event: WheelSample): boolean {
  if (event.deltaMode !== 0) return false;
  if (event.deltaX !== 0) return true;
  return !!event.wheelDeltaY && event.wheelDeltaY === -3 * event.deltaY;
}

/** One mouse-wheel event as a WHEEL_ZOOM_K delta. */
export function mouseWheelZoomDelta(deltaY: number): number {
  return Math.sign(deltaY) * Math.max(MOUSE_WHEEL_DELTA_MIN, Math.min(MOUSE_WHEEL_DELTA_MAX, Math.abs(deltaY)));
}

export function clampZoom(zoom: number, min = MIN_ZOOM, max = MAX_ZOOM): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(max, Math.max(min, zoom));
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return a.x === b.x && a.y === b.y && a.zoom === b.zoom;
}

export function screenToWorld(cam: Camera, p: Point): Point {
  return { x: (p.x - cam.x) / cam.zoom, y: (p.y - cam.y) / cam.zoom };
}

export function worldToScreen(cam: Camera, p: Point): Point {
  return { x: p.x * cam.zoom + cam.x, y: p.y * cam.zoom + cam.y };
}

export function rectToScreen(cam: Camera, r: Rect): Rect {
  return { x: r.x * cam.zoom + cam.x, y: r.y * cam.zoom + cam.y, w: r.w * cam.zoom, h: r.h * cam.zoom };
}

/** Zoom to `next` (clamped) keeping the world point under `pivot` (stage px) fixed. */
export function zoomAt(cam: Camera, next: number, pivot: Point): Camera {
  const zoom = clampZoom(next);
  const scale = zoom / cam.zoom;
  return { x: pivot.x - (pivot.x - cam.x) * scale, y: pivot.y - (pivot.y - cam.y) * scale, zoom };
}

/** Zoom about the stage centre: the world point in the middle stays in the middle. */
export function zoomAroundCenter(cam: Camera, next: number, stage: Size): Camera {
  return zoomAt(cam, next, { x: stage.w / 2, y: stage.h / 2 });
}

export interface FitOptions {
  padding?: number;
  maxZoom?: number;
  insets?: Insets;
  /** screen px kept free above the rect for labels */
  labelAllowance?: number;
}

/** Camera that fits a world rect into the stage minus chrome insets, padding and the label allowance. */
export function fitRect(rect: Rect, stage: Size, opts: FitOptions = {}): Camera {
  const padding = opts.padding ?? FIT_PADDING;
  const maxZoom = opts.maxZoom ?? 1;
  const insets = opts.insets ?? CHROME_INSETS;
  const labelAllowance = opts.labelAllowance ?? LABEL_ALLOWANCE;
  const rw = Math.max(1, rect.w);
  const rh = Math.max(1, rect.h);
  const innerW = stage.w - insets.left - insets.right;
  const innerH = stage.h - insets.top - insets.bottom - labelAllowance;
  const aw = innerW - padding * 2;
  const ah = innerH - padding * 2;
  const raw = aw > 0 && ah > 0 ? Math.min(aw / rw, ah / rh) : MIN_ZOOM;
  const zoom = clampZoom(raw, MIN_ZOOM, Math.max(MIN_ZOOM, Math.min(maxZoom, MAX_ZOOM)));
  return {
    x: insets.left + (innerW - rw * zoom) / 2 - rect.x * zoom,
    y: insets.top + labelAllowance + (innerH - rh * zoom) / 2 - rect.y * zoom,
    zoom,
  };
}

/** World rect visible on the stage, grown by `overscanWorld` on every side. */
export function viewBoundsWorld(cam: Camera, stage: Size, overscanWorld = 0): Rect {
  const left = -cam.x / cam.zoom;
  const top = -cam.y / cam.zoom;
  return {
    x: left - overscanWorld,
    y: top - overscanWorld,
    w: stage.w / cam.zoom + overscanWorld * 2,
    h: stage.h / cam.zoom + overscanWorld * 2,
  };
}

/* The world is laid out at CSS zoom k, the settled layout zoom, and its transform carries only what the camera has
   moved since. The element's own zoom also scales its translate, hence the /k. */
export function worldTransform(cam: Camera, k: number): string {
  return `translate(${cam.x / k}px, ${cam.y / k}px) scale(${cam.zoom / k})`;
}

/** Minimal pan (no zoom change) that brings a world rect inside the stage with `margin` screen px. */
export function ensureVisible(cam: Camera, rect: Rect, stage: Size, margin = 24): Camera {
  const s = rectToScreen(cam, rect);
  let dx = 0;
  let dy = 0;
  const maxW = stage.w - margin * 2;
  const maxH = stage.h - margin * 2;
  if (s.w > maxW || s.x < margin) dx = margin - s.x;
  else if (s.x + s.w > stage.w - margin) dx = stage.w - margin - (s.x + s.w);
  if (s.h > maxH || s.y < margin) dy = margin - s.y;
  else if (s.y + s.h > stage.h - margin) dy = stage.h - margin - (s.y + s.h);
  if (dx === 0 && dy === 0) return cam;
  return { x: cam.x + dx, y: cam.y + dy, zoom: cam.zoom };
}

export function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

export function interpolateCamera(from: Camera, to: Camera, t: number): Camera {
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
    zoom: from.zoom + (to.zoom - from.zoom) * t,
  };
}

/** 04 viewport (world point at the stage centre + zoom) → camera. */
export function cameraFromViewport(viewport: BoardViewport, stage: Size): Camera {
  const zoom = clampZoom(viewport.zoom);
  return { x: stage.w / 2 - viewport.centerX * zoom, y: stage.h / 2 - viewport.centerY * zoom, zoom };
}

/** Camera → 04 viewport (rounded to 0.01 world px / 1e-4 zoom). */
export function viewportFromCamera(cam: Camera, stage: Size): BoardViewport {
  const center = screenToWorld(cam, { x: stage.w / 2, y: stage.h / 2 });
  return {
    centerX: Math.round(center.x * 100) / 100,
    centerY: Math.round(center.y * 100) / 100,
    zoom: Math.round(cam.zoom * 10_000) / 10_000,
  };
}
