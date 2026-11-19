// SPDX-License-Identifier: AGPL-3.0-only
// What a font file says about itself: its names, weight, glyph count, variable axes and the
// characters it can draw. Read straight from the font's tables (name, OS/2, head, maxp, fvar, cmap)
// so the viewer needs no font library; the browser's own font loader still does the drawing.
// The file is untrusted: every offset is checked against the table, loops are bounded by table
// sizes, and a table that does not parse simply leaves its facts out.
// WOFF tables are inflated one at a time through fflate. WOFF2 packs its tables with Brotli, which
// neither the browser nor an installed package can unpack here, so a WOFF2 file reports its
// container only and the viewer finds out what it can draw by measuring.
// Pure: no DOM.
import { unzlibSync } from 'fflate';

export type FontContainer = 'sfnt' | 'woff' | 'woff2' | 'collection';

export interface FontAxis {
  tag: string;
  min: number;
  default: number;
  max: number;
}

export interface FontNames {
  family: string | null;
  /** The family name in the reader's language, when the font carries one that differs. */
  localizedFamily: string | null;
  subfamily: string | null;
  fullName: string | null;
  version: string | null;
  designer: string | null;
  manufacturer: string | null;
  copyright: string | null;
  license: string | null;
}

/** The characters a font maps to glyphs, as sorted, non-overlapping code point ranges. */
export interface FontCoverage {
  /** Flat pairs: [start0, end0, start1, end1, …], both ends inclusive. */
  ranges: Uint32Array;
  count: number;
}

export interface FontFacts {
  container: FontContainer;
  outlines: 'truetype' | 'cff' | null;
  names: FontNames;
  /** usWeightClass: 400 regular, 700 bold. */
  weight: number | null;
  italic: boolean;
  glyphCount: number | null;
  axes: FontAxis[];
  /** null when the tables could not be read (WOFF2): the viewer measures instead. */
  coverage: FontCoverage | null;
}

const MAX_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_TABLES = 512;

function tagAt(view: DataView, offset: number): string {
  return String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3));
}

/** Which kind of font file the bytes are, or null when they are not a font at all. */
export function sniffFont(buffer: ArrayBuffer): FontContainer | null {
  if (buffer.byteLength < 12) return null;
  const view = new DataView(buffer);
  const signature = view.getUint32(0);
  if (signature === 0x00010000 || signature === 0x4f54544f || signature === 0x74727565 || signature === 0x74797031) return 'sfnt';
  if (signature === 0x774f4646) return 'woff';
  if (signature === 0x774f4632) return 'woff2';
  if (signature === 0x74746366) return 'collection';
  return null;
}

type TableReader = (tag: string) => DataView | null;

