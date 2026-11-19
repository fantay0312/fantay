// SPDX-License-Identifier: AGPL-3.0-only
// The OpenDocument reader: headings, resolved styles, lists, tables, links and pictures from an
// untrusted archive, and the cases it refuses.
import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { readOdt } from '../../../src/fantay/artifact/viewers/document/odt';
import { ReadError } from '../../../src/fantay/artifact/viewers/document/xml';

const NS =
  'xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:style="urn:oasis:names:tc:opendocument:xmlns:style:1.0" ' +
  'xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" ' +
  'xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:fo="urn:oasis:names:tc:opendocument:xmlns:xsl-fo-compatible:1.0" ' +
  'xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:meta="urn:oasis:names:tc:opendocument:xmlns:meta:1.0"';

/** A 2 × 1 PNG header is enough for the size check; the reader never decodes pixels. */
const PNG = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 2, 0, 0, 0, 1, 8, 2, 0, 0, 0,
]);

function odt(body: string, options: { styles?: string; automatic?: string; extra?: Record<string, Uint8Array> } = {}): Uint8Array {
  const content = `<?xml version="1.0" encoding="UTF-8"?><office:document-content ${NS}><office:automatic-styles>${options.automatic ?? ''}</office:automatic-styles><office:body><office:text>${body}</office:text></office:body></office:document-content>`;
  return zipSync({
    mimetype: strToU8('application/vnd.oasis.opendocument.text'),
    'content.xml': strToU8(content),
    ...(options.styles ? { 'styles.xml': strToU8(`<?xml version="1.0"?><office:document-styles ${NS}><office:styles>${options.styles}</office:styles></office:document-styles>`) } : {}),
    ...options.extra,
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

describe('readOdt', () => {
  it('reads headings by their level and resolves text styles through their parents', () => {
    const html = readOdt(
      odt(
        '<text:h text:outline-level="2">第二节</text:h>' +
          '<text:p text:style-name="P1">普通 <text:span text:style-name="T1">加粗</text:span><text:span text:style-name="T2">斜体下划线</text:span></text:p>',
        {
          styles: '<style:style style:name="Strong" style:family="text"><style:text-properties fo:font-weight="bold"/></style:style>',
          automatic:
            '<style:style style:name="P1" style:family="paragraph"><style:paragraph-properties fo:text-align="center"/></style:style>' +
            '<style:style style:name="T1" style:family="text" style:parent-style-name="Strong"/>' +
            '<style:style style:name="T2" style:family="text"><style:text-properties fo:font-style="italic" style:text-underline-style="solid"/></style:style>',
        },
      ),
    ).html;
    expect(html).toBe('<h2>第二节</h2><p style="text-align:center">普通 <strong>加粗</strong><em><u>斜体下划线</u></em></p>');
  });

  it('works out headings from size when the file only states looks', () => {
    const big = '<style:style style:name="P1" style:family="paragraph"><style:text-properties fo:font-size="24pt"/></style:style>';
    const body = '<style:style style:name="P2" style:family="paragraph"><style:text-properties fo:font-size="12pt"/></style:style>';
    const html = readOdt(
      odt('<text:p text:style-name="P1">标题</text:p><text:p text:style-name="P2">正文很长很长很长很长很长很长很长很长很长很长</text:p>', { automatic: big + body }),
    ).html;
    expect(html).toBe('<h1>标题</h1><p>正文很长很长很长很长很长很长很长很长很长很长</p>');
  });

  it('reads lists, tables with merged cells, safe links and embedded pictures', () => {
    const html = readOdt(
      odt(
        '<text:list text:style-name="L1"><text:list-item><text:p>一</text:p></text:list-item><text:list-item><text:p>二</text:p></text:list-item></text:list>' +
          '<table:table><table:table-row><table:table-cell table:number-columns-spanned="2"><text:p>合并</text:p></table:table-cell><table:covered-table-cell/></table:table-row>' +
          '<table:table-row><table:table-cell><text:p>A</text:p></table:table-cell><table:table-cell><text:p>B</text:p></table:table-cell></table:table-row></table:table>' +
          '<text:p><text:a xlink:href="https://example.com/a?b=1&amp;c=2">链接</text:a> <text:a xlink:href="javascript:alert(1)">坏链接</text:a></text:p>' +
          '<text:p><draw:frame><draw:image xlink:href="Pictures/a.png"/></draw:frame><draw:frame><draw:image xlink:href="../outside.png"/></draw:frame></text:p>',
        {
          automatic: '<text:list-style style:name="L1"><text:list-level-style-number text:level="1"/></text:list-style>',
          extra: { 'Pictures/a.png': PNG },
        },
      ),
    ).html;
    expect(html).toContain('<ol><li>一</li><li>二</li></ol>');
    expect(html).toContain('<table><tbody><tr><td colspan="2">合并</td></tr><tr><td>A</td><td>B</td></tr></tbody></table>');
    expect(html).toContain('<a href="https://example.com/a?b=1&amp;c=2">链接</a> 坏链接');
    expect(html.match(/<img /g)).toHaveLength(1);
    expect(html).toContain('<img src="data:image/png;base64,');
  });

  it('leaves out comments, tracked changes and scripts, and escapes text', () => {
    const html = readOdt(
      odt(
        '<office:scripts><x>evil()</x></office:scripts><text:tracked-changes><text:p>删除的</text:p></text:tracked-changes>' +
          '<text:p>保留<office:annotation><text:p>批注</text:p></office:annotation> &lt;b&gt;不是标签&lt;/b&gt;<text:s text:c="3"/>x<text:line-break/>y</text:p>',
      ),
    ).html;
    expect(html).toBe('<p>保留 &lt;b&gt;不是标签&lt;/b&gt;   x<br>y</p>');
  });

  it('reads the page count the application saved', () => {
    const meta = strToU8(`<?xml version="1.0"?><office:document-meta ${NS}><office:meta><meta:document-statistic meta:page-count="7"/></office:meta></office:document-meta>`);
    expect(readOdt(odt('<text:p>x</text:p>', { extra: { 'meta.xml': meta } })).pages).toBe(7);
    expect(readOdt(odt('<text:p>x</text:p>')).pages).toBeNull();
  });

  it('refuses a file that is not an archive, has no body, is encrypted or declares entities', () => {
    expect(failure(() => readOdt(strToU8('not a zip at all')))).toBe('invalid');
    expect(failure(() => readOdt(zipSync({ mimetype: strToU8('x') })))).toBe('invalid');
    expect(failure(() => readOdt(odt('')))).toBe('empty');
    const manifest = strToU8('<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"><manifest:file-entry><manifest:encryption-data/></manifest:file-entry></manifest:manifest>');
    expect(failure(() => readOdt(odt('<text:p>x</text:p>', { extra: { 'META-INF/manifest.xml': manifest } })))).toBe('protected');
    const bomb = zipSync({ 'content.xml': strToU8('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><x>&a;</x>') });
    expect(failure(() => readOdt(bomb))).toBe('unsupported');
  });
});
