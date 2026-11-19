// SPDX-License-Identifier: AGPL-3.0-only
// Reading an OpenDocument presentation's text: the outline that comes out of a small real package,
// and the refusals (not a package, no content, a DTD, an oversized part).
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { decodeXmlEntities, lengthToPx, openOdp } from '../../../src/fantay/artifact/viewers/slides/odp-outline';

const NAMESPACES =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:presentation="urn:oasis:names:tc:opendocument:xmlns:presentation:1.0" ' +
  'xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" ' +
  'xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0"';

const STYLES = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-styles ${NAMESPACES}>
  <office:automatic-styles>
    <style:page-layout style:name="PM0"><style:page-layout-properties fo:page-width="21cm" fo:page-height="29.7cm"/></style:page-layout>
    <style:page-layout style:name="PM1"><style:page-layout-properties fo:page-width="28cm" fo:page-height="15.75cm"/></style:page-layout>
  </office:automatic-styles>
  <office:master-styles><style:master-page style:name="Default" style:page-layout-name="PM1"/></office:master-styles>
</office:document-styles>`;

const CONTENT = `<?xml version="1.0" encoding="UTF-8"?>
<office:document-content ${NAMESPACES}>
  <office:automatic-styles>
    <style:style style:name="dp1" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="visible"/></style:style>
    <style:style style:name="dp2" style:family="drawing-page"><style:drawing-page-properties presentation:visibility="hidden"/></style:style>
    <style:style style:name="T1" style:family="text"><style:text-properties fo:font-size="40pt"/></style:style>
    <style:style style:name="T2" style:family="text"><style:text-properties fo:font-size="18pt"/></style:style>
  </office:automatic-styles>
  <office:body><office:presentation>
    <draw:page draw:name="page1" draw:style-name="dp1">
      <draw:frame presentation:class="title" svg:x="2cm" svg:y="1cm"><draw:text-box><text:p>季度复盘 &amp; 规划</text:p></draw:text-box></draw:frame>
      <draw:frame presentation:class="outline" svg:x="2cm" svg:y="4cm"><draw:text-box>
        <text:list><text:list-item><text:p>订阅用户 12,480</text:p>
          <text:list><text:list-item><text:p>环比<text:s text:c="2"/>+18%</text:p></text:list-item></text:list>
        </text:list-item><text:list-item><text:p>留存 86.2%<text:line-break/>创新高</text:p></text:list-item></text:list>
      </draw:text-box></draw:frame>
      <draw:frame presentation:class="page-number"><draw:text-box><text:p>1</text:p></draw:text-box></draw:frame>
      <presentation:notes><draw:page-thumbnail/><draw:frame presentation:class="notes"><draw:text-box><text:p>先讲结论。</text:p><text:p>再讲华南。</text:p></draw:text-box></draw:frame></presentation:notes>
    </draw:page>
    <draw:page draw:name="page2" draw:style-name="dp2">
      <draw:frame svg:x="2cm" svg:y="1.5cm"><draw:text-box><text:p><text:span text:style-name="T1">各城市表现</text:span></text:p></draw:text-box></draw:frame>
      <draw:frame svg:x="2cm" svg:y="5cm"><table:table>
        <table:table-row><table:table-cell><text:p>城市</text:p></table:table-cell><table:table-cell><text:p>订阅</text:p></table:table-cell></table:table-row>
        <table:table-row><table:table-cell><text:p>上海</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>3,860</text:p></table:table-cell><table:table-cell/></table:table-row>
      </table:table></draw:frame>
      <draw:custom-shape svg:x="2cm" svg:y="12cm"><text:p><text:span text:style-name="T2">数据截至 9 月 30 日</text:span></text:p></draw:custom-shape>
    </draw:page>
    <draw:page draw:name="page3" draw:style-name="dp1"/>
  </office:presentation></office:body>