function sfntTables(buffer: ArrayBuffer): TableReader {
  const view = new DataView(buffer);
  const count = Math.min(view.getUint16(4), MAX_TABLES);
  const directory = new Map<string, { offset: number; length: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = 12 + index * 16;
    if (at + 16 > buffer.byteLength) break;
    directory.set(tagAt(view, at), { offset: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return (tag) => {
    const entry = directory.get(tag);
    if (!entry || entry.length > MAX_TABLE_BYTES || entry.offset + entry.length > buffer.byteLength) return null;
    return new DataView(buffer, entry.offset, entry.length);
  };
}

function woffTables(buffer: ArrayBuffer): TableReader {
  const view = new DataView(buffer);
  const count = Math.min(view.getUint16(12), MAX_TABLES);
  const directory = new Map<string, { offset: number; packed: number; length: number }>();
  for (let index = 0; index < count; index += 1) {
    const at = 44 + index * 20;
    if (at + 20 > buffer.byteLength) break;
    directory.set(tagAt(view, at), { offset: view.getUint32(at + 4), packed: view.getUint32(at + 8), length: view.getUint32(at + 12) });
  }
  return (tag) => {
    const entry = directory.get(tag);
    if (!entry || entry.length > MAX_TABLE_BYTES || entry.offset + entry.packed > buffer.byteLength) return null;
    if (entry.packed >= entry.length) return new DataView(buffer, entry.offset, entry.length);
    try {
      // The output buffer has the stated size, so a table that inflates to more is cut off there.
      const out = unzlibSync(new Uint8Array(buffer, entry.offset, entry.packed), { out: new Uint8Array(entry.length) });
      return new DataView(out.buffer, out.byteOffset, out.byteLength);
    } catch {
      return null;
    }
  };
}

// ── names ───────────────────────────────────────────────────────────────────────────────────────

interface NameRecord {
  platform: number;
  language: number;
  text: string;
}

function decodeUtf16(view: DataView, offset: number, length: number): string {
  let out = '';
  for (let at = offset; at + 1 < offset + length; at += 2) out += String.fromCharCode(view.getUint16(at));
  return out;
}

function decodeMac(view: DataView, offset: number, length: number): string {
  const bytes = new Uint8Array(view.buffer, view.byteOffset + offset, length);
  try {
    return new TextDecoder('macintosh').decode(bytes);
  } catch {
    let out = '';
    for (const byte of bytes) out += String.fromCharCode(byte);
    return out;
  }
}

function readNameRecords(view: DataView): Map<number, NameRecord[]> {
  const records = new Map<number, NameRecord[]>();
  if (view.byteLength < 6) return records;
  const count = Math.min(view.getUint16(2), 4096);
  const storage = view.getUint16(4);
  for (let index = 0; index < count; index += 1) {
    const at = 6 + index * 12;
    if (at + 12 > view.byteLength) break;
    const platform = view.getUint16(at);
    const encoding = view.getUint16(at + 2);
    const language = view.getUint16(at + 4);
    const id = view.getUint16(at + 6);
    const length = view.getUint16(at + 8);
    const offset = storage + view.getUint16(at + 10);
    if (id > 25 || length === 0 || length > 4096 || offset + length > view.byteLength) continue;
    let text: string;
    if (platform === 0 || platform === 3) text = decodeUtf16(view, offset, length);
    else if (platform === 1 && encoding === 0) text = decodeMac(view, offset, length);
    else continue;
    text = text.replace(/\0/g, '').trim();
    if (!text) continue;
    const list = records.get(id) ?? [];
    list.push({ platform, language, text });
    records.set(id, list);
  }
  return records;
}

/** Windows language ids to try for a reader's locale, most wanted first. */
function localLanguages(locale: string): number[] {
  const lower = locale.toLowerCase();
  if (lower.startsWith('zh-tw') || lower.startsWith('zh-hk') || lower.startsWith('zh-hant')) return [0x0404, 0x0c04, 0x1404, 0x0804, 0x1004];
  if (lower.startsWith('zh')) return [0x0804, 0x1004, 0x0404, 0x0c04, 0x1404];
  if (lower.startsWith('ja')) return [0x0411];
  if (lower.startsWith('ko')) return [0x0412];
  return [];
}

function englishName(list: readonly NameRecord[] | undefined): string | null {
  if (!list || list.length === 0) return null;
  return (
    list.find((item) => item.platform === 3 && item.language === 0x0409)?.text ??
    list.find((item) => item.platform === 3 && (item.language & 0xff) === 0x09)?.text ??
    list.find((item) => item.platform === 0)?.text ??
    list.find((item) => item.platform === 1 && item.language === 0)?.text ??
    list[0]?.text ??
    null
  );
}

function localName(list: readonly NameRecord[] | undefined, languages: readonly number[]): string | null {
  if (!list) return null;
  for (const language of languages) {
    const match = list.find((item) => item.platform === 3 && item.language === language);
    if (match) return match.text;
  }
  return null;
}

function readNames(table: DataView | null, locale: string): FontNames {
  const records = table ? readNameRecords(table) : new Map<number, NameRecord[]>();
  const languages = localLanguages(locale);
  // Typographic names (16, 17) group a family's styles the way a designer sees them; 1 and 2 are
  // the older four-style names.
  const family = englishName(records.get(16)) ?? englishName(records.get(1));
  const local = localName(records.get(16), languages) ?? localName(records.get(1), languages);
  const version = englishName(records.get(5));
  return {
    family,
    localizedFamily: local && local !== family ? local : null,
    subfamily: englishName(records.get(17)) ?? englishName(records.get(2)),
    fullName: englishName(records.get(4)),
    version: version ? version.replace(/^version\s*/i, '').split(';')[0]?.trim() || null : null,
    designer: englishName(records.get(9)),
    manufacturer: englishName(records.get(8)),
    copyright: englishName(records.get(0)),
    license: englishName(records.get(13)),
  };
}

// ── coverage ────────────────────────────────────────────────────────────────────────────────────

function finishCoverage(pairs: number[]): FontCoverage {
  const sorted: Array<[number, number]> = [];
  for (let index = 0; index + 1 < pairs.length; index += 2) sorted.push([pairs[index] ?? 0, pairs[index + 1] ?? 0]);
  sorted.sort((a, b) => a[0] - b[0]);
  const merged: number[] = [];
  let count = 0;
  for (const [start, end] of sorted) {
    const last = merged.length - 1;
    if (last >= 0 && start <= (merged[last] ?? 0) + 1) {
      if (end > (merged[last] ?? 0)) {
        count += end - (merged[last] ?? 0);
        merged[last] = end;
      }
    } else {
      merged.push(start, end);
      count += end - start + 1;
    }
  }
  return { ranges: Uint32Array.from(merged), count };
}

function coverageFormat4(view: DataView, at: number, pairs: number[]): void {
  const segments = view.getUint16(at + 6) >> 1;
  const ends = at + 14;
  const starts = ends + segments * 2 + 2;
  const deltas = starts + segments * 2;
  const offsets = deltas + segments * 2;
  if (offsets + segments * 2 > view.byteLength) return;
  for (let segment = 0; segment < segments; segment += 1) {
    const end = view.getUint16(ends + segment * 2);
    const start = view.getUint16(starts + segment * 2);
    if (start > end || start === 0xffff) continue;
    const last = Math.min(end, 0xfffe);
    const delta = view.getUint16(deltas + segment * 2);
    const rangeOffset = view.getUint16(offsets + segment * 2);
    if (rangeOffset === 0) {
      // glyph = (code + delta) mod 65536; exactly one code in 65536 lands on glyph 0 (no glyph).
      const missing = (0x10000 - delta) & 0xffff;
      if (missing < start || missing > last) pairs.push(start, last);
      else {
        if (missing > start) pairs.push(start, missing - 1);
        if (missing < last) pairs.push(missing + 1, last);
      }
      continue;
    }
    let run = -1;
    for (let code = start; code <= last; code += 1) {
      const address = offsets + segment * 2 + rangeOffset + (code - start) * 2;
      const glyph = address + 2 <= view.byteLength ? view.getUint16(address) : 0;
      if (glyph !== 0) {
        if (run === -1) run = code;
      } else if (run !== -1) {
        pairs.push(run, code - 1);
        run = -1;
      }
    }
    if (run !== -1) pairs.push(run, last);
  }
}

function coverageGroups(view: DataView, at: number, pairs: number[], manyToOne: boolean): void {
  const groups = Math.min(view.getUint32(at + 12), Math.floor((view.byteLength - at - 16) / 12), 500_000);
  for (let group = 0; group < groups; group += 1) {
    const record = at + 16 + group * 12;
    let start = view.getUint32(record);
    const end = Math.min(view.getUint32(record + 4), 0x10ffff);
    const glyph = view.getUint32(record + 8);
    if (glyph === 0) {
      if (manyToOne) continue;
      start += 1; // The first code of the group maps to glyph 0.
    }
    if (start <= end) pairs.push(start, end);
  }
}

function readCoverage(view: DataView): FontCoverage | null {
  if (view.byteLength < 4) return null;
  const count = Math.min(view.getUint16(2), 64);
  let best: { at: number; format: number; score: number } | null = null;
  for (let index = 0; index < count; index += 1) {
    const record = 4 + index * 8;
    if (record + 8 > view.byteLength) break;
    const platform = view.getUint16(record);
    const encoding = view.getUint16(record + 2);
    const at = view.getUint32(record + 4);
    if (at + 16 > view.byteLength) continue;
    const format = view.getUint16(at);
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10));
    let score = 0;
    if (unicode && (format === 12 || format === 13)) score = 5;
    else if (unicode && format === 4) score = 4;
    else if (platform === 3 && encoding === 0 && format === 4) score = 3; // Symbol fonts.
    else if (unicode && format === 6) score = 2;
    else if (format === 0) score = 1;
    if (score > (best?.score ?? 0)) best = { at, format, score };
  }
  if (!best) return null;
  const pairs: number[] = [];
  const { at, format } = best;
  if (format === 4) coverageFormat4(view, at, pairs);
  else if (format === 12 || format === 13) coverageGroups(view, at, pairs, format === 13);
  else if (format === 6) {
    const first = view.getUint16(at + 6);
    const entries = Math.min(view.getUint16(at + 8), Math.floor((view.byteLength - at - 10) / 2));
    for (let index = 0; index < entries; index += 1) if (view.getUint16(at + 10 + index * 2) !== 0) pairs.push(first + index, first + index);
  } else if (format === 0) {
    for (let code = 0; code < 256 && at + 6 + code < view.byteLength; code += 1) if (view.getUint8(at + 6 + code) !== 0) pairs.push(code, code);
  }
  return finishCoverage(pairs);
}

/** True when the font maps this code point to a glyph. */
export function coverageHas(coverage: FontCoverage, codePoint: number): boolean {
  const { ranges } = coverage;
  let low = 0;
  let high = ranges.length / 2 - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (codePoint < (ranges[middle * 2] ?? 0)) high = middle - 1;
    else if (codePoint > (ranges[middle * 2 + 1] ?? 0)) low = middle + 1;
    else return true;
  }
  return false;
}

