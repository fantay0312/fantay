import sharp from 'sharp';
import { expect, test } from 'vitest';
import { normalizeFramePng } from '../../src/main/frame-color.js';

test('converts display-profile screenshot pixels to sRGB before video encoding', async () => {
  const png = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).withIccProfile('p3').png().toBuffer();
  const normalized = await normalizeFramePng(png);
  // Removing the profile models FFmpeg's PNG decoder, which uses raw RGB.
  const pixel = await sharp(normalized).keepIccProfile().removeAlpha().raw().toBuffer();
  expect(pixel[0]).toBeGreaterThanOrEqual(253);
  expect(pixel[1]).toBeLessThanOrEqual(2);
  expect(pixel[2]).toBeLessThanOrEqual(2);
  expect((await sharp(normalized).metadata()).icc).toBeUndefined();
});
