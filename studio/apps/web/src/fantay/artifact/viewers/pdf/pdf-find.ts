// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/pdfLayout.ts @ c5e6b24f (MIT): the text folding
// of "find in PDF" (`pdfPageText`, `foldQuotes`, `pdfFindText`): case-insensitive, any run of white
// space reads as one space, a hyphen that ends a line between letters is dropped, typed straight
// quotes find typeset curly ones. Changed here: a match is an exact range (run and character offset
// at both ends) instead of "this span contains part of a match", so it can be painted precisely and
// counted; white space between two Chinese, Japanese or Korean characters is ignored, in the page
// and in the query (those scripts do not separate words, so a phrase that wraps onto the next line,
// or that a justified line spread out glyph by glyph, is still found); and radical twins and
// compatibility forms are folded, so the word a reader types finds the word the page shows.
//
// Pure: strings in, ranges out. A "run" is one text item of a page, in reading order, with "\n"
// appended when a line ends after it; run N is also the Nth span of the page's text layer.

/** One occurrence. Offsets are UTF-16 positions inside the run's own text; the end is exclusive. */
export interface PdfFindMatch {
  startRun: number;
  startOffset: number;
  endRun: number;
  endOffset: number;
}

/** A text item as pdf.js reports it (marked-content entries have no `str`). */
export type PdfTextItemLike = { str: string; hasEOL: boolean } | { type: string };

/** The runs of a page: each text item's string, with "\n" appended where a line ends after it. */
export function pdfTextRuns(items: readonly PdfTextItemLike[]): string[] {
  const runs: string[] = [];
  for (const item of items) if ('str' in item) runs.push(item.hasEOL ? `${item.str}\n` : item.str);
  return runs;
}

// A typed straight quote finds a typeset curly one, as pdf.js's own find does.
function foldQuotes(text: string): string {
  return text.replace(/[\u2018-\u201b]/g, "'").replace(/[\u201c-\u201f]/g, '"');
}

/**
 * Radical twins. A font can file the glyph of a common Chinese character under its "radical" code
 * point: the text then holds U+2F1D (Kangxi radical mouth) where it means U+53E3, the character.
 * The two look the same and are different characters, so a search for the word fails and copied
 * text pastes as the wrong characters. PDFs printed from a browser on macOS are full of them.
 * Unicode's compatibility mapping (NFKC) covers the Kangxi block; these pairs cover the supplement
 * block, which it leaves alone. Each pair is [radical, the character it stands for].
 */
const RADICAL_TWINS: ReadonlyMap<number, number> = new Map([
  [0x2e81, 0x5382], [0x2e84, 0x4e59], [0x2e85, 0x4ebb], [0x2e88, 0x5200], [0x2e89, 0x5202], [0x2e8a, 0x535c],
  [0x2e8c, 0x5c0f], [0x2e8d, 0x5c0f], [0x2e8e, 0x5140], [0x2e92, 0x5df3], [0x2e93, 0x5e7a], [0x2e96, 0x5fc4],
  [0x2e97, 0x5fc3], [0x2e98, 0x624c], [0x2e99, 0x6535], [0x2e9c, 0x65e5], [0x2e9d, 0x6708], [0x2ea0, 0x6c11],
  [0x2ea1, 0x6c35], [0x2ea3, 0x706c], [0x2ea7, 0x725b], [0x2ea8, 0x72ad], [0x2ea9, 0x738b], [0x2eaa, 0x758b],
  [0x2eab, 0x76ee], [0x2eac, 0x793a], [0x2ead, 0x793b], [0x2eae, 0x7af9], [0x2eaf, 0x7cf9], [0x2eb0, 0x7e9f],
  [0x2eb6, 0x7f8a], [0x2ebb, 0x807f], [0x2ebc, 0x8089], [0x2ebd, 0x81fc], [0x2ebe, 0x8279], [0x2ebf, 0x8279],
  [0x2ec0, 0x8279], [0x2ec1, 0x864e], [0x2ec2, 0x8864], [0x2ec3, 0x8980], [0x2ec4, 0x897f], [0x2ec5, 0x89c1],
  [0x2ec6, 0x89d2], [0x2ec8, 0x8ba0], [0x2ec9, 0x8d1d], [0x2eca, 0x8db3], [0x2ecb, 0x8f66], [0x2ecc, 0x8fb6],
  [0x2ecd, 0x8fb6], [0x2ece, 0x8fb6], [0x2ecf, 0x9091], [0x2ed0, 0x9485], [0x2ed1, 0x9577], [0x2ed2, 0x9578],
  [0x2ed3, 0x957f], [0x2ed4, 0x95e8], [0x2ed5, 0x961c], [0x2ed6, 0x961d], [0x2ed7, 0x96e8], [0x2ed8, 0x9752],
  [0x2ed9, 0x97e6], [0x2eda, 0x9875], [0x2edb, 0x98ce], [0x2edc, 0x98de], [0x2edd, 0x98df], [0x2edf, 0x98e0],
  [0x2ee0, 0x9963], [0x2ee2, 0x9a6c], [0x2ee3, 0x9aa8], [0x2ee4, 0x9b3c], [0x2ee5, 0x9c7c], [0x2ee6, 0x9e1f],
  [0x2ee7, 0x5364], [0x2ee8, 0x9ea6], [0x2ee9, 0x9ec4], [0x2eea, 0x9efe], [0x2eeb, 0x6589], [0x2eec, 0x9f50],
  [0x2eed, 0x6b6f], [0x2eee, 0x9f7f], [0x2eef, 0x7adc], [0x2ef0, 0x9f99], [0x2ef1, 0x9f9c], [0x2ef2, 0x4e80],
]);
const RADICALS = /[\u2e80-\u2ef3\u2f00-\u2fd5]/g;