/** How many code points of [from, to] the font covers. */
export function coverageCount(coverage: FontCoverage, from: number, to: number): number {
  const { ranges } = coverage;
  let total = 0;
  for (let index = 0; index < ranges.length; index += 2) {
    const start = Math.max(from, ranges[index] ?? 0);
    const end = Math.min(to, ranges[index + 1] ?? 0);
    if (end >= start) total += end - start + 1;
  }
  return total;
}

/** The first `limit` covered code points, lowest first. */
export function coverageFirst(coverage: FontCoverage, limit: number, accept: (codePoint: number) => boolean): number[] {
  const out: number[] = [];
  const { ranges } = coverage;
  for (let index = 0; index < ranges.length && out.length < limit; index += 2) {
    const end = ranges[index + 1] ?? 0;
    for (let code = ranges[index] ?? 0; code <= end && out.length < limit; code += 1) if (accept(code)) out.push(code);
  }
  return out;
}

// ── facts ───────────────────────────────────────────────────────────────────────────────────────

function readAxes(view: DataView): FontAxis[] {
  if (view.byteLength < 16) return [];
  const start = view.getUint16(4);
  const count = Math.min(view.getUint16(8), 64);
  const size = view.getUint16(10);
  const axes: FontAxis[] = [];
  for (let index = 0; index < count; index += 1) {
    const at = start + index * size;
    if (size < 20 || at + 20 > view.byteLength) break;
    axes.push({
      tag: tagAt(view, at),
      min: view.getInt32(at + 4) / 65536,
      default: view.getInt32(at + 8) / 65536,
      max: view.getInt32(at + 12) / 65536,
    });
  }
  return axes;
}

