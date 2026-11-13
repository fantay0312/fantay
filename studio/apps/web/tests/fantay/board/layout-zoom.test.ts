/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: tests/frameRasterZoom.test.ts (describe 'layout zoom', L28-61) @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: the three unit cases with adapted
 *   imports; the puppeteer browser block is dropped (spec 03 §7.1).
 */
import { describe, expect, it } from 'vitest';

import { counterZoom, layoutZoomFor } from '../../../src/fantay/board/camera/layout-zoom';

describe('layout zoom', () => {
  it('stays within a float32 ulp of the settled zoom, clamped to [1, max]', () => {
    expect(layoutZoomFor(0.5, 3, false)).toBe(1);
    expect(layoutZoomFor(4, 3, false)).toBe(3);
    expect(layoutZoomFor(17, 16, false)).toBe(16);
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      expect(Math.abs(layoutZoomFor(zoom, 16, false) / zoom - 1)).toBeLessThan(2e-7);
    }
  });

  it('gives every layout zoom an iframe zoom that undoes it exactly in float32', () => {
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      const k = layoutZoomFor(zoom, 16, false);
      expect(Math.fround(Math.fround(k) * Math.fround(counterZoom(k)))).toBe(1);
    }
  });

  it('rounds a density-path zoom up to a whole number, so design sizes scale exactly', () => {
    expect(layoutZoomFor(0.5, 16, true)).toBe(1);
    expect(layoutZoomFor(2, 16, true)).toBe(2);
    expect(layoutZoomFor(2.0000001, 16, true)).toBe(2);
    expect(layoutZoomFor(2.01, 16, true)).toBe(3);
    expect(layoutZoomFor(17, 16, true)).toBe(16);
    for (let zoom = 1; zoom <= 16; zoom += 0.0007) {
      const k = layoutZoomFor(zoom, 16, true);
      expect(Number.isInteger(k)).toBe(true);
      expect(k).toBeGreaterThanOrEqual(zoom - 1e-3);
      expect(k).toBeLessThan(zoom + 1);
    }
  });
});
