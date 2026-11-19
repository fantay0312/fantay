// SPDX-License-Identifier: AGPL-3.0-only
// The RTF reader turns an untrusted file into reading markup: these pin what it keeps (paragraphs,
// headings worked out from size, emphasis, tables, code pages), what it skips and where it stops.
import { describe, expect, it } from 'vitest';

import { readRtf } from '../../../src/fantay/artifact/viewers/document/rtf';
import { ReadError } from '../../../src/fantay/artifact/viewers/document/xml';

function rtf(source: string): Uint8Array {
  return Uint8Array.from(source, (char) => char.charCodeAt(0));
}

function failure(run: () => unknown): string {
  try {
    run();
  } catch (cause) {
    return cause instanceof ReadError ? cause.code : 'other';
  }
  return 'none';
}

describe('readRtf', () => {
  it('reads paragraphs, and tells a heading from body text by its size', () => {
    // TextEdit's shape: `\uc0\uN` characters and a backslash at the end of a line as the paragraph end.
    const html = readRtf(
      rtf(
        '{\\rtf1\\ansi\\ansicpg936{\\fonttbl\\f0 Times-Bold;\\f1 Times-Roman;}\n' +
          '\\pard\\f0\\b\\fs48 \\uc0\\u21654 \\u21857 \\\n' +
          '\\pard\\f1\\b0\\fs24 \\uc0\\u30002 \\u26041 body text that sets the size most of the file uses\\\n' +
          '\\pard\\f0\\b\\fs36 \\uc0\\u19968 \\\n' +
          '\\pard\\f1\\b0\\fs24 more body text here, long enough to be the body\\\n}',
      ),
    ).html;
    expect(html).toContain('<h1>咖啡</h1>');
    expect(html).toContain('<h2>一</h2>');
    expect(html).toContain('<p>甲方body text that sets the size most of the file uses</p>');
    // A heading is not also wrapped in bold.
    expect(html).not.toContain('<h1><strong>');
  });

  it('keeps emphasis, alignment and a size that differs inside body text', () => {
    const html = readRtf(
      rtf('{\\rtf1\\ansi\\pard\\qc\\fs24 plain {\\b bold} {\\i italic} {\\ul under} {\\strike gone} x{\\super 2} and a {\\fs36 big} word in a long sentence\\par}'),
    ).html;
    expect(html).toContain('<p style="text-align:center">');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<u>under</u>');
    expect(html).toContain('<s>gone</s>');
    expect(html).toContain('<sup>2</sup>');
    expect(html).toContain('<span style="font-size:1.500em">big</span>');
  });

  it('decodes bytes with the code page of the file and of the font', () => {
    // 中文 in GBK is D6D0 CEC4.
    expect(readRtf(rtf("{\\rtf1\\ansi\\ansicpg936 \\'d6\\'d0\\'ce\\'c4\\par}")).html).toBe('<p>中文</p>');
    expect(readRtf(rtf("{\\rtf1\\ansi{\\fonttbl{\\f3\\fcharset134 SimSun;}}\\f3 \\'d6\\'d0\\par}")).html).toBe('<p>中</p>');
    // A Western font (charset 0) keeps its own code page inside a Chinese file: ¥ and · are single bytes.
    expect(readRtf(rtf("{\\rtf1\\ansi\\ansicpg936{\\fonttbl\\f1\\fcharset0 Times;}\\f1 \\'a568 \\'b7\\par}")).html).toBe('<p>¥68 ·</p>');
    // The fallback character after `\u` is skipped.
    expect(readRtf(rtf('{\\rtf1\\ansi\\uc1 \\u20013?\\u25991?\\par}')).html).toBe('<p>中文</p>');
  });

  it('reads table rows and cells', () => {
    const html = readRtf(
      rtf('{\\rtf1\\ansi before\\par\\trowd\\pard\\intbl A\\cell B\\cell\\row\\trowd\\pard\\intbl C\\cell D\\cell\\row\\pard after\\par}'),
    ).html;
    expect(html).toBe('<p>before</p><table><tbody><tr><td>A</td><td>B</td></tr><tr><td>C</td><td>D</td></tr></tbody></table><p>after</p>');
  });

  it('skips what is not body text and never emits markup from the file', () => {
    const html = readRtf(
      rtf(
        '{\\rtf1\\ansi{\\info{\\title Secret}}{\\header\\pard\\qc Header\\par}{\\*\\generator Word}{\\pict\\pngblip 89504e47}' +
          '{\\object\\objemb{\\*\\objdata 0105}}{\\field{\\*\\fldinst HYPERLINK "javascript:alert(1)"}{\\fldrslt link}}' +
          '\\pard <script>alert(1)</script> & text\\par}',
      ),
    ).html;
    expect(html).toBe('<p>link&lt;script&gt;alert(1)&lt;/script&gt; &amp; text</p>');
  });

  it('turns explicit page breaks into dividers and line breaks into <br>', () => {
    const read = readRtf(rtf('{\\rtf1\\ansi one\\line two\\par\\page three\\par}'));
    expect(read.html).toBe('<p>one<br>two</p><hr><p>three</p>');
    expect(read.pages).toBe(2);
  });

  it('refuses what is not RTF, what is damaged and what nests too deeply', () => {
    expect(failure(() => readRtf(rtf('PK\u0003\u0004 not rtf')))).toBe('invalid');
    expect(failure(() => readRtf(rtf('{\\rtf1 text')))).toBe('invalid');
    expect(failure(() => readRtf(rtf("{\\rtf1 \\'zz}")))).toBe('invalid');
    expect(failure(() => readRtf(rtf(`{\\rtf1 ${'{'.repeat(300)}x${'}'.repeat(300)}}`)))).toBe('unsupported');
    expect(failure(() => readRtf(rtf('{\\rtf1\\ansi{\\info{\\title only}}}')))).toBe('empty');
  });
});
