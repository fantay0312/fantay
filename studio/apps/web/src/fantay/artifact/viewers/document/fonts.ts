// SPDX-License-Identifier: AGPL-3.0-only
// A Word document names the fonts of the machine it was written on (宋体, 微软雅黑, Calibri). Where
// that font is missing, the browser would fall back to its default face, so a Chinese document
// written on Windows would be set in the wrong style on a Mac. This appends, after each named font,
// the fonts that stand in for it on other systems, then a generic family. The named font still wins
// wherever it is installed. Pure: no DOM.

type Generic = 'serif' | 'sans-serif' | 'monospace';

interface Substitute {
  fallbacks: readonly string[];
  generic: Generic;
}

const SONG: Substitute = { fallbacks: ['Songti SC', 'STSong', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'], generic: 'serif' };
const HEI: Substitute = { fallbacks: ['PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Noto Sans CJK SC', 'Source Han Sans SC'], generic: 'sans-serif' };
const KAI: Substitute = { fallbacks: ['Kaiti SC', 'STKaiti', 'KaiTi', 'Songti SC'], generic: 'serif' };
const FANGSONG: Substitute = { fallbacks: ['STFangsong', 'FangSong', 'Songti SC'], generic: 'serif' };
const MING_TC: Substitute = { fallbacks: ['Songti TC', 'PMingLiU', 'Noto Serif CJK TC'], generic: 'serif' };
const HEI_TC: Substitute = { fallbacks: ['PingFang TC', 'Microsoft JhengHei', 'Noto Sans CJK TC'], generic: 'sans-serif' };
const MINCHO: Substitute = { fallbacks: ['Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif CJK JP'], generic: 'serif' };
const GOTHIC: Substitute = { fallbacks: ['Hiragino Sans', 'Yu Gothic', 'Noto Sans CJK JP'], generic: 'sans-serif' };
const KOREAN: Substitute = { fallbacks: ['Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans CJK KR'], generic: 'sans-serif' };
const SANS: Substitute = { fallbacks: ['Carlito', 'Helvetica Neue', 'Arial'], generic: 'sans-serif' };
const SERIF: Substitute = { fallbacks: ['Caladea', 'Georgia', 'Times New Roman'], generic: 'serif' };
const TIMES: Substitute = { fallbacks: ['Times', 'Liberation Serif'], generic: 'serif' };
const ARIAL: Substitute = { fallbacks: ['Helvetica', 'Liberation Sans'], generic: 'sans-serif' };
const MONO: Substitute = { fallbacks: ['Menlo', 'Consolas', 'Courier New'], generic: 'monospace' };

/** Keys are lower-case font names as Office writes them (both the Chinese and the Latin name). */
const SUBSTITUTES: ReadonlyMap<string, Substitute> = new Map<string, Substitute>([
  ...['宋体', 'simsun', '新宋体', 'nsimsun', '华文宋体', 'stsong', '华文中宋', 'stzhongsong', 'songti sc', '宋体-简', '思源宋体', 'source han serif sc', 'noto serif cjk sc', '方正书宋简体', '方正小标宋简体'].map(
    (name) => [name, SONG] as const,
  ),
  ...['黑体', 'simhei', '微软雅黑', 'microsoft yahei', 'microsoft yahei ui', '等线', 'dengxian', '等线 light', 'dengxian light', '华文黑体', 'stheiti', '华文细黑', 'stxihei', '苹方-简', 'pingfang sc', '思源黑体', 'source han sans sc', 'noto sans cjk sc', '方正黑体简体'].map(
    (name) => [name, HEI] as const,
  ),
  ...['楷体', 'kaiti', '楷体_gb2312', 'kaiti_gb2312', '华文楷体', 'stkaiti', '方正楷体简体'].map((name) => [name, KAI] as const),
  ...['仿宋', 'fangsong', '仿宋_gb2312', 'fangsong_gb2312', '华文仿宋', 'stfangsong', '方正仿宋简体'].map((name) => [name, FANGSONG] as const),
  ...['新細明體', 'pmingliu', '細明體', 'mingliu', '新细明体', '细明体'].map((name) => [name, MING_TC] as const),
  ...['微軟正黑體', 'microsoft jhenghei', '微软正黑体'].map((name) => [name, HEI_TC] as const),
  ...['ms mincho', 'ｍｓ 明朝', 'ms pmincho', 'ｍｓ ｐ明朝', 'yu mincho', '游明朝'].map((name) => [name, MINCHO] as const),
  ...['ms gothic', 'ｍｓ ゴシック', 'ms pgothic', 'ｍｓ ｐゴシック', 'meiryo', 'メイリオ', 'yu gothic', '游ゴシック'].map((name) => [name, GOTHIC] as const),
  ...['malgun gothic', '맑은 고딕', 'batang', '바탕', 'gulim', '굴림'].map((name) => [name, KOREAN] as const),
  ...['calibri', 'calibri light', 'aptos', 'aptos display', 'segoe ui', 'tahoma', 'verdana', 'trebuchet ms', 'century gothic', 'corbel', 'candara'].map(
    (name) => [name, SANS] as const,
  ),
  ...['cambria', 'cambria math', 'constantia', 'garamond', 'book antiqua', 'palatino linotype', 'century', 'georgia'].map((name) => [name, SERIF] as const),
  ...['times new roman', 'times'].map((name) => [name, TIMES] as const),
  ...['arial', 'helvetica', 'arial narrow'].map((name) => [name, ARIAL] as const),
  ...['consolas', 'courier new', 'courier', 'lucida console'].map((name) => [name, MONO] as const),
]);

const GENERICS = new Set(['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'ui-serif', 'ui-sans-serif', 'ui-monospace', 'math', 'emoji', 'fangsong']);

/** Splits a `font-family` value on commas that are not inside quotes or parentheses. */
export function splitFamilies(value: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote = '';
  let depth = 0;
  for (const char of value) {
    if (quote) {
      if (char === quote) quote = '';
      current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === '(') {
      depth += 1;
      current += char;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
      current += char;
    } else if (char === ',' && depth === 0) {
      if (current.trim()) families.push(current.trim());
      current = '';
    } else current += char;
  }
  if (current.trim()) families.push(current.trim());
  return families;
}

function bareName(family: string): string {
  return family.replace(/^["']|["']$/g, '').trim();
}

function quoted(name: string): string {
  return `"${name.replaceAll('"', '')}"`;
}

/**
 * The same family list with stand-ins after each known font. With `generic` (the default) a generic
 * family closes the list; pass false for a value that is substituted into the middle of a longer
 * list (a theme font variable), where a generic would hide the fonts that follow it.
 */
export function withFontFallbacks(value: string, generic = true): string {
  const families = splitFamilies(value);
  if (families.length === 0) return value;
  const out: string[] = [];
  const seen = new Set<string>();
  let closing: Generic | null = null;
  let hasGeneric = false;
  const add = (family: string, key: string): void => {
    if (seen.has(key)) return;
    seen.add(key);
    out.push(family);
  };
  for (const family of families) {
    const name = bareName(family);
    const key = name.toLowerCase();
    if (GENERICS.has(key)) {
      hasGeneric = true;
      add(key, key);
      continue;
    }
    add(family, key);
    const substitute = SUBSTITUTES.get(key);
    if (!substitute) continue;
    for (const fallback of substitute.fallbacks) add(quoted(fallback), fallback.toLowerCase());
    closing ??= substitute.generic;
  }
  if (generic && !hasGeneric) out.push(closing ?? 'sans-serif');
  return out.join(', ');
}
