// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/canvas/canvas-image-data.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: Blob output through encodeForProject, loadImage rejects on
// error/timeout, crop rectangles clamped to the image, split cuts deduplicated and clamped; the
// angle transform is not ported (phase 2).
import { encodeForProject } from './encode';

export type NormalizedRect = { x: number; y: number; width: number; height: number }; // 0..1
export type UpscaleAlgorithm = 'nearest' | 'bilinear' | 'high';
export const MAX_UPSCALE_LONG_EDGE = 4096;
export type UpscaleParams = { targetLongEdge: number; algorithm: UpscaleAlgorithm };
export type SplitParams = { rows: number; columns: number; horizontalLines?: number[]; verticalLines?: number[] };

const DEFAULT_LOAD_TIMEOUT_MS = 15_000;

/** Loads an image element; rejects on error or after `timeoutMs` (the upstream helper never rejected). */
export function loadImage(url: string, timeoutMs: number = DEFAULT_LOAD_TIMEOUT_MS): Promise<HTMLImageElement> {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    let settled = false;
    const finish = (error: Error | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve(image);
    };
    const timer = setTimeout(() => finish(new Error('image-load-timeout')), Math.max(0, timeoutMs));
    image.crossOrigin = 'anonymous';
    image.decoding = 'async';
    image.onload = () => finish(null);
    image.onerror = () => finish(new Error('image-load-failed'));
    image.src = url;
  });
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Pixel source rectangle of a normalized crop, clamped to the image (at least 1×1). Without a rect:
 * the centred square (upstream behaviour).
 */
export function cropRectToPixels(
  rect: NormalizedRect | undefined,
  width: number,
  height: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const imageWidth = Math.max(1, Math.round(width));
  const imageHeight = Math.max(1, Math.round(height));
  if (!rect) {
    const size = Math.min(imageWidth, imageHeight);
    return {
      sx: Math.max(0, Math.floor((imageWidth - size) / 2)),
      sy: Math.max(0, Math.floor((imageHeight - size) / 2)),
      sw: size,
      sh: size,
    };
  }
  const finite = (value: number, fallback: number) => (Number.isFinite(value) ? value : fallback);
  const left = finite(rect.x, 0);
  const top = finite(rect.y, 0);
  const x0 = clampUnit(left);
  const y0 = clampUnit(top);
  const x1 = clampUnit(left + finite(rect.width, 1));
  const y1 = clampUnit(top + finite(rect.height, 1));
  // Float noise (0.1 + 0.2) must not grow or shrink the crop by a pixel.
  const EPSILON = 1e-6;
  const sx = Math.min(imageWidth - 1, Math.floor(Math.min(x0, x1) * imageWidth + EPSILON));
  const sy = Math.min(imageHeight - 1, Math.floor(Math.min(y0, y1) * imageHeight + EPSILON));
  const ex = Math.max(sx + 1, Math.min(imageWidth, Math.ceil(Math.max(x0, x1) * imageWidth - EPSILON)));
  const ey = Math.max(sy + 1, Math.min(imageHeight, Math.ceil(Math.max(y0, y1) * imageHeight - EPSILON)));
  return { sx, sy, sw: ex - sx, sh: ey - sy };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  return canvas;
}

function context2d(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('canvas-2d-unavailable');
  return context;
}

