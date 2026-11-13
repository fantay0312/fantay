// SPDX-License-Identifier: Apache-2.0
// Spec 05 §11: media tools — pure image operations (upscale size, split cuts, crop clamping), the project
// encoder order with a mocked canvas (PNG too big → WebP → JPEG; transparency never goes to JPEG), and the
// tool-output naming/persistence contract.
import { describe, expect, it, vi } from 'vitest';
import { GENERATION_LIMITS } from '@open-design/contracts';

import { ENCODE_ATTEMPTS, encodeForProject, extensionForMime, type EncodableCanvas } from '../../../src/fantay/media-tools/encode';
import { MAX_UPSCALE_LONG_EDGE, buildSplitCuts, cropRectToPixels, resolveUpscaleSize } from '../../../src/fantay/media-tools/image-ops';
import { persistToolOutput, toolOutputPath, toolOutputStem } from '../../../src/fantay/media-tools/persist';

const MB = 1024 * 1024;

/** A canvas double whose `toBlob` returns a blob-like of a fixed size per type (`null` = cannot encode). */
function fakeCanvas(sizes: Record<string, number | null>, realType: Record<string, string> = {}): EncodableCanvas & { calls: string[] } {
  const calls: string[] = [];
  return {
    width: 4000,
    height: 3000,
    calls,
    toBlob(callback, type = 'image/png') {
      calls.push(type);
      const size = sizes[type];
      callback(size === null || size === undefined ? null : ({ size, type: realType[type] ?? type } as Blob));
    },
  };
}

describe('resolveUpscaleSize', () => {
  it('scales the long edge to the target and keeps the aspect', () => {
    expect(resolveUpscaleSize(1000, 500, 2048)).toEqual({ width: 2048, height: 1024 });
    expect(resolveUpscaleSize(600, 900, 1024)).toEqual({ width: 683, height: 1024 });
  });

  it('caps the target at 4096 and never returns a zero edge', () => {
    expect(resolveUpscaleSize(1000, 1000, 10_000)).toEqual({ width: MAX_UPSCALE_LONG_EDGE, height: MAX_UPSCALE_LONG_EDGE });
    expect(resolveUpscaleSize(4000, 1, 2048)).toEqual({ width: 2048, height: 1 });
    expect(resolveUpscaleSize(10, 10, Number.NaN)).toEqual({ width: 1, height: 1 });
  });
});

describe('buildSplitCuts', () => {
  it('cuts even cells without lines', () => {
    expect(buildSplitCuts(undefined, 100, 3)).toEqual([0, 33, 66, 100]);
    expect(buildSplitCuts([], 90, 2)).toEqual([0, 45, 90]);
    expect(buildSplitCuts(undefined, 100, 0)).toEqual([0, 100]);
  });

  it('sorts, clamps and deduplicates explicit lines', () => {
    expect(buildSplitCuts([0.5, 0.25, 0.5, 1.2, -1, 0, 1], 100, 9)).toEqual([0, 25, 50, 100]);
    expect(buildSplitCuts([0.333, 0.3334], 10, 2)).toEqual([0, 3, 10]);
  });
});

describe('cropRectToPixels', () => {
  it('takes the centred square without a rect', () => {
    expect(cropRectToPixels(undefined, 200, 100)).toEqual({ sx: 50, sy: 0, sw: 100, sh: 100 });
    expect(cropRectToPixels(undefined, 80, 120)).toEqual({ sx: 0, sy: 20, sw: 80, sh: 80 });
  });

  it('maps a normalized rect to pixels', () => {
    expect(cropRectToPixels({ x: 0.1, y: 0.2, width: 0.5, height: 0.5 }, 1000, 500)).toEqual({ sx: 100, sy: 100, sw: 500, sh: 250 });
  });

  it('clamps rects that leave the image or are inverted, keeping at least 1×1', () => {
    expect(cropRectToPixels({ x: 0.9, y: -0.5, width: 0.5, height: 0.8 }, 100, 100)).toEqual({ sx: 90, sy: 0, sw: 10, sh: 30 });
    expect(cropRectToPixels({ x: 0.6, y: 0.6, width: -0.2, height: -0.2 }, 100, 100)).toEqual({ sx: 40, sy: 40, sw: 20, sh: 20 });
    expect(cropRectToPixels({ x: 1, y: 1, width: 0.2, height: 0.2 }, 50, 50)).toEqual({ sx: 49, sy: 49, sw: 1, sh: 1 });
    expect(cropRectToPixels({ x: Number.NaN, y: 0, width: 1, height: 1 }, 10, 10)).toEqual({ sx: 0, sy: 0, sw: 10, sh: 10 });
  });
});

