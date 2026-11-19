// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/pdfLayout.test.ts @ c5e6b24f (MIT): the find
// cases (a word split across spans, a space matching a line end, a word hyphenated across a line
// end, quotes, blank queries). Changed here: they assert exact ranges instead of "which spans hold a
// match", and add Chinese text that wraps, counting and stepping.
import { describe, expect, it } from 'vitest';

import { pdfFindMatches, pdfFindOrdinal, pdfFindStep, pdfTextRuns, unifyCjkRadicals } from '../../../src/fantay/artifact/viewers/pdf/pdf-find';

/** The text a match covers, read back from the runs the way the viewer builds a DOM range. */
function covered(runs: readonly string[], query: string): string[] {
  return pdfFindMatches(runs, query).map((match) => {
    if (match.startRun === match.endRun) return (runs[match.startRun] ?? '').slice(match.startOffset, match.endOffset);
    let text = (runs[match.startRun] ?? '').slice(match.startOffset);
    for (let run = match.startRun + 1; run < match.endRun; run += 1) text += runs[run] ?? '';
    return text + (runs[match.endRun] ?? '').slice(0, match.endOffset);
  });
}

describe('pdfTextRuns', () => {
  it('keeps text items in order, marks line ends and skips marked content', () => {
    expect(
      pdfTextRuns([
        { str: 'Quarter', hasEOL: false },
        { type: 'beginMarkedContent' },
        { str: 'ly outlook', hasEOL: true },
        { str: 'Next', hasEOL: false },
      ]),
    ).toEqual(['Quarter', 'ly outlook\n', 'Next']);
  });
});

describe('pdfFindMatches', () => {
  it('finds a word that pdf.js split across two spans, as one exact range', () => {
    const runs = ['Quarter', 'ly outlook', ' for Q3'];
    expect(pdfFindMatches(runs, 'quarterly OUTLOOK')).toEqual([{ startRun: 0, startOffset: 0, endRun: 1, endOffset: 10 }]);
    expect(covered(runs, 'terly out')).toEqual(['terly out']);
  });

  it('finds every separate occurrence, without overlaps', () => {
    const runs = ['risk', ' and ', 'budget', ' ', 'Risk'];
    expect(pdfFindMatches(runs, 'risk')).toEqual([
      { startRun: 0, startOffset: 0, endRun: 0, endOffset: 4 },
      { startRun: 4, startOffset: 0, endRun: 4, endOffset: 4 },
    ]);
    expect(pdfFindMatches(['aaaa'], 'aa')).toHaveLength(2);
  });

  it('lets a space in the query match a line end', () => {
    const runs = ['Q3 quarterly\n', 'outlook ahead'];
    expect(pdfFindMatches(runs, 'quarterly outlook')).toEqual([{ startRun: 0, startOffset: 3, endRun: 1, endOffset: 7 }]);
    expect(pdfFindMatches(runs, 'quarterly   outlook')).toHaveLength(1);
  });

  it('finds a word hyphenated across a line end', () => {
    const runs = ['the quar-\n', 'terly report'];
    expect(pdfFindMatches(runs, 'quarterly')).toEqual([{ startRun: 0, startOffset: 4, endRun: 1, endOffset: 5 }]);
    // A real hyphen stays a hyphen.
    expect(pdfFindMatches(['well-known fact'], 'well-known')).toHaveLength(1);
    expect(pdfFindMatches(['well-known fact'], 'wellknown')).toHaveLength(0);
  });

  it('drops a line-end hyphen after a letter outside the BMP', () => {
    const runs = ['\u{10400}-\n', '\u{10401}'];
    expect(pdfFindMatches(runs, '\u{10400}\u{10401}')).toEqual([{ startRun: 0, startOffset: 0, endRun: 1, endOffset: 2 }]);
  });

  it('finds Chinese text that wraps onto the next line', () => {
    const runs = ['本季度订阅用户从 5,310 增长到 6,550，续订\n', '率由 71% 提升到 78%。'];
    expect(covered(runs, '续订率')).toEqual(['续订\n率']);
    expect(pdfFindMatches(runs, '续订率')).toEqual([{ startRun: 0, startOffset: (runs[0] ?? '').indexOf('续订'), endRun: 1, endOffset: 1 }]);
    // Between Latin words the same line end is a space.
    expect(pdfFindMatches(['first crack\n', 'moved'], 'crackmoved')).toHaveLength(0);
    expect(pdfFindMatches(['first crack\n', 'moved'], 'crack moved')).toHaveLength(1);
  });

  it('ignores the spaces a justified line puts between Chinese characters', () => {
    // pdf.js reports a spread-out line glyph by glyph, with a space wherever the gap is wide.
    const runs = ['同比增长 23%。续 订 ', '率 由 71% 提升到 78%'];
    expect(covered(runs, '续订率')).toEqual(['续 订 率']);
    // The same holds for a query typed with spaces, and a space next to a digit still counts.
    expect(covered(runs, '续 订率')).toEqual(['续 订 率']);
    expect(covered(runs, '增长 23%')).toEqual(['增长 23%']);
    expect(pdfFindMatches(runs, '增长23%')).toHaveLength(0);
  });

  it('finds a word whose characters the font filed under their radical twins', () => {
    // What a PDF printed from a browser on macOS really holds for "口径说明" and "西南": U+2F1D (Kangxi
    // radical mouth) for U+53E3, U+2EC4 (CJK radical west) for U+897F. They look the same and are not.
    const runs = ['\u2f1d径说明：续订率', '，\u2ec4南因为转运节点调整，\u2f17\u2f49起改\u2f64成都分仓'];
    expect(covered(runs, '口径说明')).toEqual(['\u2f1d径说明']);
    expect(covered(runs, '西南')).toEqual(['\u2ec4南']);
    expect(covered(runs, '十月起改用')).toEqual(['\u2f17\u2f49起改\u2f64']);
    // And the other way round: a query pasted from such a PDF finds ordinary text.
    expect(covered(['十月起改用成都分仓'], '\u2f17\u2f49')).toEqual(['十月']);
  });

  it('treats full-width letters and digits, and ligatures, as their plain forms', () => {
    expect(covered(['订单号 \uff21\uff22\uff11\uff12\uff13'], 'ab123')).toEqual(['\uff21\uff22\uff11\uff12\uff13']);
    expect(covered(['the of\ufb01ce \ufb02oor'], 'office floor')).toEqual(['of\ufb01ce \ufb02oor']);
    expect(pdfFindMatches(['office'], 'of\ufb01ce')).toHaveLength(1);
  });

  it('matches straight quotes typed for typeset curly ones', () => {
    const runs = ['We don’t ', 'ship “beta”'];
    expect(covered(runs, "don't")).toEqual(['don’t']);
    expect(covered(runs, '"beta"')).toEqual(['“beta”']);
    expect(pdfFindMatches(["We don't ship"], 'don’t')).toHaveLength(1);
  });

  it('ignores case, also where lower-casing changes the length', () => {
    expect(covered(['RENEWAL Rate'], 'renewal rate')).toEqual(['RENEWAL Rate']);
    expect(covered(['İstanbul office'], 'office')).toEqual(['office']);
  });

  it('finds nothing for a blank or missing query', () => {
    expect(pdfFindMatches(['a b', 'c'], ' ')).toEqual([]);
    expect(pdfFindMatches(['a b', 'c'], '')).toEqual([]);
    expect(pdfFindMatches(['a b', 'c'], 'zzz')).toEqual([]);
    expect(pdfFindMatches([], 'a')).toEqual([]);
  });
});

