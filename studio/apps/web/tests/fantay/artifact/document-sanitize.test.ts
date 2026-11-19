// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The two walls around markup made from a file: the sanitiser (nothing that runs, nothing that
// loads, no address the caller did not set) and the policy of the frame it is shown in.
import { describe, expect, it } from 'vitest';

import { sanitizeConverted, sanitizeToFragment } from '../../../src/fantay/artifact/viewers/document/sanitize';
import { parseChapter } from '../../../src/fantay/artifact/viewers/ebook/chapter';
import { SANDBOX_FRAME_CSP, sandboxFrameDocument } from '../../../src/fantay/artifact/viewers/parts/SandboxFrame';

function html(fragment: DocumentFragment): string {
  const host = document.createElement('div');
  host.append(fragment);
  return host.innerHTML;
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

describe('sanitizeConverted', () => {
  it('removes what runs, what loads and what submits', () => {
    const out = html(
      sanitizeConverted(
        '<div onclick="steal()">text<script>steal()</script><iframe src="https://evil.example"></iframe><object data="x"></object>' +
          '<form action="https://evil.example"><input name="q"><button onclick="steal()">go</button></form><link rel="stylesheet" href="https://evil.example/a.css">' +
          '<style>p{background:url(https://evil.example/t.gif)}</style><video src="https://evil.example/v.mp4"></video></div>',
      ),
    );
    // The words of a form control stay as plain text; the control, and everything that could run or load, is gone.
    expect(out).toBe('<div>textgo</div>');
  });

  it('keeps embedded bitmaps and drops every other picture address', () => {
    const out = html(
      sanitizeConverted(`<p><img src="${PIXEL}" alt=""><img src="https://evil.example/pixel.gif"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="file:///etc/passwd"></p>`),
    );
    expect(out).toBe(`<p><img alt="" src="${PIXEL}"></p>`);
  });

  it('keeps only the style properties our readers write', () => {
    const out = html(
      sanitizeConverted(
        '<p style="text-align:center; position:fixed; color:red">a</p><span style="font-size:1.5em; background:url(https://evil.example/x)">b</span>',
      ),
    );
    expect(out).toBe('<p style="text-align: center;">a</p><span>b</span>');
  });

  it('keeps web and mail links and unlinks everything else', () => {
    const out = html(sanitizeConverted('<a href="https://example.com/x" target="_top">a</a><a href="javascript:alert(1)">b</a><a href="mailto:a@example.com">c</a>'));
    expect(out).toBe('<a href="https://example.com/x">a</a><a>b</a><a href="mailto:a@example.com">c</a>');
  });
});

describe('sanitizeToFragment (book)', () => {
  it('keeps classes and ids, and takes colour and placement out of inline styles', () => {
    const out = html(
      sanitizeToFragment('<p class="lead" id="p1" style="color:#111; text-indent:2em; position:fixed; background-color:black" data-x="1">a</p><font color="red">b</font>', {
        mode: 'book',
        onImage: () => false,
      }),
    );
    expect(out).toBe('<p class="lead" id="p1" style="text-indent: 2em;">a</p><font>b</font>');
  });

  it('hands every picture and link to the caller without its address', () => {
    const seen: string[] = [];
    const out = html(
      sanitizeToFragment('<img src="../images/a.png" alt="A"><a href="c2.xhtml#s">next</a><a href="#here">here</a>', {
        mode: 'book',
        onImage: (element, address) => {
          seen.push(`img ${address} ${element.hasAttribute('src')}`);
          return true;
        },
        onLink: (element, address) => {
          seen.push(`a ${address} ${element.hasAttribute('href')}`);
          return false;
        },
      }),
    );
    expect(seen).toEqual(['img ../images/a.png false', 'a c2.xhtml#s false', 'a #here false']);
    // A relative link nobody claimed stays without a target; a fragment is put back.
    expect(out).toBe('<img alt="A"><a>next</a><a href="#here">here</a>');
  });
});

describe('parseChapter', () => {
  const chapter =
    '<?xml version="1.0" encoding="utf-8"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>t</title>' +
    '<link rel="stylesheet" href="../styles/book.css"/><link rel="stylesheet" href="https://evil.example/remote.css"/><style>p{margin:0}</style></head>' +
    '<body class="chapter calibre1"><h1 id="top">标题</h1><a id="page_3"/><p>正文<img src="../images/a.png" alt=""/><img src="https://evil.example/pixel.gif"/></p>' +
    '<script>steal()</script><p onclick="steal()"><a href="c2.xhtml#s2">下一章</a> <a href="https://example.com/">外部</a> <a href="#top">顶部</a></p></body></html>';

  it('resolves pictures, stylesheets and links between chapters against the archive', () => {
    const parsed = parseChapter(chapter, 'OEBPS/text/c1.xhtml');
    expect(parsed.bodyClass).toBe('chapter calibre1');
    expect(parsed.styleSheets).toEqual(['OEBPS/styles/book.css']);
    expect(parsed.inlineStyles).toEqual(['p{margin:0}']);
    expect(parsed.pictures.map((picture) => `${picture.attribute} ${picture.path}`)).toEqual(['src OEBPS/images/a.png']);
    const out = html(parsed.fragment);
    expect(out).not.toContain('script');
    expect(out).not.toContain('onclick');
    expect(out).not.toContain('evil.example');
    expect(out).toContain('<a href="#" data-fx-path="OEBPS/text/c2.xhtml" data-fx-fragment="s2">下一章</a>');
    expect(out).toContain('<a href="https://example.com/">外部</a>');
    expect(out).toContain('<a href="#top">顶部</a>');
    // A self-closed anchor does not swallow what follows it.
    expect(out).toContain('<a id="page_3"></a><p>正文');
  });

  it('reads a chapter that is not well-formed XML as HTML instead of failing', () => {
    const parsed = parseChapter('<html><body><p>一<br>二<p>三</body></html>', 'c.xhtml');
    expect(html(parsed.fragment)).toBe('<p>一<br>二</p><p>三</p>');
  });
});

describe('the frame document', () => {
  it('allows no script and no network, and never navigates itself', () => {
    expect(SANDBOX_FRAME_CSP).toContain("default-src 'none'");
    expect(SANDBOX_FRAME_CSP).not.toMatch(/script-src|https?:|\*/);
    const page = sandboxFrameDocument('body{margin:0}</style><script>steal()</script>');
    expect(page).toContain(`content="${SANDBOX_FRAME_CSP}"`);
    expect(page).toContain('<base target="_blank">');
    // A stylesheet cannot close its own element and start markup.
    expect(page).not.toContain('</style><script>');
  });
});
