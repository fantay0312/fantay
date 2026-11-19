// SPDX-License-Identifier: AGPL-3.0-only
// The EPUB reader: the package, the spine, the contents (EPUB 3 navigation and EPUB 2 NCX), what a
// chapter and a resource hand back, and the books it refuses.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { ReadError } from '../../../src/fantay/artifact/viewers/document/xml';
import { chapterHeading, currentTocEntry, openBook } from '../../../src/fantay/artifact/viewers/ebook/epub';

const CONTAINER =
  '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';

function chapter(title: string, body = ''): Uint8Array {
  return strToU8(
    `<?xml version="1.0" encoding="utf-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml"><head><title>书名</title></head><body><h1>${title}</h1>${body}</body></html>`,
  );
}

function opf(options: { nav?: boolean; ncx?: boolean; spine?: string[] } = {}): Uint8Array {
  const spine = options.spine ?? ['c1', 'c2', 'c3'];
  return strToU8(
    `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/">` +
      `<dc:title>书名</dc:title><dc:creator>作者甲</dc:creator><dc:creator>作者乙</dc:creator><dc:language>zh-CN</dc:language></metadata><manifest>` +
      `<item id="c1" href="text/c1.xhtml" media-type="application/xhtml+xml"/><item id="c2" href="text/c2.xhtml" media-type="application/xhtml+xml"/>` +
      `<item id="c3" href="text/c%203.xhtml" media-type="application/xhtml+xml"/><item id="img" href="images/a.png" media-type="image/png"/>` +
      `<item id="css" href="book.css" media-type="text/css"/>` +
      (options.nav ? '<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>' : '') +
      (options.ncx ? '<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>' : '') +
      `</manifest><spine${options.ncx ? ' toc="ncx"' : ''}>${spine.map((id) => `<itemref idref="${id}"/>`).join('')}</spine></package>`,
  );
}

const NAV = strToU8(
  '<?xml version="1.0"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><body>' +
    '<nav epub:type="landmarks"><ol><li><a href="text/c1.xhtml">Start</a></li></ol></nav>' +
    '<nav epub:type="toc"><ol><li><a href="text/c1.xhtml">第一章</a><ol><li><a href="text/c1.xhtml#s2">第一章 · 第二节</a></li></ol></li>' +
    '<li><a href="text/c2.xhtml">第二章</a></li><li><a href="https://example.com/">外部</a></li><li><a href="../../etc/passwd">越界</a></li></ol></nav></body></html>',
);

const NCX = strToU8(
  '<?xml version="1.0"?><!DOCTYPE ncx PUBLIC "-//NISO//DTD ncx 2005-1//EN" "http://www.daisy.org/z3986/2005/ncx-2005-1.dtd">' +
    '<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/"><navMap><navPoint><navLabel><text>甲</text></navLabel><content src="text/c1.xhtml"/>' +
    '<navPoint><navLabel><text>甲之一</text></navLabel><content src="text/c1.xhtml#a1"/></navPoint></navPoint>' +
    '<navPoint><navLabel><text>丙</text></navLabel><content src="text/c%203.xhtml"/></navPoint></navMap></ncx>',
);

function book(extra: Record<string, Uint8Array> = {}, options: Parameters<typeof opf>[0] = {}): Uint8Array {
  return zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8(CONTAINER),
    'OEBPS/content.opf': opf(options),
    'OEBPS/text/c1.xhtml': chapter('开篇'),
    'OEBPS/text/c2.xhtml': chapter('中段'),
    'OEBPS/text/c 3.xhtml': chapter('尾声'),
    'OEBPS/images/a.png': Uint8Array.from([1, 2, 3]),
    'OEBPS/book.css': strToU8('p { text-indent: 2em }'),
    ...extra,
  });
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return cause instanceof ReadError ? cause.code : 'other';
  }
  return 'none';
}

