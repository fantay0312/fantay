// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Two things a drawn diagram does beyond what its text says: it keeps to the room it is given where
// its kind can (so a narrow panel reads words at their real size), and a formula in a label is
// typeset by the product's engine, put into the drawing only after the SVG has passed the sanitiser.
import { beforeAll, describe, expect, it } from 'vitest';

import { loadMathEngine } from '../../../src/fantay/artifact/math/engine';
import { exportDiagramSvg } from '../../../src/fantay/artifact/viewers/diagram/export';
import { MATH_SLOT } from '../../../src/fantay/artifact/viewers/diagram/label-math';
import { drawDiagram, layoutWidthFor, type DiagramDrawing } from '../../../src/fantay/artifact/viewers/diagram/render';

async function draw(source: string, maxWidth: number | null = null): Promise<DiagramDrawing> {
  const outcome = await drawDiagram(source, { cancelled: false }, { maxWidth });
  if (!outcome?.ok) throw new Error(`did not draw: ${JSON.stringify(outcome)}`);
  return outcome.drawing;
}

const C4 = [
  'C4Context',
  '  title 咖啡订阅系统上下文',
  '  Person(customer, "订阅顾客", "通过小程序下单和续订")',
  '  System(sub, "订阅系统", "管理套餐、扣款和配送")',
  '  System_Ext(pay, "支付网关", "微信支付")',
  '  System_Ext(express, "快递公司", "顺丰开放平台")',
  '  Rel(customer, sub, "下单、续订")',
  '  Rel(sub, pay, "发起扣款")',
  '  Rel(sub, express, "推送运单")',
].join('\n');

describe('layoutWidthFor', () => {
  it('steps down to a multiple of 40 inside its bounds', () => {
    expect(layoutWidthFor(672)).toBe(640);
    expect(layoutWidthFor(528)).toBe(520);
    expect(layoutWidthFor(100)).toBe(280);
    expect(layoutWidthFor(9000)).toBe(2400);
    expect(layoutWidthFor(0)).toBeNull();
    expect(layoutWidthFor(-48)).toBeNull();
  });
});

describe('a drawing keeps to the room it has', () => {
  it('wraps a C4 diagram for a narrow panel and leaves it as written without a limit', async () => {
    const free = await draw(C4);
    const narrow = await draw(C4, 400);
    expect(free.layoutWidth).toBeNull();
    expect(narrow.layoutWidth).toBe(400);
    expect(free.width).toBeGreaterThan(700);
    expect(narrow.width).toBeLessThanOrEqual(400);
    expect(narrow.height).toBeGreaterThan(free.height);
  });

  it('does not change a drawing that already fits', async () => {
    const source = 'flowchart LR\n  A[下单] --> B[烘焙]';
    const free = await draw(source);
    const roomy = await draw(source, 1200);
    expect(roomy.width).toBe(free.width);
    expect(roomy.height).toBe(free.height);
  });

  it('turns a wide left-to-right flowchart for a narrow room only', async () => {
    const source = 'flowchart LR\n  A[顾客打开小程序] --> B[选择套餐] --> C[填写口味问卷] --> D[支付] --> E[周一统一烘焙] --> F[周二寄出]';
    const free = await draw(source);
    const wide = await draw(source, 720);
    const narrow = await draw(source, 400);
    expect(free.width).toBeGreaterThan(720);
    // Above pele's breakpoint the direction is the author's: gaps may tighten, the row stays a row.
    expect(wide.width).toBeLessThanOrEqual(free.width);
    expect(wide.width).toBeGreaterThan(wide.height * 3);
    // In a narrow room it runs top to bottom and fits.
    expect(narrow.width).toBeLessThanOrEqual(400);
    expect(narrow.height).toBeGreaterThan(narrow.width);
  });
});

describe('a formula in a label', () => {
  beforeAll(async () => {
    await loadMathEngine();
  });

  const FLOW = 'flowchart LR\n  A["采样点 $$x$$"] --> B{"$$x^2 + y^2 \\le r^2$$ ?"}';

  it('is typeset inside the box pele laid out for it', async () => {
    const drawing = await draw(FLOW);
    expect(drawing.math).toBe(true);
    const frames = Array.from(drawing.svg.querySelectorAll(`foreignObject[${MATH_SLOT}]`));
    expect(frames).toHaveLength(2);
    for (const frame of frames) {
      expect(frame.parentElement?.localName).toBe('svg');
      expect(frame.parentElement?.classList.contains('pele-math')).toBe(true);
      expect(frame.querySelector('.katex')).not.toBeNull();
      // Drawn as a picture: layout only, no MathML copy for a reader that is not there.
      expect(frame.querySelector('math')).toBeNull();
    }
    // Nothing of the source is left as text.
    expect(drawing.svg.textContent).not.toContain('$$');
  });

  it('says so when a drawing has none', async () => {
    const drawing = await draw('flowchart LR\n  A[下单] --> B[烘焙]');
    expect(drawing.math).toBe(false);
    expect(drawing.svg.querySelector('foreignObject')).toBeNull();
  });

  it('refuses commands that write addresses or attributes', async () => {
    const drawing = await draw('flowchart LR\n  A["$$\\href{javascript:alert(1)}{x}$$"] --> B["$$\\htmlStyle{background:url(https://example.com/x)}{y}$$"]');
    expect(drawing.svg.querySelector('a[href]')).toBeNull();
    for (const element of Array.from(drawing.svg.querySelectorAll('*'))) {
      for (const attribute of Array.from(element.attributes)) {
        expect(attribute.name.startsWith('on')).toBe(false);
        expect(attribute.value).not.toMatch(/javascript:|https?:\/\//i);
      }
    }
  });

  it('cannot be made by a file that writes the placeholder itself', async () => {
    // Only pele's own box for a formula is filled; a label that spells the attribute is just text.
    const drawing = await draw('flowchart LR\n  A["<g data-fx-math=0></g> 文字"] --> B[烘焙]');
    expect(drawing.svg.querySelector('foreignObject')).toBeNull();
    expect(drawing.svg.querySelector(`[${MATH_SLOT}]`)).toBeNull();
  });

  it('carries the style sheet it is given when it leaves the app', async () => {
    const drawing = await draw(FLOW);
    const file = exportDiagramSvg(drawing, '', '.katex{font:normal 1.21em KaTeX_Main}');
    expect(file).toContain('<style>.katex{font:normal 1.21em KaTeX_Main}</style>');
    expect(file).toContain('<foreignObject');
    expect(exportDiagramSvg(await draw('flowchart LR\n  A --> B'), '')).not.toContain('<style');
  });
});