describe('unifyCjkRadicals', () => {
  it('turns radical code points into the characters they stand for', () => {
    expect(unifyCjkRadicals('\u2f1d径说明')).toBe('口径说明');
    expect(unifyCjkRadicals('\u2ec4南、\u2ed3江、\u2ed4\u2f1d、\u2ee2\u2ecb、\u2edb\u2f54')).toBe('西南、长江、门口、马车、风水');
    expect(unifyCjkRadicals('\u2f00\u2f06\u2f17')).toBe('一二十');
  });

  it('leaves everything else alone, punctuation and width included', () => {
    const text = '续订率（78%）：Ａ１，“好”…… ﬁne ²';
    expect(unifyCjkRadicals(text)).toBe(text);
    expect(unifyCjkRadicals('')).toBe('');
  });

  it('maps every radical of both blocks to a character outside them', () => {
    for (let code = 0x2f00; code <= 0x2fd5; code += 1) {
      const unified = unifyCjkRadicals(String.fromCharCode(code));
      expect(unified.charCodeAt(0) < 0x2e80 || unified.charCodeAt(0) > 0x2fdf, code.toString(16)).toBe(true);
    }
    // The supplement block: the forms that are whole characters must all be covered.
    for (const [radical, character] of [
      ['\u2ec4', '西'], ['\u2ec5', '见'], ['\u2ec6', '角'], ['\u2ec9', '贝'], ['\u2ecb', '车'], ['\u2ed3', '长'], ['\u2ed4', '门'],
      ['\u2ed8', '青'], ['\u2eda', '页'], ['\u2edb', '风'], ['\u2edc', '飞'], ['\u2edd', '食'], ['\u2ee2', '马'], ['\u2ee3', '骨'],
      ['\u2ee4', '鬼'], ['\u2ee5', '鱼'], ['\u2ee6', '鸟'], ['\u2ee8', '麦'], ['\u2ee9', '黄'], ['\u2eec', '齐'], ['\u2eee', '齿'],
      ['\u2ef0', '龙'], ['\u2ef3', '龟'], ['\u2e9f', '母'], ['\u2ea0', '民'],
    ] as const) {
      expect(unifyCjkRadicals(radical), radical.charCodeAt(0).toString(16)).toBe(character);
    }
  });
});

describe('stepping through the occurrences', () => {
  const counts = new Map([
    [2, 3],
    [7, 1],
    [9, 2],
  ]);

  it('starts at the first or the last one', () => {
    expect(pdfFindStep(counts, null, 1)).toEqual({ page: 2, index: 0 });
    expect(pdfFindStep(counts, null, -1)).toEqual({ page: 9, index: 1 });
    expect(pdfFindStep(new Map(), null, 1)).toBeNull();
    expect(pdfFindStep(new Map([[4, 0]]), null, 1)).toBeNull();
  });

  it('moves inside a page, then to the next page with results, then wraps', () => {
    expect(pdfFindStep(counts, { page: 2, index: 0 }, 1)).toEqual({ page: 2, index: 1 });
    expect(pdfFindStep(counts, { page: 2, index: 2 }, 1)).toEqual({ page: 7, index: 0 });
    expect(pdfFindStep(counts, { page: 9, index: 1 }, 1)).toEqual({ page: 2, index: 0 });
    expect(pdfFindStep(counts, { page: 7, index: 0 }, -1)).toEqual({ page: 2, index: 2 });
    expect(pdfFindStep(counts, { page: 2, index: 0 }, -1)).toEqual({ page: 9, index: 1 });
  });

  it('numbers an occurrence by everything before it', () => {
    expect(pdfFindOrdinal(counts, null)).toBe(0);
    expect(pdfFindOrdinal(counts, { page: 2, index: 0 })).toBe(1);
    expect(pdfFindOrdinal(counts, { page: 7, index: 0 })).toBe(4);
    expect(pdfFindOrdinal(counts, { page: 9, index: 1 })).toBe(6);
  });
});