</office:document-content>`;

function pack(files: Record<string, string>): ArrayBuffer {
  const zipped = zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength) as ArrayBuffer;
}

function failureOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { failure?: unknown }).failure);
  }
  return 'none';
}

describe('openOdp', () => {
  const deck = openOdp(pack({ mimetype: 'application/vnd.oasis.opendocument.presentation', 'content.xml': CONTENT, 'styles.xml': STYLES }));

  it('reads the page size from the layout the master page names, and is outline-only', () => {
    expect(deck.drawable).toBe(false);
    expect(deck.width).toBeCloseTo((28 / 2.54) * 96);
    expect(deck.height).toBeCloseTo((15.75 / 2.54) * 96);
    expect(deck.slides).toHaveLength(3);
    expect(deck.outlineCut).toBe(false);
  });

  it('takes the title frame as the title and keeps list levels, spaces and line breaks', () => {
    const slide = deck.slides[0];
    expect(slide?.title).toBe('季度复盘 & 规划');
    expect(slide?.blocks).toEqual([
      {
        kind: 'text',
        paragraphs: [
          { text: '订阅用户 12,480', level: 0 },
          { text: '环比  +18%', level: 1 },
          { text: '留存 86.2%\n创新高', level: 0 },
        ],
      },
    ]);
  });

  it('keeps speaker notes apart from the slide and drops the page number', () => {
    expect(deck.slides[0]?.notes).toBe('先讲结论。\n再讲华南。');
    expect(JSON.stringify(deck.slides[0]?.blocks)).not.toContain('先讲结论');
  });

  it('finds a title by size and place when no frame is marked as one, reads tables, and sees hidden slides', () => {
    const slide = deck.slides[1];
    expect(slide?.hidden).toBe(true);
    expect(slide?.title).toBe('各城市表现');
    expect(slide?.blocks).toEqual([
      { kind: 'table', rows: [['城市', '订阅'], ['上海', '3,860', '3,860']] },
      { kind: 'text', paragraphs: [{ text: '数据截至 9 月 30 日', level: 0 }] },
    ]);
  });

  it('keeps an empty slide as a slide', () => {
    expect(deck.slides[2]).toEqual({ title: '', blocks: [], hidden: false, notes: '' });
  });

  it('reads a package without styles.xml (no size, same outline)', () => {
    const bare = openOdp(pack({ 'content.xml': CONTENT }));
    expect(bare.width).toBe(0);
    expect(bare.slides[0]?.title).toBe('季度复盘 & 规划');
  });
});

describe('openOdp refusals', () => {
  it('refuses bytes that are not a package', () => {
    expect(failureOf(() => openOdp(strToU8('not a zip at all').buffer as ArrayBuffer))).toBe('invalid');
  });

  it('refuses a package without content, and content that is not XML (an encrypted file)', () => {
    expect(failureOf(() => openOdp(pack({ 'styles.xml': STYLES })))).toBe('invalid');
    expect(failureOf(() => openOdp(pack({ 'content.xml': '\u0001\u0002 not xml' })))).toBe('invalid');
  });

  it('refuses a document type declaration, so no entity can be defined', () => {
    const bomb = `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol">]>${CONTENT.slice(CONTENT.indexOf('<office:document-content'))}`;
    expect(failureOf(() => openOdp(pack({ 'content.xml': bomb })))).toBe('invalid');
  });

  it('says a presentation without slides is empty, and another kind of document is invalid', () => {
    const none = `<?xml version="1.0"?><office:document-content ${NAMESPACES}><office:body><office:presentation/></office:body></office:document-content>`;
    expect(failureOf(() => openOdp(pack({ 'content.xml': none })))).toBe('empty');
    const text = `<?xml version="1.0"?><office:document-content ${NAMESPACES}><office:body><office:text><text:p>文档</text:p></office:text></office:body></office:document-content>`;
    expect(failureOf(() => openOdp(pack({ 'content.xml': text })))).toBe('invalid');
  });

  it('does not inflate a content part that declares more than the cap', () => {
    const large = `<?xml version="1.0"?><office:document-content ${NAMESPACES}><office:body><office:presentation><draw:page><draw:frame><draw:text-box><text:p>${'字'.repeat(3_000_000)}</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document-content>`;
    expect(failureOf(() => openOdp(pack({ 'content.xml': large })))).toBe('too-large');
  });
});

describe('helpers', () => {
  it('decodes the five named entities and numeric references, and leaves unknown names alone', () => {
    expect(decodeXmlEntities('a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#20013;&#x6587; &nbsp;')).toBe('a & b <c> "d" \'e\' 中文 &nbsp;');
    expect(decodeXmlEntities('&#xD800;&#0;')).toBe('');
  });

  it('converts lengths to pixels', () => {
    expect(lengthToPx('2.54cm')).toBeCloseTo(96);
    expect(lengthToPx('1in')).toBe(96);
    expect(lengthToPx('72pt')).toBeCloseTo(96);
    expect(lengthToPx('10mm')).toBeCloseTo(37.795, 2);
    expect(lengthToPx('12furlongs')).toBe(0);
    expect(lengthToPx(undefined)).toBe(0);
  });
});