describe('encodeForProject', () => {
  it('tries PNG, then WebP 0.92, then JPEG 0.88', () => {
    expect(ENCODE_ATTEMPTS.map((attempt) => [attempt.type, attempt.quality])).toEqual([
      ['image/png', undefined],
      ['image/webp', 0.92],
      ['image/jpeg', 0.88],
    ]);
  });

  it('returns the first encoding within the target', async () => {
    const small = fakeCanvas({ 'image/png': 2 * MB });
    await expect(encodeForProject(small, { hasAlpha: false })).resolves.toMatchObject({ ext: 'png', blob: { size: 2 * MB } });
    expect(small.calls).toEqual(['image/png']);

    const big = fakeCanvas({ 'image/png': 20 * MB, 'image/webp': 9 * MB, 'image/jpeg': 4 * MB });
    await expect(encodeForProject(big, { hasAlpha: false })).resolves.toMatchObject({ ext: 'webp' });
    expect(big.calls).toEqual(['image/png', 'image/webp']);
  });

  it('falls through to JPEG for an opaque image that WebP cannot shrink enough', async () => {
    const canvas = fakeCanvas({ 'image/png': 30 * MB, 'image/webp': 18 * MB, 'image/jpeg': 6 * MB });
    await expect(encodeForProject(canvas, { hasAlpha: false })).resolves.toMatchObject({ ext: 'jpg', blob: { size: 6 * MB } });
    expect(canvas.calls).toEqual(['image/png', 'image/webp', 'image/jpeg']);
  });

  it('keeps transparency: never JPEG, the smallest of PNG/WebP when neither fits', async () => {
    const canvas = fakeCanvas({ 'image/png': 30 * MB, 'image/webp': 18 * MB, 'image/jpeg': 1 * MB });
    await expect(encodeForProject(canvas, { hasAlpha: true })).resolves.toMatchObject({ ext: 'webp', blob: { size: 18 * MB } });
    expect(canvas.calls).toEqual(['image/png', 'image/webp']);
  });

  it('reads the real type when the browser cannot write WebP, and honours a custom target', async () => {
    const canvas = fakeCanvas({ 'image/png': 3 * MB, 'image/webp': 3 * MB }, { 'image/webp': 'image/png' });
    await expect(encodeForProject(canvas, { hasAlpha: true, targetBytes: 1 * MB })).resolves.toMatchObject({ ext: 'png' });
    expect(GENERATION_LIMITS.toolOutputTargetBytes).toBe(15 * MB);
  });

  it('fails when the canvas produces nothing', async () => {
    await expect(encodeForProject(fakeCanvas({ 'image/png': null, 'image/webp': null, 'image/jpeg': null }), { hasAlpha: false })).rejects.toThrow(
      'encode-failed',
    );
  });

  it('maps mime types to project extensions', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/jpeg; charset=binary')).toBe('jpg');
    expect(extensionForMime('image/gif')).toBeNull();
    expect(extensionForMime(undefined)).toBeNull();
  });
});

describe('tool output files', () => {
  it('names outputs board-media/<kind>/<kind>-<short source>-<short time>[-r<row>c<col>].<ext>', () => {
    const stem = toolOutputStem('crops', 'node-1', 1_730_000_000_000);
    expect(stem).toMatch(/^crops-[0-9a-z]{6}-[0-9a-z]{6}$/);
    expect(toolOutputStem('splits', 'node-1', 1_730_000_000_000, { row: 0, column: 2 })).toBe(`${stem.replace('crops', 'splits')}-r1c3`);
    expect(toolOutputPath('crops', stem, { type: 'image/webp' } as Blob)).toBe(`board-media/crops/${stem}.webp`);
    expect(toolOutputPath('frames', 'x', { type: '' } as Blob)).toBe('board-media/frames/x.png');
  });

  it('uploads through the injected uploader and returns the board media file', async () => {
    const upload = vi.fn(async (file: File, path: string) => ({
      name: path,
      size: file.size,
      mtime: 1234,
      kind: 'image' as const,
      mime: 'image/png',
    }));
    const blob = new Blob([new Uint8Array(8)], { type: 'image/png' });
    const saved = await persistToolOutput({ projectId: 'p1', workspaceContext: null, upload }, blob, 'crops', 'crops-a-b', { width: 640, height: 480 });
    expect(upload).toHaveBeenCalledWith(expect.any(File), 'board-media/crops/crops-a-b.png');
    expect(saved).toEqual({ path: 'board-media/crops/crops-a-b.png', mime: 'image/png', size: 8, mtime: 1234, width: 640, height: 480 });
  });

  it('returns null when the upload fails or throws', async () => {
    const blob = new Blob([new Uint8Array(4)], { type: 'image/png' });
    await expect(persistToolOutput({ projectId: 'p1', workspaceContext: null, upload: async () => null }, blob, 'frames', 'f')).resolves.toBeNull();
    await expect(
      persistToolOutput(
        {
          projectId: 'p1',
          workspaceContext: null,
          upload: async () => {
            throw new Error('offline');
          },
        },
        blob,
        'frames',
        'f',
      ),
    ).resolves.toBeNull();
  });
});
