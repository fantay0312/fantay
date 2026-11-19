// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// A drawing that leaves the app carries real colours, not the variables the stage themes it with;
// and the stage's zoom arithmetic keeps the point under the pointer where it was.
import { render } from 'pele';
import { describe, expect, it } from 'vitest';

import { liftCornerRadius, pngScale, resolveCssVariables, withoutCustomProperties } from '../../../src/fantay/artifact/viewers/diagram/export';
import { fitZoom, frameOffset, openZoom, pointAt, READABLE_ZOOM, scrollFor } from '../../../src/fantay/artifact/viewers/diagram/geometry';

describe('resolveCssVariables', () => {
  const values: Record<string, string> = {
    '--_s': '#f3f3f3',
    '--pele-font': "-apple-system, 'PingFang SC', sans-serif",
    '--alias': 'var(--_s)',
  };
  const lookup = (name: string): string | null => values[name] ?? null;

  it('replaces variables with their values and falls back when one has none', () => {
    expect(resolveCssVariables('var(--_s)', lookup)).toBe('#f3f3f3');
    expect(resolveCssVariables('rx:var(--_r, 4px)', lookup)).toBe('rx:4px');
    expect(resolveCssVariables('var(--pele-series-1,#4c78a8)', lookup)).toBe('#4c78a8');
    expect(resolveCssVariables('var(--missing, var(--_s))', lookup)).toBe('#f3f3f3');
    expect(resolveCssVariables('var(--alias)', lookup)).toBe('#f3f3f3');
    expect(resolveCssVariables('font:14px sans-serif;font-family:var(--pele-font,sans-serif)', lookup)).toBe(
      "font:14px sans-serif;font-family:-apple-system, 'PingFang SC', sans-serif",
    );
    expect(resolveCssVariables('url(#g) var(--pele-series-2,#f58518)', lookup)).toBe('url(#g) #f58518');
  });

  it('leaves nothing variable in a real pele drawing', () => {
    for (const source of ['pie\n  "每周" : 3\n  "双周" : 2', 'flowchart LR\n  A[下单] --> B{付款?}\n  subgraph 履约\n    B --> C((寄出))\n  end']) {
      const { svg } = render(source, { images: false, idPrefix: 'x' });
      expect(svg).toContain('var(');
      const resolved = svg.replace(/"([^"]*var\([^"]*)"/g, (_, value: string) => `"${resolveCssVariables(value, () => '#123456')}"`);
      expect(resolved).not.toContain('var(');
    }
  });

  it('drops the custom properties from a style and keeps the rest', () => {
    expect(withoutCustomProperties('--_bg:#fff;color:#000; --pele-series-1:#123;font:14px sans-serif')).toBe('color:#000;font:14px sans-serif');
  });
});

describe('liftCornerRadius', () => {
  function rect(style: string): Element {
    const element = new DOMParser().parseFromString(`<svg xmlns="http://www.w3.org/2000/svg"><rect style="${style}"/></svg>`, 'image/svg+xml').querySelector('rect')!;
    liftCornerRadius(element);
    return element;
  }

  it('moves a corner radius from the style to attributes design tools read', () => {
    const only = rect('rx:6px');
    expect(only.getAttribute('rx')).toBe('6');
    expect(only.hasAttribute('style')).toBe(false);
    const mixed = rect('opacity:0.1; rx:4.5px;ry:2');
    expect([mixed.getAttribute('rx'), mixed.getAttribute('ry'), mixed.getAttribute('style')]).toEqual(['4.5', '2', 'opacity:0.1']);
    expect(rect('fill:red').getAttribute('style')).toBe('fill:red');
  });
});

describe('pngScale', () => {
  it('is 2× unless the canvas would be too large', () => {
    expect(pngScale(800, 600)).toBe(2);
    expect(pngScale(12_000, 400)).toBeCloseTo(16_384 / 12_000);
    expect(pngScale(8_000, 8_000)).toBeCloseTo(1);
    expect(pngScale(0, 10)).toBe(1);
  });
});

describe('stage geometry', () => {
  it('fits without ever enlarging past 100%', () => {
    expect(fitZoom({ width: 200, height: 100 }, { width: 800, height: 600 })).toBe(1);
    expect(fitZoom({ width: 1552, height: 274 }, { width: 800, height: 600 })).toBeCloseTo(752 / 1552);
    expect(fitZoom({ width: 400, height: 1200 }, { width: 800, height: 600 })).toBeCloseTo(552 / 1200);
  });

  it('opens with the whole drawing in view while its words stay readable', () => {
    const stage = { width: 800, height: 600 };
    expect(openZoom({ width: 200, height: 100 }, stage)).toBe(1);
    // A little too tall: all of it is shown, a little smaller.
    expect(openZoom({ width: 600, height: 700 }, stage)).toBeCloseTo(552 / 700);
    expect(552 / 700).toBeGreaterThan(READABLE_ZOOM);
  });

  it('opens a tall drawing as wide as the stage instead of shrinking it until its height fits', () => {
    const stage = { width: 800, height: 600 };
    // Fitting the height would draw it at 46%; it opens at its real size and is read by scrolling.
    expect(fitZoom({ width: 400, height: 1200 }, stage)).toBeCloseTo(0.46);
    expect(openZoom({ width: 400, height: 1200 }, stage)).toBe(1);
    // Tall and wider than the stage: as wide as the stage.
    expect(openZoom({ width: 1504, height: 4000 }, stage)).toBeCloseTo(0.5);
    // Wide and short: the width is what limits it either way.
    expect(openZoom({ width: 1552, height: 274 }, stage)).toBeCloseTo(752 / 1552);
  });

  it('centres a small drawing and pads a large one', () => {
    expect(frameOffset(800, 200, 1)).toBe(300);
    expect(frameOffset(800, 2000, 1)).toBe(24);
  });

  it('maps a drawing point to the scroll that puts it under the pointer, both ways', () => {
    const viewport = { width: 700, height: 500 };
    const natural = { width: 1600, height: 1200 };
    const at = { x: 120, y: 340 };
    const point = { x: 812, y: 455 };
    for (const zoom of [0.3, 1, 2.5]) {
      const scroll = scrollFor(point, at, viewport, natural, zoom);
      const back = pointAt(scroll, at, viewport, natural, zoom);
      expect(back.x).toBeCloseTo(point.x);
      expect(back.y).toBeCloseTo(point.y);
    }
  });
});
