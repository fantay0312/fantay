// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from 'vitest';

import {
  DESIGN_COVER_MAX_BYTES,
  DESIGN_COVER_MAX_EDGE,
  DESIGN_DOCUMENTS_DIR,
  DESIGN_DOCUMENT_MAX_BYTES,
  DESIGN_HISTORY_LIMIT,
  DESIGN_SHA256_HEADER,
  designCoverApiPath,
  designFileNameFromTitle,
  designFormatForPath,
  designNameFromPath,
  designRevision,
  isDesignDocumentPath,
  uniqueDesignPath,
} from '../src/api/design-documents';
import { MOVIE_DOCUMENT_FILE } from '../src/api/movie';
import { DESIGN_BRIDGE_LIMITS } from '../src/runtime/design-editor-bridge';

/**
 * Verbatim copy of the daemon's project file-name sanitizer (`sanitizeName`,
 * apps/daemon/src/projects.ts). Package tests must not import app sources, so
 * the parity checks below run against this copy; keep the two in sync.
 */
function daemonSanitizeName(raw: unknown): string {
  const cleaned = String(raw ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return cleaned || `file-${Date.now()}`;
}

/** Deterministic PRNG (mulberry32) so the random corpus is reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const corpus: Array<[title: string, expected: string]> = [
  ['首页', '首页'],
  ['首页 设计稿  v2', '首页-设计稿-v2'],
  ['資料夾：品牌', '資料夾_品牌'],
  ['デザイン案 01', 'デザイン案-01'],
  ['디자인 시스템', '디자인-시스템'],
  ['𠀀𠀁', '𠀀𠀁'],
  ['Hello World  page', 'Hello-World-page'],
  ['  padded  ', '-padded-'],
  ['tab\tand\nnewline', 'tab-and-newline'],
  ['ideographic　space', 'ideographic-space'],
  ['no break', 'no-break'],
  ['a/b\\c', 'a_b_c'],
  ['/leading/slash', '_leading_slash'],
  ['..hidden', '_hidden'],
  ['.fig', '_fig'],
  ['...', '_'],
  ['🎨 Logo', '_-Logo'],
  ['Brand 🚀🚀', 'Brand-__'],
  ['👨‍👩‍👧', '_____'],
  ['a:b*c?d"e<f>g|h', 'a_b_c_d_e_f_g_h'],
  ['100% done!', '100_-done_'],
  ['Report_v2.final-1', 'Report_v2.final-1'],
  ['Cafe-naïveté', 'Cafe-naïveté'],
  ['Café', 'Cafe_'],
  ['документ', 'документ'],
  ['تصميم ٣', 'تصميم-٣'],
];

describe('designFileNameFromTitle', () => {
  it.each(corpus)('%j -> %j, exactly like the daemon sanitizeName', (title, expected) => {
    expect(designFileNameFromTitle(title)).toBe(expected);
    expect(daemonSanitizeName(title)).toBe(expected);
  });

  it('matches the daemon on a seeded random corpus', () => {
    const alphabet = [
      'a', 'Z', '0', '9', '.', '_', '-', ' ', '\t', '\n', '　', ' ', '/', '\\', ':', '*', '?', '"', '<', '>',
      '|', '%', '#', '&', '首', '页', 'デ', '디', 'é', 'é', 'ß', 'Ж', 'ت', '٣', '𠀀', '🎨', '👨‍👩‍👧', '‍',
      '\ud800', '\udc00', '\u0000', '‮',
    ];
    const random = seededRandom(0x5eed);
    for (let sample = 0; sample < 1000; sample += 1) {
      let title = '';
      const pieces = 1 + Math.floor(random() * 14);
      for (let piece = 0; piece < pieces; piece += 1) title += alphabet[Math.floor(random() * alphabet.length)];
      expect(designFileNameFromTitle(title)).toBe(daemonSanitizeName(title));
    }
  });

  it('turns an empty title into "design" where the daemon would invent file-<time>', () => {
    expect(designFileNameFromTitle('')).toBe('design');
    expect(daemonSanitizeName('')).toMatch(/^file-\d+$/);
  });

  it('caps names at 120 characters without splitting a surrogate pair', () => {
    expect(designFileNameFromTitle('a'.repeat(300))).toBe('a'.repeat(120));
    expect(designFileNameFromTitle(`${'a'.repeat(119)}𠀀tail`)).toBe('a'.repeat(119));
    expect(designFileNameFromTitle(`${'a'.repeat(118)}𠀀tail`)).toBe(`${'a'.repeat(118)}𠀀`);
  });

  it('caps names at 150 UTF-8 bytes so long CJK titles stay under the 255-byte file-name limit', () => {
    expect(designFileNameFromTitle('首'.repeat(130))).toBe('首'.repeat(50));
    expect(designFileNameFromTitle('é'.repeat(100))).toBe('é'.repeat(75));
    expect(designFileNameFromTitle(`${'a'.repeat(148)}首`)).toBe('a'.repeat(120));
    expect(designFileNameFromTitle(`${'首'.repeat(49)}𠀀`)).toBe('首'.repeat(49));
    expect(designFileNameFromTitle(`${'首'.repeat(48)}𠀀`)).toBe(`${'首'.repeat(48)}𠀀`);
  });

  it('only produces non-empty canonical names the daemon accepts unchanged', () => {
    const titles = [...corpus.map(([title]) => title), '', 'a'.repeat(300), `${'b'.repeat(119)}𠀀`, '-'.repeat(200), '\ud800'];
    for (const title of titles) {
      const name = designFileNameFromTitle(title);
      expect(name.length).toBeGreaterThan(0);
      expect(name.length).toBeLessThanOrEqual(120);
      expect(encodeURIComponent(name).replace(/%[0-9A-F]{2}/g, 'x').length).toBeLessThanOrEqual(150);
      expect(daemonSanitizeName(name)).toBe(name);
      expect(daemonSanitizeName(`${name}.fig`)).toBe(`${name}.fig`);
      expect(designFileNameFromTitle(name)).toBe(name);
    }
  });
});

describe('design document paths', () => {
  it('recognizes .fig and .op in the last path segment, any case', () => {
    for (const path of ['designs/a.fig', 'A.FIG', 'x/y/z.op', 'designs/首页.Fig', 'designs\\win.op']) {
      expect(isDesignDocumentPath(path)).toBe(true);
    }
    for (const path of ['designs/a.figma', 'a.fig.json', 'a.png', 'designs/', '', 'fig', 'a.fig/', 'designs.fig/readme.md']) {
      expect(isDesignDocumentPath(path)).toBe(false);
    }
  });

  it('derives the format from the extension', () => {
    expect(designFormatForPath('designs/a.FIG')).toBe('fig');
    expect(designFormatForPath('legacy/b.Op')).toBe('op');
    expect(designFormatForPath('designs/c.png')).toBeNull();
    expect(designFormatForPath('designs.op/c')).toBeNull();
  });

  it('derives the display name from the basename', () => {
    expect(designNameFromPath('designs/首页.fig')).toBe('首页');
    expect(designNameFromPath('designs/a.b.fig')).toBe('a.b');
    expect(designNameFromPath('x.op')).toBe('x');
    expect(designNameFromPath('designs\\win.fig')).toBe('win');
    expect(designNameFromPath('designs/noext')).toBe('noext');
  });

  it('keeps design documents apart from the movie document', () => {
    expect(MOVIE_DOCUMENT_FILE).toBe('movie-studio.json');
    expect(isDesignDocumentPath(MOVIE_DOCUMENT_FILE)).toBe(false);
  });
});

describe('uniqueDesignPath', () => {
  it('uses designs/<base>.<format> while it is free', () => {
    expect(uniqueDesignPath('首页', 'fig', [])).toBe('designs/首页.fig');
    expect(uniqueDesignPath('viewer', 'op', ['designs/viewer.fig'])).toBe('designs/viewer.op');
  });

  it('suffixes -2, -3 … past taken paths', () => {
    expect(uniqueDesignPath('home', 'fig', ['designs/home.fig'])).toBe('designs/home-2.fig');
    expect(uniqueDesignPath('home', 'fig', new Set(['designs/home.fig', 'designs/home-2.fig', 'designs/home-4.fig']))).toBe(
      'designs/home-3.fig',
    );
  });

  it('treats case, Unicode-normalization and separator variants as taken', () => {
    expect(uniqueDesignPath('Home', 'fig', ['designs/home.FIG'])).toBe('designs/Home-2.fig');
    expect(uniqueDesignPath('Café', 'fig', ['designs/Café.fig'])).toBe('designs/Café-2.fig');
    expect(uniqueDesignPath('home', 'fig', ['designs\\home.fig', './designs/home-2.fig', '/designs/home-3.fig'])).toBe(
      'designs/home-4.fig',
    );
  });

  it('accepts any iterable of existing paths', () => {
    function* existing(): Generator<string> {
      yield 'designs/a.fig';
      yield 'designs/a-2.fig';
    }
    expect(uniqueDesignPath('a', 'fig', existing())).toBe('designs/a-3.fig');
  });

  it('honours dir, including the project root', () => {
    expect(uniqueDesignPath('a', 'fig', [], 'assets/designs/')).toBe('assets/designs/a.fig');
    expect(uniqueDesignPath('a', 'fig', [], './designs')).toBe('designs/a.fig');
    expect(uniqueDesignPath('a', 'fig', ['a.fig'], '')).toBe('a-2.fig');
  });

  it('normalizes raw base names into canonical file names', () => {
    expect(uniqueDesignPath('my design', 'fig', [])).toBe('designs/my-design.fig');
    expect(uniqueDesignPath('', 'fig', [])).toBe('designs/design.fig');
    expect(uniqueDesignPath('..secret', 'op', [])).toBe('designs/_secret.op');
  });
});

describe('designRevision', () => {
  it('joins the hex size and the floored hex mtime', () => {
    expect(designRevision(1234, 1730000000123.7)).toBe('4d2-192cc09147b');
    expect(designRevision(0, 0)).toBe('0-0');
  });

  it('changes when either the size or the mtime changes', () => {
    const base = designRevision(2048, 1730000000000);
    expect(designRevision(2049, 1730000000000)).not.toBe(base);
    expect(designRevision(2048, 1730000000001)).not.toBe(base);
    expect(designRevision(2048, 1730000000000.9)).toBe(base);
  });
});

describe('designCoverApiPath', () => {
  it('addresses the cover route with an encoded project id and path', () => {
    expect(designCoverApiPath('p 1', 'designs/首页.fig')).toBe(
      '/api/projects/p%201/designs/cover?path=designs%2F%E9%A6%96%E9%A1%B5.fig',
    );
  });

  it('appends a non-empty revision as a cache buster', () => {
    expect(designCoverApiPath('p1', 'designs/a&b.fig', '4d2-192cc09147b')).toBe(
      '/api/projects/p1/designs/cover?path=designs%2Fa%26b.fig&v=4d2-192cc09147b',
    );
    expect(designCoverApiPath('p1', 'designs/a.fig', '')).toBe('/api/projects/p1/designs/cover?path=designs%2Fa.fig');
  });
});

describe('design document limits', () => {
  it('pins the storage constants and the sha header', () => {
    expect(DESIGN_DOCUMENTS_DIR).toBe('designs');
    expect(DESIGN_DOCUMENT_MAX_BYTES).toBe(64 * 1024 * 1024);
    expect(DESIGN_DOCUMENT_MAX_BYTES).toBe(DESIGN_BRIDGE_LIMITS.maxDocumentBytes);
    expect(DESIGN_COVER_MAX_BYTES).toBe(8 * 1024 * 1024);
    expect(DESIGN_COVER_MAX_EDGE).toBe(4096);
    expect(DESIGN_HISTORY_LIMIT).toBe(20);
    expect(DESIGN_SHA256_HEADER).toBe('x-design-sha256');
  });
});