/** Replaces radical code points by the characters they stand for; everything else is left as it is. */
export function unifyCjkRadicals(text: string): string {
  return text.replace(RADICALS, (radical) => {
    const twin = RADICAL_TWINS.get(radical.charCodeAt(0));
    return twin === undefined ? radical.normalize('NFKC') : String.fromCharCode(twin);
  });
}

/**
 * One character as find compares it: radical twins unified, compatibility forms folded (full-width
 * letters and digits, ligatures), lower case, straight quotes.
 */
function foldCharacter(character: string): string {
  return foldQuotes(unifyCjkRadicals(character).normalize('NFKC').toLowerCase());
}

const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef\u{20000}-\u{3134f}]/u;
const LETTER = /\p{L}/u;
const SPACE = /\s/;

interface Folded {
  /** The searchable text. */
  text: string;
  /** For every UTF-16 unit of `text`: the run it came from and where that character sits in it. */
  run: number[];
  start: number[];
  end: number[];
}

function foldRuns(runs: readonly string[]): Folded {
  const folded: Folded = { text: '', run: [], start: [], end: [] };
  /** The last character written, for the line-end rules. */
  let last = '';
  let beforeLast = '';
  /** White space seen since the last character: where it began, and whether it holds a line end. */
  let gap: { run: number; start: number; end: number; lineEnd: boolean } | null = null;

  const write = (text: string, run: number, start: number, end: number): void => {
    folded.text += text;
    for (let unit = 0; unit < text.length; unit += 1) {
      folded.run.push(run);
      folded.start.push(start);
      folded.end.push(end);
    }
  };

  runs.forEach((source, run) => {
    let offset = 0;
    for (const character of source) {
      const start = offset;
      offset += character.length;
      if (SPACE.test(character)) {
        if (gap) gap.lineEnd ||= character === '\n';
        else gap = { run, start, end: offset, lineEnd: character === '\n' };
        continue;
      }
      const text = foldCharacter(character);
      if (gap) {
        if (gap.lineEnd && last === '-' && LETTER.test(beforeLast) && LETTER.test(character)) {
          // "quar-\nterly": the hyphen only marks the line break.
          folded.text = folded.text.slice(0, -1);
          folded.run.pop();
          folded.start.pop();
          folded.end.pop();
        } else if (!(CJK.test(last) && CJK.test(character))) {
          write(' ', gap.run, gap.start, gap.end);
        }
        gap = null;
      }
      write(text, run, start, offset);
      beforeLast = last;
      last = character;
    }
  });
  return folded;
}

const CJK_GAP = new RegExp(`(?<=${CJK.source})\\s+(?=${CJK.source})`, 'gu');

function foldQuery(query: string): string {
  // Character by character, exactly as the page text is folded.
  const folded = Array.from(query, (character) => (SPACE.test(character) ? ' ' : foldCharacter(character))).join('');
  return folded.replace(CJK_GAP, '').replace(/\s+/g, ' ').trim();
}

/** Every occurrence of the query on a page, in reading order, without overlaps. */
export function pdfFindMatches(runs: readonly string[], query: string): PdfFindMatch[] {
  const needle = foldQuery(query);
  if (!needle) return [];
  const folded = foldRuns(runs);
  const matches: PdfFindMatch[] = [];
  for (let at = folded.text.indexOf(needle); at !== -1; at = folded.text.indexOf(needle, at + needle.length)) {
    const lastUnit = at + needle.length - 1;
    matches.push({
      startRun: folded.run[at] ?? 0,
      startOffset: folded.start[at] ?? 0,
      endRun: folded.run[lastUnit] ?? 0,
      endOffset: folded.end[lastUnit] ?? 0,
    });
  }
  return matches;
}

/** Position of the match after (`direction` 1) or before (-1) the given one, wrapping around. */
export function pdfFindStep(counts: ReadonlyMap<number, number>, current: { page: number; index: number } | null, direction: 1 | -1): { page: number; index: number } | null {
  const pages = [...counts.entries()].filter(([, count]) => count > 0).sort((a, b) => a[0] - b[0]);
  if (pages.length === 0) return null;
  const firstPage = pages[0] as [number, number];
  const lastPage = pages[pages.length - 1] as [number, number];
  if (!current) return direction === 1 ? { page: firstPage[0], index: 0 } : { page: lastPage[0], index: lastPage[1] - 1 };
  const count = counts.get(current.page) ?? 0;
  if (direction === 1) {
    if (current.index + 1 < count) return { page: current.page, index: current.index + 1 };
    const next = pages.find(([page]) => page > current.page) ?? firstPage;
    return { page: next[0], index: 0 };
  }
  if (current.index > 0 && current.index - 1 < count) return { page: current.page, index: current.index - 1 };
  const previous = [...pages].reverse().find(([page]) => page < current.page) ?? lastPage;
  return { page: previous[0], index: previous[1] - 1 };
}

/** 1-based position of a match in the whole document, counting the pages before it. */
export function pdfFindOrdinal(counts: ReadonlyMap<number, number>, current: { page: number; index: number } | null): number {
  if (!current) return 0;
  let ordinal = current.index + 1;
  for (const [page, count] of counts) if (page < current.page) ordinal += count;
  return ordinal;
}
