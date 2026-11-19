// The pure half of the chat's product cards: layout, naming, labels, facts and the cover excerpt.
import { describe, expect, it } from 'vitest';

import {
  EXCERPT_MAX_BYTES,
  MAX_VISIBLE_PRODUCTS,
  cardsLayout,
  coverExcerpt,
  coverMediaFit,
  coverReadsText,
  excerptStyle,
  productFace,
  productFacts,
  productLabel,
  productName,
  tileImageFit,
  visibleProducts,
  type ArtifactProduct,
} from '../../../src/fantay/artifact/cards/card-model';

const product = (name: string, extra: Partial<ArtifactProduct> = {}): ArtifactProduct => ({ name, kind: 'doc', ...extra });

describe('cardsLayout', () => {
  it('presents one finished product on a cover', () => {
    expect(cardsLayout([product('landing.html', { kind: 'html' })])).toBe('cover');
  });

  it('keeps rows while the turn is still running, so a second file never collapses a cover', () => {
    expect(cardsLayout([product('landing.html', { kind: 'html', pending: true })])).toBe('rows');
    expect(cardsLayout([product('landing.html', { kind: 'html', sharePending: true })])).toBe('rows');
  });

  it('uses rows for several products and for none', () => {
    expect(cardsLayout([product('a.md'), product('b.md')])).toBe('rows');
    expect(cardsLayout([])).toBe('rows');
  });
});

describe('visibleProducts', () => {
  const items = Array.from({ length: 9 }, (_, index) => `file-${index}`);

  it('shows six and holds the rest back', () => {
    const { visible, hidden } = visibleProducts(items, false);
    expect(visible).toHaveLength(MAX_VISIBLE_PRODUCTS);
    expect(hidden).toBe(3);
  });

  it('shows everything when expanded or when there are six or fewer', () => {
    expect(visibleProducts(items, true)).toEqual({ visible: items, hidden: 0 });
    expect(visibleProducts(items.slice(0, 6), false)).toEqual({ visible: items.slice(0, 6), hidden: 0 });
  });
});

describe('productName', () => {
  it('splits a path into the base name, its stem and its extension', () => {
    expect(productName('reports/2026/复盘.md')).toEqual({ base: '复盘.md', stem: '复盘', extension: '.md' });
    expect(productName('site.tar.gz')).toEqual({ base: 'site.tar.gz', stem: 'site', extension: '.tar.gz' });
  });

  it('keeps names without an extension whole', () => {
    expect(productName('Makefile')).toEqual({ base: 'Makefile', stem: 'Makefile', extension: '' });
    expect(productName('.gitignore')).toEqual({ base: '.gitignore', stem: '.gitignore', extension: '' });
  });
});

describe('productLabel', () => {
  it('follows the card kind for pages, images and clips', () => {
    expect(productLabel('landing.html', 'html')).toBe('page');
    expect(productLabel('logo.svg', 'image')).toBe('image');
    expect(productLabel('clip.mp4', 'video')).toBe('video');
  });

  it('names what a document is to a person', () => {
    expect(productLabel('report.md', 'doc')).toBe('document');
    expect(productLabel('合同.docx', 'doc')).toBe('document');
    expect(productLabel('Q3.pdf', 'doc')).toBe('document');
    expect(productLabel('数据.xlsx', 'doc')).toBe('sheet');
    expect(productLabel('数据.csv', 'doc')).toBe('sheet');
    expect(productLabel('汇报.pptx', 'doc')).toBe('slides');
    expect(productLabel('roast.py', 'doc')).toBe('code');
    expect(productLabel('config.yaml', 'doc')).toBe('data');
    expect(productLabel('notes.txt', 'doc')).toBe('text');
    expect(productLabel('素材.zip', 'doc')).toBe('archive');
    expect(productLabel('方块.glb', 'doc')).toBe('model');
    expect(productLabel('scan.tiff', 'doc')).toBe('image');
  });

  it('falls back to "file" for a type nobody knows', () => {
    expect(productLabel('未知格式.dat', 'doc')).toBe('file');
  });
});

describe('productFace', () => {
  it('draws the picture of anything the browser decodes by itself', () => {
    expect(productFace('poster.png', 'image')).toBe('image');
    expect(productFace('图标.ico', 'doc')).toBe('image');
    expect(productFace('海报.bmp', 'doc')).toBe('image');
    expect(productFace('clip.m4v', 'doc')).toBe('video');
  });

  it('gives a document cover to pictures and clips that need a decoder', () => {
    expect(productFace('海报.heic', 'doc')).toBe('document');
    expect(productFace('海报.psd', 'doc')).toBe('document');
    expect(productFace('片段.avi', 'doc')).toBe('document');
    expect(productFace('report.md', 'doc')).toBe('document');
  });

  it('keeps pages on the page face', () => {
    expect(productFace('landing.html', 'html')).toBe('page');
  });
});

describe('picture fit', () => {
  it('shows vector and icon pictures whole in a tile and lets photographs fill it', () => {
    expect(tileImageFit('logo.svg')).toBe('contain');
    expect(tileImageFit('图标.ico')).toBe('contain');
    expect(tileImageFit('海报.jpg')).toBe('cover');
  });

  it('fills the cover only when the picture is close to its shape', () => {
    expect(coverMediaFit(undefined)).toBe('contain');
    expect(coverMediaFit({ width: 960, height: 640 })).toBe('cover'); // 3:2
    expect(coverMediaFit({ width: 1920, height: 1080 })).toBe('cover'); // 16:9
    expect(coverMediaFit({ width: 1200, height: 1600 })).toBe('contain'); // portrait poster
    expect(coverMediaFit({ width: 800, height: 600 })).toBe('contain'); // 4:3
    expect(coverMediaFit({ width: 2400, height: 800 })).toBe('contain'); // banner
  });
});