describe('openBook', () => {
  it('reads the title, the authors, the language and the chapters in spine order', () => {
    const { info } = openBook(book());
    expect(info.title).toBe('书名');
    expect(info.author).toBe('作者甲, 作者乙');
    expect(info.language).toBe('zh-CN');
    expect(info.chapters.map((entry) => entry.path)).toEqual(['OEBPS/text/c1.xhtml', 'OEBPS/text/c2.xhtml', 'OEBPS/text/c 3.xhtml']);
  });

  it('names chapters from their own heading when the book has no contents', () => {
    const { info } = openBook(book());
    expect(info.toc).toEqual([]);
    expect(info.chapters.map((entry) => entry.title)).toEqual(['开篇', '中段', '尾声']);
  });

  it('reads the EPUB 3 contents with nesting, and leaves out entries that point outside the book', () => {
    const { info } = openBook(book({ 'OEBPS/nav.xhtml': NAV }, { nav: true }));
    expect(info.toc).toEqual([
      { label: '第一章', chapter: 0, fragment: '', depth: 0 },
      { label: '第一章 · 第二节', chapter: 0, fragment: 's2', depth: 1 },
      { label: '第二章', chapter: 1, fragment: '', depth: 0 },
    ]);
    // Contents name the chapters they point at; the third is named by its heading.
    expect(info.chapters.map((entry) => entry.title)).toEqual(['第一章', '第二章', '尾声']);
  });

  it('falls back to the EPUB 2 NCX', () => {
    const { info } = openBook(book({ 'OEBPS/toc.ncx': NCX }, { ncx: true }));
    expect(info.toc).toEqual([
      { label: '甲', chapter: 0, fragment: '', depth: 0 },
      { label: '甲之一', chapter: 0, fragment: 'a1', depth: 1 },
      { label: '丙', chapter: 2, fragment: '', depth: 0 },
    ]);
  });

  it('hands out a chapter as written and resources with their type', () => {
    const opened = openBook(book());
    const first = opened.chapter(0);
    expect(first.path).toBe('OEBPS/text/c1.xhtml');
    expect(first.markup).toContain('<h1>开篇</h1>');
    expect(failure(() => opened.chapter(9))).toBe('invalid');
    expect(opened.resource('OEBPS/images/a.png')).toMatchObject({ mediaType: 'image/png' });
    expect(opened.resource('OEBPS/book.css')?.mediaType).toBe('text/css');
    expect(opened.resource('OEBPS/missing.png')).toBeNull();
  });

  it('skips spine items that are missing or are not documents', () => {
    const { info } = openBook(book({}, { spine: ['c2', 'img', 'ghost', 'c1', 'c2'] }));
    expect(info.chapters.map((entry) => entry.path)).toEqual(['OEBPS/text/c2.xhtml', 'OEBPS/text/c1.xhtml']);
  });

  it('refuses copy-protected books but not books that only hide their fonts', () => {
    const encrypted = (algorithm: string): Uint8Array =>
      strToU8(`<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><enc:EncryptedData xmlns:enc="http://www.w3.org/2001/04/xmlenc#"><enc:EncryptionMethod Algorithm="${algorithm}"/></enc:EncryptedData></encryption>`);
    expect(failure(() => openBook(book({ 'META-INF/encryption.xml': encrypted('http://www.w3.org/2001/04/xmlenc#aes128-cbc') })))).toBe('protected');
    expect(failure(() => openBook(book({ 'META-INF/rights.xml': strToU8('<rights/>') })))).toBe('protected');
    expect(openBook(book({ 'META-INF/encryption.xml': encrypted('http://www.idpf.org/2008/embedding') })).info.chapters).toHaveLength(3);
  });

  it('refuses what is not a book', () => {
    expect(failure(() => openBook(strToU8('not a zip')))).toBe('invalid');
    expect(failure(() => openBook(zipSync({ 'a.txt': strToU8('zip, not epub') })))).toBe('invalid');
    expect(failure(() => openBook(book({}, { spine: [] })))).toBe('empty');
    expect(failure(() => openBook(zipSync({ 'META-INF/container.xml': strToU8(CONTAINER) })))).toBe('invalid');
  });
});

describe('chapterHeading', () => {
  it('prefers the first heading, then a title that is not just the book title', () => {
    expect(chapterHeading('<title>书名</title><h2 class="t">第 <em>三</em> 章 &amp; 尾声</h2>', '书名')).toBe('第 三 章 & 尾声');
    expect(chapterHeading('<title>版权页</title><p>文字</p>', '书名')).toBe('版权页');
    expect(chapterHeading('<title>书名</title><p>文字</p>', '书名')).toBeNull();
  });
});

describe('currentTocEntry', () => {
  const entries = [
    { label: 'a', chapter: 0, fragment: '', depth: 0 },
    { label: 'b', chapter: 2, fragment: '', depth: 0 },
    { label: 'b2', chapter: 2, fragment: 'x', depth: 1 },
    { label: 'c', chapter: 5, fragment: '', depth: 0 },
  ];
  it('is the first entry of the chapter, else the last entry before it', () => {
    expect(currentTocEntry(entries, 2)).toBe(1);
    expect(currentTocEntry(entries, 4)).toBe(2);
    expect(currentTocEntry(entries, 0)).toBe(0);
    expect(currentTocEntry([], 3)).toBe(-1);
  });
});
