// SPDX-License-Identifier: AGPL-3.0-only
// The font table reader and the specimen's choices, on a small font assembled here: a name table,
// a cmap, OS/2, head, maxp and fvar are enough to check every fact the viewer shows.
import { zlibSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { coverageCount, coverageFirst, coverageHas, readFontFacts, sniffFont } from '../../../src/fantay/artifact/viewers/font/font-file';
import { defaultSample, glyphSections, isVisibleCodePoint, type SpecimenInput } from '../../../src/fantay/artifact/viewers/font/font-specimen';

function bytes(...parts: Array<number[] | Uint8Array>): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const u16 = (value: number): number[] => [(value >> 8) & 0xff, value & 0xff];
const u32 = (value: number): number[] => [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
const tag = (text: string): number[] => [...text].map((char) => char.charCodeAt(0));
const utf16 = (text: string): number[] => [...text].flatMap((char) => u16(char.charCodeAt(0)));

/** A name table with Windows records: [nameId, languageId, text]. */
function nameTable(records: Array<[number, number, string]>): Uint8Array {
  const strings = records.map(([, , text]) => utf16(text));
  const header = [...u16(0), ...u16(records.length), ...u16(6 + records.length * 12)];
  let offset = 0;
  const entries: number[] = [];
  records.forEach(([id, language], index) => {
    const length = strings[index]?.length ?? 0;
    entries.push(...u16(3), ...u16(1), ...u16(language), ...u16(id), ...u16(length), ...u16(offset));
    offset += length;
  });
  return bytes(header, entries, strings.flat());
}

/** A cmap with one format 12 subtable: [startCode, endCode, startGlyph] groups. */
function cmapTable(groups: Array<[number, number, number]>): Uint8Array {
  const subtable = [...u16(12), ...u16(0), ...u32(16 + groups.length * 12), ...u32(0), ...u32(groups.length), ...groups.flatMap((group) => group.flatMap(u32))];
  return bytes([...u16(0), ...u16(1), ...u16(3), ...u16(10), ...u32(12)], subtable);
}

function os2Table(weight: number, italic: boolean): Uint8Array {
  const table = new Uint8Array(78);
  table.set(u16(weight), 4);
  table.set(u16(italic ? 1 : 0), 62);
  return table;
}

function maxpTable(glyphs: number): Uint8Array {
  return bytes(u32(0x00010000), u16(glyphs));
}

function fvarTable(axes: Array<[string, number, number, number]>): Uint8Array {
  const fixed = (value: number): number[] => u32((value * 65536) >>> 0);
  return bytes(
    [...u16(1), ...u16(0), ...u16(16), ...u16(2), ...u16(axes.length), ...u16(20), ...u16(0), ...u16(0)],
    axes.flatMap(([name, min, def, max]) => [...tag(name), ...fixed(min), ...fixed(def), ...fixed(max), ...u16(0), ...u16(256)]),
  );
}

function sfnt(tables: Record<string, Uint8Array>, flavor = 0x00010000): ArrayBuffer {
  const names = Object.keys(tables);
  let offset = 12 + names.length * 16;
  const directory: number[] = [];
  const body: Uint8Array[] = [];
  for (const name of names) {
    const table = tables[name] ?? new Uint8Array(0);
    directory.push(...tag(name), ...u32(0), ...u32(offset), ...u32(table.length));
    body.push(table);
    offset += table.length;
  }
  return bytes([...u32(flavor), ...u16(names.length), ...u16(0), ...u16(0), ...u16(0)], directory, ...body).buffer as ArrayBuffer;
}

function woff(tables: Record<string, Uint8Array>): ArrayBuffer {
  const names = Object.keys(tables);
  let offset = 44 + names.length * 20;
  const directory: number[] = [];
  const body: Uint8Array[] = [];
  for (const name of names) {
    const table = tables[name] ?? new Uint8Array(0);
    const packed = zlibSync(table);
    const stored = packed.length < table.length ? packed : table;
    directory.push(...tag(name), ...u32(offset), ...u32(stored.length), ...u32(table.length), ...u32(0));
    body.push(stored);
    offset += stored.length;
  }
  const header = [...tag('wOFF'), ...u32(0x4f54544f), ...u32(offset), ...u16(names.length), ...u16(0), ...u32(0), ...u16(1), ...u16(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0)];
  return bytes(header, directory, ...body).buffer as ArrayBuffer;
}

const TABLES = {
  name: nameTable([
    [1, 0x0409, 'Roast Sans'],
    [1, 0x0804, '烘焙黑体'],
    [2, 0x0409, 'Bold Italic'],
    [4, 0x0409, 'Roast Sans Bold Italic'],
    [5, 0x0409, 'Version 2.010;hotconv 1.0'],
    [9, 0x0409, 'Roast Studio'],
    [13, 0x0409, 'SIL Open Font License 1.1'],
  ]),
  cmap: cmapTable([
    [0x20, 0x7e, 1],
    [0x4e00, 0x4e09, 200],
    [0x6c38, 0x6c38, 300],
    [0x7684, 0x7684, 301],
  ]),
  'OS/2': os2Table(700, true),
  maxp: maxpTable(321),
  fvar: fvarTable([['wght', 100, 400, 900]]),
};

describe('sniffFont', () => {
  it('tells font containers apart and rejects everything else', () => {
    expect(sniffFont(sfnt(TABLES))).toBe('sfnt');
    expect(sniffFont(sfnt(TABLES, 0x4f54544f))).toBe('sfnt');
    expect(sniffFont(woff(TABLES))).toBe('woff');
    expect(sniffFont(bytes(tag('wOF2'), new Uint8Array(40)).buffer as ArrayBuffer)).toBe('woff2');
    expect(sniffFont(bytes(tag('ttcf'), new Uint8Array(40)).buffer as ArrayBuffer)).toBe('collection');
    expect(sniffFont(new TextEncoder().encode('This is not a font at all.').buffer as ArrayBuffer)).toBeNull();
    expect(sniffFont(new ArrayBuffer(4))).toBeNull();
  });
});

describe('readFontFacts', () => {
  it('reads names, weight, style, glyph count and axes', () => {
    const facts = readFontFacts(sfnt(TABLES), 'zh-CN');
    expect(facts).toMatchObject({
      container: 'sfnt',
      outlines: 'truetype',
      weight: 700,
      italic: true,
      glyphCount: 321,
      axes: [{ tag: 'wght', min: 100, default: 400, max: 900 }],
    });
    expect(facts?.names).toMatchObject({
      family: 'Roast Sans',
      localizedFamily: '烘焙黑体',
      subfamily: 'Bold Italic',
      fullName: 'Roast Sans Bold Italic',
      version: '2.010',
      designer: 'Roast Studio',
      license: 'SIL Open Font License 1.1',
    });
  });

  it('reports a localized family only for a reader who would want it', () => {
    expect(readFontFacts(sfnt(TABLES), 'en')?.names.localizedFamily).toBeNull();
  });

  it('reads the character map as ranges', () => {
    const coverage = readFontFacts(sfnt(TABLES))?.coverage;
    expect(coverage?.count).toBe(95 + 10 + 2);
    if (!coverage) return;
    expect(coverageHas(coverage, 0x41)).toBe(true);
    expect(coverageHas(coverage, 0x4e05)).toBe(true);
    expect(coverageHas(coverage, 0x4e0a)).toBe(false);
    expect(coverageHas(coverage, 0x1f600)).toBe(false);
    expect(coverageCount(coverage, 0x4e00, 0x9fff)).toBe(12);
    expect(coverageFirst(coverage, 3, isVisibleCodePoint)).toEqual([0x21, 0x22, 0x23]);
  });

  it('reads the same facts out of a WOFF, whose tables are compressed', () => {
    const facts = readFontFacts(woff(TABLES), 'zh-CN');
    expect(facts).toMatchObject({ container: 'woff', outlines: 'cff', weight: 700, glyphCount: 321 });
    expect(facts?.names.family).toBe('Roast Sans');
    expect(facts?.coverage?.count).toBe(107);
  });

  it('says only what it knows about a WOFF2 and a collection', () => {
    const packed = readFontFacts(bytes(tag('wOF2'), u32(0x00010000), new Uint8Array(40)).buffer as ArrayBuffer);
    expect(packed).toMatchObject({ container: 'woff2', outlines: 'truetype', coverage: null, glyphCount: null });
    expect(packed?.names.family).toBeNull();
    expect(readFontFacts(bytes(tag('ttcf'), new Uint8Array(40)).buffer as ArrayBuffer)?.container).toBe('collection');
  });

  it('survives tables that are cut short or lie about their size', () => {
    const cut = sfnt({ ...TABLES, name: TABLES.name.slice(0, 20), cmap: TABLES.cmap.slice(0, 18) });
    const facts = readFontFacts(cut);
    expect(facts?.container).toBe('sfnt');
    expect(facts?.weight).toBe(700);
    const truncated = sfnt(TABLES).slice(0, 200);
    expect(() => readFontFacts(truncated)).not.toThrow();
    expect(readFontFacts(new TextEncoder().encode('plain text, not a font').buffer as ArrayBuffer)).toBeNull();
  });
});

describe('specimen', () => {
  const input = (chars: string): SpecimenInput => {
    const set = new Set([...chars].map((char) => char.codePointAt(0) ?? 0));
    return { has: (code) => set.has(code), firstCovered: (limit) => [...set].sort((a, b) => a - b).filter(isVisibleCodePoint).slice(0, limit) };
  };
  const latin = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.,';

  it('opens a Latin font on a pangram', () => {
    expect(defaultSample(input(latin))).toBe('The quick brown fox jumps over the lazy dog.');
  });

  it('opens a Chinese font on Chinese, with Latin after it when it has both', () => {
    const chinese = '永和九年，岁在癸丑暮春之初的一是。';
    expect(defaultSample(input(chinese))).toBe('永和九年，岁在癸丑，暮春之初');
    expect(defaultSample(input(chinese + latin))).toBe('永和九年，岁在癸丑，暮春之初。The quick brown fox jumps over the lazy dog.');
  });

  it('opens an icon font on its own glyphs', () => {
    expect(defaultSample(input(''))).toBe('  ');
  });

  it('groups the glyph grid by script and puts Chinese first', () => {
    const sections = glyphSections(input(`${latin}的一是在αβ←→`));
    expect(sections.map((section) => section.id)).toEqual(['cjk', 'latin', 'digits', 'greekCyrillic', 'symbols']);
    expect(sections[0]?.chars).toEqual(['的', '一', '是', '在']);
    expect(sections[1]?.chars).toHaveLength(52);
  });

  it('falls back to the font\'s first glyphs when it has none of the usual sets', () => {
    const sections = glyphSections(input(''));
    expect(sections).toEqual([{ id: 'other', chars: ['', ''], total: null }]);
  });

  it('counts all the Chinese a font has, not only what the grid shows', () => {
    const cjk = glyphSections({ has: (code) => code >= 0x4e00 && code <= 0x9fff, countIn: (from, to) => (from === 0x4e00 ? to - from + 1 : 0) }).find(
      (section) => section.id === 'cjk',
    );
    expect(cjk?.chars).toHaveLength(140);
    expect(cjk?.total).toBe(0x9fff - 0x4e00 + 1);
  });
});
