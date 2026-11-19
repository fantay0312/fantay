// SPDX-License-Identifier: AGPL-3.0-only
// What the font specimen shows: the default sample line and the glyph grid, both chosen by what the
// font can actually draw, so a Chinese font opens on Chinese, a Latin font on a pangram and an icon
// font on its own glyphs. Pure: it is handed a "can the font draw this" test and never touches the
// DOM, so the same code serves fonts whose tables were read and fonts that had to be measured.

/** Does the font have a glyph for this code point. */
export type GlyphTest = (codePoint: number) => boolean;

export type GlyphSectionId = 'latin' | 'digits' | 'accents' | 'greekCyrillic' | 'kana' | 'cjk' | 'symbols' | 'other';

export interface GlyphSection {
  id: GlyphSectionId;
  /** The characters shown, in display order. */
  chars: string[];
  /** How many characters of this kind the font has in all, when known and larger than what is shown. */
  total: number | null;
}

const SECTION_LIMIT = 96;
const CJK_LIMIT = 140;

/** Common Chinese characters, most frequent first: a font with any Chinese at all has these. */
const COMMON_CJK =
  '的一是在不了有和人这中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题党程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞';

/** Sample lines for a font with Chinese, tried in order: the first the font can draw in full is used. */
const CJK_LINES = ['永和九年，岁在癸丑，暮春之初', '天地玄黄，宇宙洪荒', '山高月小，水落石出', '中文字体'];
const LATIN_LINE = 'The quick brown fox jumps over the lazy dog';
const KANA_LINE = 'いろはにほへと ちりぬるを';

function range(from: number, to: number): number[] {
  const out: number[] = [];
  for (let code = from; code <= to; code += 1) out.push(code);
  return out;
}

const SETS: Record<Exclude<GlyphSectionId, 'cjk' | 'other'>, readonly number[]> = {
  latin: [...range(0x41, 0x5a), ...range(0x61, 0x7a)],
  digits: [...range(0x30, 0x39), ...range(0x21, 0x2f), ...range(0x3a, 0x40), ...range(0x5b, 0x60), ...range(0x7b, 0x7e)],
  accents: [...range(0xc0, 0xd6), ...range(0xd8, 0xf6), ...range(0xf8, 0xff), ...range(0x100, 0x17f)],
  greekCyrillic: [...range(0x391, 0x3a1), ...range(0x3a3, 0x3a9), ...range(0x3b1, 0x3c9), ...range(0x410, 0x44f)],
  kana: [...range(0x3041, 0x3096), ...range(0x30a1, 0x30fa)],
  symbols: [
    ...range(0xa1, 0xbf),
    0xd7,
    0xf7,
    ...range(0x2010, 0x2027),
    ...range(0x2030, 0x205e),
    ...range(0x20a0, 0x20bf),
    ...range(0x2100, 0x214f),
    ...range(0x2190, 0x21ff),
    ...range(0x2200, 0x22ff),
    ...range(0x25a0, 0x25ff),
    ...range(0x2600, 0x26ff),
    ...range(0x2700, 0x27bf),
    ...range(0x3001, 0x3011),
    ...range(0xff01, 0xff0f),
  ],
};

const ORDER: readonly Exclude<GlyphSectionId, 'cjk' | 'other'>[] = ['latin', 'digits', 'accents', 'greekCyrillic', 'kana', 'symbols'];

function canDraw(has: GlyphTest, text: string): boolean {
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code !== 0x20 && !has(code)) return false;
  }
  return true;
}

/** Characters that are not worth a grid cell: controls, spaces and other invisibles. */
export function isVisibleCodePoint(code: number): boolean {
  if (code <= 0x20 || (code >= 0x7f && code <= 0xa0) || code === 0xad) return false;
  if (code >= 0x2000 && code <= 0x200f) return false;
  if (code >= 0x2028 && code <= 0x202f) return false;
  if (code >= 0x205f && code <= 0x206f) return false;
  if (code === 0x3000 || code === 0xfeff || (code >= 0xfe00 && code <= 0xfe0f)) return false;
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return true;
}

export interface SpecimenInput {
  has: GlyphTest;
  /** Characters the font has, lowest first, for fonts that draw none of the usual sets (icon fonts). */
  firstCovered?(limit: number): number[];
  /** How many of [from, to] the font covers, when its tables were read. */
  countIn?(from: number, to: number): number;
}

/** The glyph grid: one section per script the font can draw, each capped. */
export function glyphSections({ has, firstCovered, countIn }: SpecimenInput): GlyphSection[] {
  const sections: GlyphSection[] = [];
  for (const id of ORDER) {
    const covered = SETS[id].filter((code) => has(code));
    if (covered.length === 0) continue;
    sections.push({
      id,
      chars: covered.slice(0, SECTION_LIMIT).map((code) => String.fromCodePoint(code)),
      total: covered.length > SECTION_LIMIT ? covered.length : null,
    });
  }
  // A font with no Chinese at all is told apart by three characters, not by five hundred.
  const hasChinese = has(0x7684) || has(0x4e00) || has(0x4e2d);
  const cjk = hasChinese ? [...COMMON_CJK].filter((char) => has(char.codePointAt(0) ?? 0)) : [];
  if (cjk.length > 0) {
    const shown = Math.min(cjk.length, CJK_LIMIT);
    const all = countIn ? countIn(0x4e00, 0x9fff) + countIn(0x3400, 0x4dbf) : cjk.length;
    sections.push({ id: 'cjk', chars: cjk.slice(0, CJK_LIMIT), total: all > shown ? all : null });
  }
  if (sections.length === 0 && firstCovered) {
    const codes = firstCovered(CJK_LIMIT);
    if (codes.length > 0) sections.push({ id: 'other', chars: codes.map((code) => String.fromCodePoint(code)), total: null });
  }
  // Chinese readers look for the Chinese first.
  const order: GlyphSectionId[] = ['cjk', 'latin', 'digits', 'accents', 'greekCyrillic', 'kana', 'symbols', 'other'];
  return sections.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}

/** The line the specimen opens with: Chinese and Latin when the font has both, else what it has. */
export function defaultSample({ has, firstCovered }: SpecimenInput): string {
  const cjk = CJK_LINES.find((line) => canDraw(has, line));
  const latin = canDraw(has, LATIN_LINE) ? LATIN_LINE : null;
  if (cjk && latin) return `${cjk}${has(0x3002) ? '。' : ' '}${latin}.`;
  if (cjk) return cjk;
  if (latin) return `${latin}.`;
  if (canDraw(has, KANA_LINE)) return KANA_LINE;
  const codes = firstCovered ? firstCovered(64).slice(0, 24) : [];
  return codes.map((code) => String.fromCodePoint(code)).join(' ');
}