describe('productFacts', () => {
  it('gives a picture its pixel size and leaves the byte size out', () => {
    expect(productFacts({ face: 'image', measure: { width: 960, height: 640 }, size: '48 KB' })).toEqual(['960 × 640']);
  });

  it('falls back to the size on disk until the picture has been measured', () => {
    expect(productFacts({ face: 'image', size: '48 KB' })).toEqual(['48 KB']);
  });

  it('gives a clip its length and its size', () => {
    expect(productFacts({ face: 'video', measure: { width: 1280, height: 720, duration: 6.2 }, size: '2.3 MB' })).toEqual(['0:06', '2.3 MB']);
  });

  it('gives pages and documents their size, and nothing when it is not known', () => {
    expect(productFacts({ face: 'page', size: '12 KB' })).toEqual(['12 KB']);
    expect(productFacts({ face: 'document' })).toEqual([]);
  });

  it('never lends the current file size to a frozen snapshot', () => {
    expect(productFacts({ face: 'image', size: '48 KB', snapshot: true })).toEqual([]);
    expect(productFacts({ face: 'image', measure: { width: 10, height: 20 }, size: '48 KB', snapshot: true })).toEqual(['10 × 20']);
  });
});

describe('excerptStyle and coverReadsText', () => {
  it('sets markdown and prose as text, code and data in a fixed-width face', () => {
    expect(excerptStyle('report.md')).toBe('markdown');
    expect(excerptStyle('notes.txt')).toBe('prose');
    expect(excerptStyle('roast.py')).toBe('mono');
    expect(excerptStyle('订单.json')).toBe('mono');
    expect(excerptStyle('数据.csv')).toBe('mono');
  });

  it('has no text for binary and unknown files', () => {
    expect(excerptStyle('合同.docx')).toBeNull();
    expect(excerptStyle('Q3.pdf')).toBeNull();
    expect(excerptStyle('数据.xlsx')).toBeNull();
    expect(excerptStyle('未知格式.dat')).toBeNull();
  });

  it('reads only text files that are listed, non-empty and small enough', () => {
    expect(coverReadsText('report.md', 1200)).toBe(true);
    expect(coverReadsText('report.md', undefined)).toBe(false);
    expect(coverReadsText('report.md', 0)).toBe(false);
    expect(coverReadsText('report.md', EXCERPT_MAX_BYTES + 1)).toBe(false);
    expect(coverReadsText('合同.docx', 1200)).toBe(false);
  });
});

describe('coverExcerpt', () => {
  it('takes a markdown document’s first heading as the title and drops the marks', () => {
    const excerpt = coverExcerpt(
      [
        '---',
        'title: ignored',
        '---',
        '',
        '# 订阅业务第三季度复盘',
        '',
        '本季度净增 **1,284** 人，详见[看板](https://example.com)和 `数据.xlsx`。',
        '',
        '## 关键数字',
        '',
        '| 指标 | Q2 | Q3 |',
        '| --- | --- | --- |',
        '| 续订率 | 81% | 86% |',
        '',
        '- 首屏放了「跳过一次」',
        '- [x] 客服排班调整',
        '> 目标：活跃订阅 9,000',
        '```ts',
        'const a = 1;',
        '```',
      ].join('\n'),
      'markdown',
    );
    expect(excerpt.title).toBe('订阅业务第三季度复盘');
    expect(excerpt.lines).toEqual([
      { text: '本季度净增 1,284 人，详见看板和 数据.xlsx。' },
      { text: '关键数字', heading: true },
      { text: '指标  ·  Q2  ·  Q3' },
      { text: '续订率  ·  81%  ·  86%' },
      { text: '· 首屏放了「跳过一次」' },
      { text: '☑ 客服排班调整' },
      { text: '目标：活跃订阅 9,000' },
      { text: 'const a = 1;' },
    ]);
  });

  it('has no title when the markdown does not open with a heading', () => {
    const excerpt = coverExcerpt('先有一段话。\n\n# 后面的标题', 'markdown');
    expect(excerpt.title).toBeNull();
    expect(excerpt.lines).toEqual([{ text: '先有一段话。' }, { text: '后面的标题', heading: true }]);
  });

  it('keeps indentation for code and collapses runs of blank lines', () => {
    const excerpt = coverExcerpt('\n\ndef roast(beans):\n\treturn beans\n\n\n\nprint(roast(1))\n', 'mono');
    expect(excerpt.title).toBeNull();
    expect(excerpt.lines.map((line) => line.text)).toEqual(['def roast(beans):', '  return beans', '', 'print(roast(1))']);
  });

  it('trims prose lines and drops blank ones', () => {
    const excerpt = coverExcerpt('﻿  第一行  \r\n\r\n第二行\r\n', 'prose');
    expect(excerpt.lines.map((line) => line.text)).toEqual(['第一行', '第二行']);
  });

  it('stops after a handful of lines and cuts very long ones', () => {
    const long = `${'字'.repeat(300)}\n`.repeat(40);
    const excerpt = coverExcerpt(long, 'prose');
    expect(excerpt.lines.length).toBeLessThanOrEqual(9);
    expect(excerpt.lines[0]?.text.length).toBeLessThanOrEqual(96);
    expect(excerpt.lines[0]?.text.endsWith('…')).toBe(true);
  });

  it('returns nothing for an empty file', () => {
    expect(coverExcerpt('', 'markdown')).toEqual({ title: null, lines: [] });
    expect(coverExcerpt('\n\n', 'mono')).toEqual({ title: null, lines: [] });
  });
});
