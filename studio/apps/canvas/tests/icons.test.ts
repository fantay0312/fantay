// SPDX-License-Identifier: Apache-2.0
/** D1: Lucide icons draw with a 1.5 stroke in the editor chrome (icons.ts, used by vite.config.ts). */
import { describe, expect, it } from 'vitest';

import { LUCIDE_STROKE_WIDTH, compileFantayIcon, fantayIconSvg } from '../icons';

const square = '<svg viewBox="0 0 24 24" width="1em" height="1em"><g fill="none" stroke="currentColor" stroke-width="2"><rect width="18" height="18" x="3" y="3" rx="2"/></g></svg>';

describe('Lucide stroke', () => {
  it('rewrites Lucide strokes and leaves other collections alone', () => {
    expect(LUCIDE_STROKE_WIDTH).toBe('1.5');
    expect(fantayIconSvg(square, 'lucide')).toContain('stroke-width="1.5"');
    expect(fantayIconSvg(square, 'lucide')).not.toContain('stroke-width="2"');
    expect(fantayIconSvg(square, 'mdi')).toBe(square);
  });

  it('compiles to a Vue render module with the Fantay stroke', () => {
    const code = compileFantayIcon(square, 'lucide', 'square');
    expect(code).toContain("import { markRaw } from 'vue'");
    expect(code).toContain("export default markRaw({ name: 'lucide-square', render })");
    expect(code).toMatch(/"stroke-width": "1\.5"/);
    expect(code).not.toMatch(/"stroke-width": "2"/);
  });
});
