// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/tests/image-thumbnail.test.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: bun:test → vitest; import path of the ported module; added cases for
// `getThumbnailDimensions` and the no-op thumbnail of a small image (decoder injected, no canvas needed).
import { expect, test, vi } from 'vitest';

import { createImageThumbnail, getThumbnailDimensions, pickImageSource } from '../../../src/fantay/board/nodes/media/image-source';

const base = {
  previewUrl: 'data:image/webp;base64,preview',
  originalUrl: 'data:image/png;base64,original',
  naturalWidth: 4000,
  naturalHeight: 3000,
  renderedWidth: 420,
  renderedHeight: 315,
};

test('uses the preview while it has enough pixels for the rendered size', () => {
  expect(pickImageSource({ ...base, scale: 1, devicePixelRatio: 1 })).toBe(base.previewUrl);
});

test('falls back to the original once the rendered size outgrows the preview', () => {
  expect(pickImageSource({ ...base, scale: 3, devicePixelRatio: 2 })).toBe(base.originalUrl);
});

test('uses the original when no preview exists', () => {
  expect(pickImageSource({ ...base, previewUrl: undefined, scale: 1, devicePixelRatio: 1 })).toBe(base.originalUrl);
});

test('fits thumbnails into the long edge and never upscales', () => {
  expect(getThumbnailDimensions(4000, 3000)).toEqual({ width: 768, height: 576 });
  expect(getThumbnailDimensions(3000, 4000, 400)).toEqual({ width: 300, height: 400 });
  expect(getThumbnailDimensions(200, 100)).toEqual({ width: 200, height: 100 });
});

test('skips the thumbnail of an image that already fits', async () => {
  const close = vi.fn();
  const decode = vi.fn(async () => ({ width: 300, height: 200, close }) as unknown as ImageBitmap);
  await expect(createImageThumbnail(new Blob(['x']), 768, decode)).resolves.toBeUndefined();
  expect(close).toHaveBeenCalledTimes(1);
});
