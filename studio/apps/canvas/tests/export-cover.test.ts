// SPDX-License-Identifier: Apache-2.0
/** Cover export (06 §3.6 `export.ts`): scale, size and layer selection, PNG size reading, zip naming. */
import { unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { COVER_DEFAULT_MAX_EDGE, bundleExportFiles, coverNodeIds, coverScale, coverSize, ownedBytes, pngSize } from '../src/fx/editor/export';

describe('coverScale', () => {
  it('fits the longest side to the max edge', () => {
    expect(COVER_DEFAULT_MAX_EDGE).toBe(1600);
    expect(coverScale({ width: 3200, height: 800 })).toBe(0.5);
    expect(coverScale({ width: 400, height: 1600 })).toBe(1);
    expect(coverScale({ width: 1000, height: 500 }, 500)).toBe(0.5);
  });

  it('clamps to [0.05, 2]', () => {
    expect(coverScale({ width: 100, height: 50 })).toBe(2);
    expect(coverScale({ width: 1_000_000, height: 10 })).toBe(0.05);
  });

  it('handles degenerate bounds', () => {
    expect(coverScale({ width: 0, height: 0 })).toBe(1);
    expect(coverScale({ width: 100, height: 100 }, 0)).toBe(1);
  });
});

describe('coverSize', () => {
  it('rounds to whole pixels and never collapses to zero', () => {
    expect(coverSize({ width: 3200, height: 801 }, 0.5)).toEqual({ width: 1600, height: 401 });
    expect(coverSize({ width: 3, height: 0.2 }, 0.05)).toEqual({ width: 1, height: 1 });
  });
});

describe('coverNodeIds', () => {
  it('takes the visible top-level layers', () => {
    expect(coverNodeIds([{ id: 'a' }, { id: 'b', visible: false }, { id: 'c', visible: true }])).toEqual(['a', 'c']);
    expect(coverNodeIds([])).toEqual([]);
  });
});

describe('pngSize', () => {
  it('reads the IHDR size', () => {
    const png = new Uint8Array(24);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    new DataView(png.buffer).setUint32(16, 1600);
    new DataView(png.buffer).setUint32(20, 900);
    expect(pngSize(png)).toEqual({ width: 1600, height: 900 });
    expect(pngSize(new Uint8Array(10))).toBeNull();
    expect(pngSize(new Uint8Array(24))).toBeNull();
  });
});

describe('ownedBytes', () => {
  it('keeps ArrayBuffer-backed bytes and copies shared ones', () => {
    const plain = new Uint8Array([1, 2]);
    expect(ownedBytes(plain)).toBe(plain);
    if (typeof SharedArrayBuffer !== 'undefined') {
      const shared = new Uint8Array(new SharedArrayBuffer(2));
      shared.set([3, 4]);
      const owned = ownedBytes(shared);
      expect(owned.buffer).toBeInstanceOf(ArrayBuffer);
      expect([...owned]).toEqual([3, 4]);
    }
  });
});

describe('bundleExportFiles', () => {
  it('zips several files with safe, unique names', () => {
    const file = (fileName: string) => ({ fileName, bytes: new Uint8Array([1]), mime: 'image/png' });
    const zip = bundleExportFiles([file('Frame@1x.png'), file('Frame@1x.png'), file('../../etc/passwd'), file('a/b\\c.svg'), file('\u0001')]);
    expect(Object.keys(unzipSync(zip)).sort()).toEqual(['Frame@1x (2).png', 'Frame@1x.png', '____etc_passwd', 'a_b_c.svg', 'export'].sort());
  });
});