/** A table reader that never throws: a table that is cut short reads as missing. */
function guarded<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

/**
 * Reads what the file says about itself. Returns null when the bytes are not a font. `locale` picks
 * which localized family name to report next to the English one.
 */
export function readFontFacts(buffer: ArrayBuffer, locale = 'en'): FontFacts | null {
  const container = sniffFont(buffer);
  if (!container) return null;
  const header = new DataView(buffer);
  const empty: FontFacts = {
    container,
    outlines: null,
    names: readNames(null, locale),
    weight: null,
    italic: false,
    glyphCount: null,
    axes: [],
    coverage: null,
  };
  if (container === 'collection') return empty;
  const flavor = container === 'sfnt' ? header.getUint32(0) : header.getUint32(4);
  const outlines = flavor === 0x4f54544f ? 'cff' : 'truetype';
  if (container === 'woff2') return { ...empty, outlines };

  const table = guarded(() => (container === 'woff' ? woffTables(buffer) : sfntTables(buffer)), () => null);
  const os2 = guarded(() => table('OS/2'), null);
  const head = guarded(() => table('head'), null);
  const maxp = guarded(() => table('maxp'), null);
  const fvar = guarded(() => table('fvar'), null);
  const cmap = guarded(() => table('cmap'), null);
  const weight = os2 && os2.byteLength >= 6 ? os2.getUint16(4) : null;
  return {
    container,
    outlines,
    names: guarded(() => readNames(table('name'), locale), empty.names),
    weight: weight !== null && weight >= 1 && weight <= 1000 ? weight : null,
    italic: (os2 !== null && os2.byteLength >= 64 && (os2.getUint16(62) & 1) !== 0) || (head !== null && head.byteLength >= 46 && (head.getUint16(44) & 2) !== 0),
    glyphCount: maxp && maxp.byteLength >= 6 ? maxp.getUint16(4) : null,
    axes: fvar ? guarded(() => readAxes(fvar), []) : [],
    coverage: cmap ? guarded(() => readCoverage(cmap), null) : null,
  };
}