function drawCrop(image: CanvasImageSource, sx: number, sy: number, sw: number, sh: number): HTMLCanvasElement {
  const canvas = createCanvas(sw, sh);
  context2d(canvas).drawImage(image, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return canvas;
}

async function encode(canvas: HTMLCanvasElement): Promise<Blob> {
  return (await encodeForProject(canvas)).blob;
}

/** Crops `url` (no rect → centred square) and encodes the result for the project. */
export async function cropToBlob(url: string, rect?: NormalizedRect): Promise<Blob> {
  const image = await loadImage(url);
  const { sx, sy, sw, sh } = cropRectToPixels(rect, image.naturalWidth || image.width, image.naturalHeight || image.height);
  return encode(drawCrop(image, sx, sy, sw, sh));
}

/**
 * Cut positions in pixels for one axis: without lines, `count` even cells; with lines (0..1),
 * the sorted, deduplicated interior cuts plus both edges (upstream `buildSplitCuts`, with the
 * duplicate/zero-size cells removed). Pure.
 */
export function buildSplitCuts(lines: number[] | undefined, size: number, count: number): number[] {
  const extent = Math.max(1, Math.round(size));
  if (!lines?.length) {
    const cells = Math.max(1, Math.min(extent, Math.floor(count) || 1));
    return Array.from({ length: cells + 1 }, (_, index) => Math.floor((index * extent) / cells));
  }
  const interior = lines
    .filter((line) => Number.isFinite(line))
    .map((line) => Math.round(line * extent))
    .filter((cut) => cut > 0 && cut < extent)
    .sort((a, b) => a - b)
    .filter((cut, index, all) => index === 0 || cut !== all[index - 1]);
  return [0, ...interior, extent];
}

/** Splits `url` into a grid; pieces in row-major order. */
export async function splitToBlobs(
  url: string,
  params: SplitParams,
): Promise<Array<{ row: number; column: number; blob: Blob }>> {
  const image = await loadImage(url);
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const xCuts = buildSplitCuts(params.verticalLines, width, Math.max(1, Math.floor(params.columns)));
  const yCuts = buildSplitCuts(params.horizontalLines, height, Math.max(1, Math.floor(params.rows)));
  const pieces: Array<{ row: number; column: number; blob: Blob }> = [];
  for (let row = 0; row < yCuts.length - 1; row += 1) {
    const sy = yCuts[row] ?? 0;
    const sh = (yCuts[row + 1] ?? height) - sy;
    for (let column = 0; column < xCuts.length - 1; column += 1) {
      const sx = xCuts[column] ?? 0;
      const sw = (xCuts[column + 1] ?? width) - sx;
      if (sw <= 0 || sh <= 0) continue;
      pieces.push({ row, column, blob: await encode(drawCrop(image, sx, sy, sw, sh)) });
    }
  }
  return pieces;
}

/** Output size for a target long edge (capped at {@link MAX_UPSCALE_LONG_EDGE}), aspect kept. Pure. */
export function resolveUpscaleSize(width: number, height: number, targetLongEdge: number): { width: number; height: number } {
  const longEdge = Math.max(1, width, height);
  const target = Math.min(MAX_UPSCALE_LONG_EDGE, Math.max(1, Math.round(Number.isFinite(targetLongEdge) ? targetLongEdge : 1)));
  const scale = target / longEdge;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function drawResizeCanvas(
  source: CanvasImageSource,
  sourceWidth: number,
  sourceHeight: number,
  width: number,
  height: number,
  algorithm: UpscaleAlgorithm,
): HTMLCanvasElement {
  const canvas = createCanvas(width, height);
  const context = context2d(canvas);
  context.imageSmoothingEnabled = algorithm !== 'nearest';
  context.imageSmoothingQuality = algorithm === 'bilinear' ? 'medium' : 'high';
  context.drawImage(source, 0, 0, sourceWidth, sourceHeight, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** 'high': repeated 2× steps, then the final resize (upstream drawStepUpscale). */
function drawStepUpscale(image: HTMLImageElement, sourceWidth: number, sourceHeight: number, width: number, height: number): HTMLCanvasElement {
  let source: CanvasImageSource = image;
  let currentWidth = sourceWidth;
  let currentHeight = sourceHeight;
  while (currentWidth * 2 < width && currentHeight * 2 < height) {
    const nextWidth = currentWidth * 2;
    const nextHeight = currentHeight * 2;
    source = drawResizeCanvas(source, currentWidth, currentHeight, nextWidth, nextHeight, 'high');
    currentWidth = nextWidth;
    currentHeight = nextHeight;
  }
  return drawResizeCanvas(source, currentWidth, currentHeight, width, height, 'high');
}

/** Local resampling (no AI) to `params.targetLongEdge`, then encoded for the project. */
export async function upscaleToBlob(url: string, params: UpscaleParams): Promise<Blob> {
  const image = await loadImage(url);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const { width, height } = resolveUpscaleSize(sourceWidth, sourceHeight, params.targetLongEdge);
  const canvas =
    params.algorithm === 'high'
      ? drawStepUpscale(image, sourceWidth, sourceHeight, width, height)
      : drawResizeCanvas(image, sourceWidth, sourceHeight, width, height, params.algorithm);
  return encode(canvas);
}
