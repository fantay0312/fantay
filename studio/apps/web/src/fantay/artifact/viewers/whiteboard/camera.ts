// SPDX-License-Identifier: AGPL-3.0-only
// Where the reader is looking on a drawing, as plain arithmetic. The picture sits in a scrolling
// plane (the image viewer's layout: a margin around it, centred while smaller than the window), so
// the camera is the scroll position plus the zoom. What is remembered is the drawing point under the
// middle of the window, in scene coordinates when the picture's origin is known: when the agent adds
// to the drawing and its bounds grow, the reader still looks at the same thing. Pure: no DOM.

/** Space kept between the picture and the edge of the stage. */
export const CAMERA_PAD = 24;
export const MIN_ZOOM = 0.02;
export const MAX_ZOOM = 8;

export interface Size {
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The drawing point under the middle of the window. `scene` survives a change of bounds. */
export interface CameraCentre {
  x: number;
  y: number;
  space: 'scene' | 'picture';
}

/** The zoom that shows the whole picture, never above 100%. */
export function fitZoom(natural: Size, viewport: Size, pad = CAMERA_PAD): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const availableWidth = Math.max(1, viewport.width - pad * 2);
  const availableHeight = Math.max(1, viewport.height - pad * 2);
  return Math.max(MIN_ZOOM, Math.min(1, availableWidth / natural.width, availableHeight / natural.height));
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom));
}

/** Where the picture's left (top) edge sits inside the scrolling plane at a zoom. */
export function frameOffset(viewport: number, natural: number, zoom: number, pad = CAMERA_PAD): number {
  return Math.max(pad, (viewport - natural * zoom) / 2);
}

/** The picture point (in 100% pixels) under a viewport point, for a scroll position. */
export function pictureAt(scroll: Point, viewportPoint: Point, viewport: Size, natural: Size, zoom: number): Point {
  return {
    x: (scroll.x + viewportPoint.x - frameOffset(viewport.width, natural.width, zoom)) / zoom,
    y: (scroll.y + viewportPoint.y - frameOffset(viewport.height, natural.height, zoom)) / zoom,
  };
}

/** The scroll position that puts a picture point under a viewport point. */
export function scrollToPut(point: Point, viewportPoint: Point, viewport: Size, natural: Size, zoom: number): Point {
  return {
    x: point.x * zoom + frameOffset(viewport.width, natural.width, zoom) - viewportPoint.x,
    y: point.y * zoom + frameOffset(viewport.height, natural.height, zoom) - viewportPoint.y,
  };
}

/** The camera centre to remember for the current view. */
export function centreFor(scroll: Point, viewport: Size, natural: Size, zoom: number, origin: Point | null): CameraCentre {
  const point = pictureAt(scroll, { x: viewport.width / 2, y: viewport.height / 2 }, viewport, natural, zoom);
  return origin ? { x: point.x + origin.x, y: point.y + origin.y, space: 'scene' } : { ...point, space: 'picture' };
}

/** The picture point a remembered centre names on this picture, or null when it cannot be placed. */
export function centrePoint(centre: CameraCentre, origin: Point | null): Point | null {
  if (!Number.isFinite(centre.x) || !Number.isFinite(centre.y)) return null;
  if (centre.space === 'picture') return { x: centre.x, y: centre.y };
  return origin ? { x: centre.x - origin.x, y: centre.y - origin.y } : null;
}

/** The pixel size a picture is drawn at for copying or saving: sharp, but within canvas limits. */
export function rasterScale(natural: Size, preferred = 2, maxSide = 8192, maxPixels = 32_000_000): number {
  if (natural.width <= 0 || natural.height <= 0) return 1;
  const scale = Math.min(preferred, maxSide / natural.width, maxSide / natural.height, Math.sqrt(maxPixels / (natural.width * natural.height)));
  return Math.max(0.01, scale);
}
