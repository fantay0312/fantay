// SPDX-License-Identifier: AGPL-3.0-only
// The PowerPoint reader end to end, on a deck built with the model library itself: what the
// outline says, and the corrections made before a slide is drawn (alignment of shape text, table
// size and style, flat lines). These pin the reader to PowerPoint's reading of a generator's deck.
import { describe, expect, it } from 'vitest';

import {
  addBlankSlide,
  addSlideShape,
  addSlideTable,
  addSlideTextBox,
  createPresentation,
  emu,
  savePresentation,
  setParagraphAlignment,
  setSlideHidden,
  setSlideNotes,
  setTableStyleId,
} from '../../../../../node_modules/.pnpm/node_modules/@office-kit/pptx/dist/index.js';
import { openPptx } from '../../../src/fantay/artifact/viewers/slides/pptx-deck';

const INCH = 914_400;
const e = (value: number) => emu(value);

async function sampleDeck(): Promise<ArrayBuffer> {
  const pres = createPresentation({ size: '16:9' });

  const first = addBlankSlide(pres);
  // Text in plain shapes with no alignment, as PptxGenJS writes every text it adds.
  addSlideShape(first, { preset: 'rect', x: e(INCH), y: e(INCH * 0.4), w: e(INCH * 8), h: e(INCH * 0.8), text: '各城市表现', name: 'heading' });
  addSlideShape(first, { preset: 'rect', x: e(INCH), y: e(INCH * 1.4), w: e(INCH * 8), h: e(INCH * 0.5), text: '华南留存偏低', name: 'body' });
  // A shape whose author did centre it keeps its alignment.
  const centred = addSlideShape(first, { preset: 'rect', x: e(INCH), y: e(INCH * 2), w: e(INCH * 8), h: e(INCH * 0.5), text: '居中的一行', name: 'centred' });
  setParagraphAlignment(centred, 0, 'center');
  addSlideTextBox(first, { x: e(INCH), y: e(INCH * 2.6), w: e(INCH * 8), h: e(INCH * 0.5), text: '文本框里的一行', name: 'box' });
  // A horizontal rule: a line shape of height zero.
  addSlideShape(first, { preset: 'line', x: e(INCH), y: e(INCH * 3.2), w: e(INCH * 8), h: e(0), name: 'rule' });
  // A table whose frame states a smaller height than its rows, and no table style.
  const table = addSlideTable(first, {
    x: e(INCH),
    y: e(INCH * 3.5),
    w: e(INCH * 6),
    h: e(INCH * 0.5),
    rows: [
      ['城市', '订阅用户'],
      ['上海', '3,860'],
      ['杭州', '2,240'],
    ],
    rowHeights: [e(INCH * 0.4), e(INCH * 0.4), e(INCH * 0.4)],
  });
  setTableStyleId(table, null);
  setSlideNotes(first, '先讲结论。\n再讲华南。');

  const second = addBlankSlide(pres);
  addSlideShape(second, { preset: 'rect', x: e(INCH), y: e(INCH * 2), w: e(INCH * 8), h: e(INCH), text: '附录', name: 'appendix' });
  setSlideHidden(second, true);

  const bytes = await savePresentation(pres);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The inline style of the paragraph that holds `text` in a slide's SVG. */
function paragraphStyle(svg: string, text: string): string {
  const at = svg.indexOf(text);
  const start = svg.lastIndexOf('<p ', at);
  return /style="([^"]*)"/.exec(svg.slice(start, at))?.[1] ?? '';
}

describe('openPptx', () => {
  it('reads the size, the slides, hidden slides and notes', async () => {
    const deck = await openPptx(await sampleDeck());
    expect(deck.info.drawable).toBe(true);
    expect(deck.info.width).toBe(1280);
    expect(deck.info.height).toBe(720);
    expect(deck.info.slides).toHaveLength(2);
    expect(deck.info.slides.map((slide) => slide.hidden)).toEqual([false, true]);
    expect(deck.info.slides[0]?.notes).toBe('先讲结论。\n再讲华南。');
    expect(deck.info.outlineCut).toBe(false);
  });

  it('outlines a slide that has no title placeholder: title by place and size, then text and the table in reading order', async () => {
    const deck = await openPptx(await sampleDeck());
    const slide = deck.info.slides[0];
    expect(slide?.title).toBe('各城市表现');
    expect(slide?.blocks).toEqual([
      { kind: 'text', paragraphs: [{ text: '华南留存偏低', level: 0 }] },
      { kind: 'text', paragraphs: [{ text: '居中的一行', level: 0 }] },
      { kind: 'text', paragraphs: [{ text: '文本框里的一行', level: 0 }] },
      { kind: 'table', rows: [['城市', '订阅用户'], ['上海', '3,860'], ['杭州', '2,240']] },
    ]);
    expect(deck.info.slides[1]?.title).toBe('附录');
  });

  it('draws shape text with the alignment PowerPoint would give it', async () => {
    const deck = await openPptx(await sampleDeck());
    const { svg, unsupported } = deck.render(0);
    expect(svg.startsWith('<svg')).toBe(true);
    expect(unsupported).toEqual([]);
    // Not named in the file: inherited "left", where the engine alone would centre it.
    expect(paragraphStyle(svg, '各城市表现')).toContain('text-align:left');
    expect(paragraphStyle(svg, '华南留存偏低')).toContain('text-align:left');
    // Named in the file: kept.
    expect(paragraphStyle(svg, '居中的一行')).toContain('text-align:center');
    expect(paragraphStyle(svg, '文本框里的一行')).toContain('text-align:left');
  });

  it('draws a flat line, and gives a table the height of its rows', async () => {
    const deck = await openPptx(await sampleDeck());
    const { svg } = deck.render(0);
    expect(svg).toContain('data-pptx-shape-name="rule"');
    const heights = [...svg.matchAll(/data-pptx-cell="(\d),0"><rect [^>]*height="([\d.]+)"/g)].map((match) => Number(match[2]));
    expect(heights).toHaveLength(3);
    // 0.4 in per row at 96 px per inch; squeezed into the frame they would be 16 px.
    for (const height of heights) expect(height).toBeCloseTo(38.4, 1);
  });

  it('draws the same slide the same way twice', async () => {
    const deck = await openPptx(await sampleDeck());
    expect(deck.render(0).svg).toBe(deck.render(0).svg);
  });

  it('refuses bytes that are not a deck, and a slide that does not exist', async () => {
    await expect(openPptx(new TextEncoder().encode('not a presentation').buffer as ArrayBuffer)).rejects.toMatchObject({ failure: 'invalid' });
    const deck = await openPptx(await sampleDeck());
    expect(() => deck.render(7)).toThrow();
  });
});
