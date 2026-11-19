// SPDX-License-Identifier: AGPL-3.0-only
// The outline's judgement calls: which text on a slide is its title, the reading order of the rest,
// the plain text that goes to the clipboard, and the count of things the engine did not draw.
import { describe, expect, it } from 'vitest';

import { outlineSlide, outlineToText, type SlideTextItem } from '../../../src/fantay/artifact/viewers/slides/deck-outline';
import type { DeckSlide } from '../../../src/fantay/artifact/viewers/slides/protocol';
import { countUnsupported, totalUnsupported } from '../../../src/fantay/artifact/viewers/slides/slide-svg';

function text(value: string, y: number | null, size: number, x: number | null = 0.05): SlideTextItem {
  return { block: { kind: 'text', paragraphs: value.split('\n').map((line) => ({ text: line, level: 0 })) }, x, y, size };
}

function titles(blocks: DeckSlide['blocks']): string[] {
  return blocks.map((block) => (block.kind === 'text' ? block.paragraphs.map((paragraph) => paragraph.text).join('|') : block.kind));
}

describe('outlineSlide', () => {
  it('uses the title placeholder when the slide has one', () => {
    const slide = outlineSlide([text('正文第一段', 0.3, 18)], '  第三季度\n复盘 ');
    expect(slide.title).toBe('第三季度 复盘');
    expect(titles(slide.blocks)).toEqual(['正文第一段']);
  });

  it('takes the largest wording in the upper part of the slide as the title', () => {
    // A kicker above, a figure set larger lower down: neither is the title.
    const slide = outlineSlide(
      [text('12,480', 0.37, 32), text('四个核心指标全部达成', 0.11, 26), text('Q3 回顾', 0.06, 11), text('订阅用户', 0.29, 12)],
      null,
    );
    expect(slide.title).toBe('四个核心指标全部达成');
    expect(titles(slide.blocks)).toEqual(['Q3 回顾', '订阅用户', '12,480']);
  });

  it('does not take a bare number for a title', () => {
    const slide = outlineSlide([text('01', 0.27, 72), text('Q3 回顾', 0.48, 36), text('订阅用户、留存与客单价同时上升', 0.62, 14)], null);
    expect(slide.title).toBe('Q3 回顾');
    expect(titles(slide.blocks)).toEqual(['01', '订阅用户、留存与客单价同时上升']);
  });

  it('leaves a slide of pictures and tables untitled', () => {
    const slide = outlineSlide([{ block: { kind: 'table', rows: [['城市', '订阅']] }, x: 0.05, y: 0.25, size: 0 }], null);
    expect(slide.title).toBe('');
    expect(titles(slide.blocks)).toEqual(['table']);
  });

  it('reads rows left to right, then down; shapes with no place of their own come last in document order', () => {
    const slide = outlineSlide(
      [text('右上', 0.3, 12, 0.6), text('左上', 0.31, 12, 0.1), text('继承位置甲', null, 12, null), text('左下', 0.6, 12, 0.1), text('继承位置乙', null, 12, null), text('标题', 0.05, 30)],
      null,
    );
    expect(slide.title).toBe('标题');
    expect(titles(slide.blocks)).toEqual(['左上', '右上', '左下', '继承位置甲', '继承位置乙']);
  });
});

