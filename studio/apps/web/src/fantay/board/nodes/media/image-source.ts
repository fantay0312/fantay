// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/image-thumbnail.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: verbatim logic; the WebP quality comes from the board cover constant
// (0.86), and `createImageThumbnail` accepts an injectable bitmap decoder for tests.
export const CANVAS_IMAGE_PREVIEW_MAX_EDGE = 768;
const THUMBNAIL_WEBP_QUALITY = 0.86;

type ImageSourceChoice = {
  previewUrl?: string | undefined;
  originalUrl: string;
  naturalWidth?: number | undefined;
  naturalHeight?: number | undefined;
  renderedWidth: number;
  renderedHeight: number;
  scale: number;
  devicePixelRatio?: number;
  previewMaxEdge?: number;
};

// Small previews keep panning cheap, but they look soft once the node is magnified.
// Use the original only when the on-screen size actually needs more pixels than the preview holds.
export function pickImageSource({
  previewUrl,
  originalUrl,
  naturalWidth,
  naturalHeight,
  renderedWidth,
  renderedHeight,
  scale,
  devicePixelRatio = globalThis.devicePixelRatio || 1,
  previewMaxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE,
}: ImageSourceChoice): string {
  if (!previewUrl) return originalUrl;
  const naturalLongEdge = Math.max(naturalWidth || 0, naturalHeight || 0);
  const previewLongEdge = naturalLongEdge > 0 ? Math.min(previewMaxEdge, naturalLongEdge) : previewMaxEdge;
  const requiredLongEdge = Math.max(renderedWidth, renderedHeight) * scale * devicePixelRatio;
  return requiredLongEdge > previewLongEdge ? originalUrl : previewUrl;
}

export function getThumbnailDimensions(width: number, height: number, maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

export async function createImageThumbnail(
  blob: Blob,
  maxEdge = CANVAS_IMAGE_PREVIEW_MAX_EDGE,
  decode: (blob: Blob) => Promise<ImageBitmap> = (input) => createImageBitmap(input),
): Promise<Blob | undefined> {
  const bitmap = await decode(blob);
  const { width, height } = getThumbnailDimensions(bitmap.width, bitmap.height, maxEdge);
  if (width === bitmap.width && height === bitmap.height) {
    bitmap.close();
    return undefined;
  }

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) {
    bitmap.close();
    return undefined;
  }
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return new Promise<Blob | undefined>((resolve) => canvas.toBlob((result) => resolve(result || undefined), 'image/webp', THUMBNAIL_WEBP_QUALITY));
}