describe('outlineSlide with cards', () => {
  const card = (x: number, y = 0.27) => ({ x, y, w: 0.21, h: 0.37 });
  const inCard = (value: string, x: number, y: number, size: number): SlideTextItem => ({ ...text(value, y, size, x), w: 0.17, h: 0.06 });

  it('reads the text on one card together, and the cards left to right', () => {
    // Laid out as rows on the slide: all labels, then all figures, then all changes.
    const slide = outlineSlide(
      [
        text('四个核心指标全部达成', 0.11, 26),
        inCard('订阅用户', 0.07, 0.29, 12),
        inCard('月留存率', 0.3, 0.29, 12),
        inCard('12,480', 0.07, 0.36, 32),
        inCard('86.2%', 0.3, 0.36, 32),
        inCard('+18.4% 环比', 0.07, 0.52, 12),
        inCard('+2.1 个百分点', 0.3, 0.52, 12),
        text('口径：季度末有效订阅数', 0.7, 11),
      ],
      null,
      [card(0.05), card(0.28)],
    );
    expect(slide.title).toBe('四个核心指标全部达成');
    expect(titles(slide.blocks)).toEqual(['订阅用户|12,480|+18.4% 环比', '月留存率|86.2%|+2.1 个百分点', '口径：季度末有效订阅数']);
  });

  it('does not treat a background as a card, and picks the smallest card under a text', () => {
    const slide = outlineSlide(
      [text('标题', 0.05, 30), inCard('甲', 0.12, 0.42, 12), inCard('乙', 0.12, 0.5, 12), inCard('丙', 0.62, 0.42, 12)],
      null,
      [
        { x: 0, y: 0, w: 1, h: 1 },
        { x: 0.1, y: 0.4, w: 0.4, h: 0.3 },
        { x: 0.1, y: 0.4, w: 0.3, h: 0.07 },
      ],
    );
    // 甲 lies on the small card, 乙 only on the larger one, 丙 on neither: three separate blocks.
    // Had the background counted as a card, all three would have been read as one.
    expect(titles(slide.blocks)).toEqual(['甲', '乙', '丙']);
  });

  it('keeps a table apart from the text around it on the same card', () => {
    const slide = outlineSlide(
      [
        text('标题', 0.05, 30),
        inCard('上', 0.12, 0.42, 12),
        { block: { kind: 'table', rows: [['a', 'b']] }, x: 0.12, y: 0.5, w: 0.2, h: 0.1, size: 0 },
        inCard('下', 0.12, 0.62, 12),
      ],
      null,
      [{ x: 0.1, y: 0.4, w: 0.4, h: 0.35 }],
    );
    expect(titles(slide.blocks)).toEqual(['上', 'table', '下']);
  });
});

describe('outlineToText', () => {
  const labels = { notes: '备注', chart: '图表', untitled: '无标题' };

  it('writes numbered titles, indented list levels, tab-separated table rows and notes', () => {
    const slides: DeckSlide[] = [
      {
        title: '渠道构成',
        hidden: false,
        notes: '先讲小程序。',
        blocks: [
          { kind: 'text', paragraphs: [{ text: '微信小程序 52%', level: 0 }, { text: '转化率 4.6%', level: 1 }] },
          { kind: 'table', rows: [['城市', '订阅用户'], ['上海', '3,860']] },
          { kind: 'chart', series: ['渠道'], categories: ['小程序', '门店'] },
        ],
      },
      { title: '', hidden: true, notes: '', blocks: [] },
    ];
    expect(outlineToText(slides, labels)).toBe(
      ['1. 渠道构成', '微信小程序 52%', '  转化率 4.6%', '城市\t订阅用户', '上海\t3,860', '图表: 渠道, 小程序, 门店', '备注: 先讲小程序。', '', '2. 无标题'].join('\n'),
    );
  });

  it('keeps the lines of a paragraph that has line breaks', () => {
    const slides: DeckSlide[] = [{ title: 'T', hidden: false, notes: '', blocks: [{ kind: 'text', paragraphs: [{ text: '第一行\n第二行', level: 1 }] }] }];
    expect(outlineToText(slides, labels)).toBe('1. T\n  第一行\n  第二行');
  });
});

describe('countUnsupported', () => {
  it('groups the engine’s placeholders by kind, in a fixed order', () => {
    const svg =
      '<svg><g data-pptx-fallback="chart"><rect/></g><g data-pptx-fallback="image"/><g data-pptx-shape-name="x" data-pptx-fallback="custGeom"/>' +
      '<g data-pptx-fallback="graphicFrame"/><g data-pptx-fallback="chart"/></svg>';
    const counts = countUnsupported(svg);
    expect(counts).toEqual([
      { kind: 'image', count: 1 },
      { kind: 'chart', count: 2 },
      { kind: 'object', count: 1 },
      { kind: 'shape', count: 1 },
    ]);
    expect(totalUnsupported(counts)).toBe(5);
  });

  it('counts a marker it does not know as an object, and nothing in a clean slide', () => {
    expect(countUnsupported('<svg><g data-pptx-fallback="video"/></svg>')).toEqual([{ kind: 'object', count: 1 }]);
    expect(countUnsupported('<svg><rect/></svg>')).toEqual([]);
  });

  it('is not fooled by slide text that mentions the marker', () => {
    // Text reaches the SVG escaped, so its quotes are entities.
    expect(countUnsupported('<svg><text>data-pptx-fallback=&quot;chart&quot;</text></svg>')).toEqual([]);
  });
});
