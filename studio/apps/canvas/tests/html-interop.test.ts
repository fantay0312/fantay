// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** HTML → design (06 §8.1): sanitizing, project-relative asset resolution and limits, Tailwind detection, Doop frames. */
import { describe, expect, it, vi } from 'vitest';

import { doopCanvasToHtml, isDoopCanvas } from '../src/fx/interop/doop';
import {
  HTML_ASSET_LIMITS,
  collectClassTokens,
  createSandboxedRuntimeDocument,
  htmlToSceneGraph,
  inlineProjectAssets,
  isTailwindHTML,
  resolveProjectAssetPath,
  safeHTML,
  safeHTMLFragment,
} from '../src/fx/interop/html';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

describe('safeHTML', () => {
  it('drops active elements and keeps stylesheets', () => {
    const out = parse(
      safeHTML(
        '<head><base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=x"><link rel="preload" href="a.js"><link rel="stylesheet" href="site.css"><script>alert(1)</script></head>' +
          '<body><iframe src="x"></iframe><object data="x"></object><embed src="x"><svg><script>alert(2)</script></svg><p>kept</p></body>',
      ),
    );
    expect(out.querySelectorAll('script, iframe, object, embed, base, meta[http-equiv]')).toHaveLength(0);
    expect([...out.querySelectorAll('link')].map((link) => link.getAttribute('rel'))).toEqual(['stylesheet']);
    expect(out.querySelector('p')?.textContent).toBe('kept');
  });

  it('strips handlers, srcdoc and script URLs', () => {
    const out = parse(
      safeHTML(
        '<a href="javascript:alert(1)" onclick="x()">a</a><a href=" JaVa\tScRiPt:alert(1)">b</a><a href="vbscript:x">c</a>' +
          '<img src="ok.png" onerror="x()"><div srcdoc="<p>x</p>" onmouseover="x()" title="safe"></div><a href="/page">d</a>',
      ),
    );
    const anchors = [...out.querySelectorAll('a')];
    expect(anchors.slice(0, 3).map((anchor) => anchor.hasAttribute('href'))).toEqual([false, false, false]);
    expect(anchors[0]!.hasAttribute('onclick')).toBe(false);
    expect(anchors[3]!.getAttribute('href')).toBe('/page');
    expect(out.querySelector('img')!.hasAttribute('onerror')).toBe(false);
    const div = out.querySelector('div')!;
    expect(div.hasAttribute('srcdoc') || div.hasAttribute('onmouseover')).toBe(false);
    expect(div.getAttribute('title')).toBe('safe');
  });

  it('keeps a doctype so the sandbox does not lay out in quirks mode', () => {
    expect(safeHTML('<p>x</p>').startsWith('<!doctype html>')).toBe(true);
  });

  it('returns embeddable fragments with their styles', () => {
    const fragment = safeHTMLFragment('<html><head><style>p{color:red}</style><script>x()</script></head><body><p>hi</p></body></html>');
    expect(fragment).toBe('<style>p{color:red}</style><p>hi</p>');
  });

  it('stamps sandbox="allow-same-origin" on offscreen iframes created by dom-css and never executes scripts', async () => {
    const wrapped = createSandboxedRuntimeDocument(document);
    const iframe = wrapped.createElement('iframe');
    expect(iframe.getAttribute('sandbox')).toBe('allow-same-origin');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-scripts');

    (window as unknown as { __xss?: number }).__xss = undefined;
    const { graph } = await htmlToSceneGraph(
      '<div style="width:120px;height:48px" onclick="window.__xss=1"><img src="x" onerror="window.__xss=2"><svg onload="window.__xss=3"></svg><iframe srcdoc="<script>window.__xss=4</script>"></iframe>Safe</div>',
      { sourcePath: 'index.html', fetchAsset: async () => ({ bytes: new ArrayBuffer(0), mime: 'image/png' }), pageName: 'SafePage' },
    );
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    expect(graph.getPages()).toHaveLength(1);
  });
});

describe('resolveProjectAssetPath', () => {
  it('resolves against the page folder', () => {
    expect(resolveProjectAssetPath('img/a.png', 'site/index.html')).toBe('site/img/a.png');
    expect(resolveProjectAssetPath('./a.png', 'index.html')).toBe('a.png');
    expect(resolveProjectAssetPath('../shared/a.png', 'site/pages/about.html')).toBe('site/shared/a.png');
    expect(resolveProjectAssetPath('/assets/logo.svg', 'site/index.html')).toBe('assets/logo.svg');
    expect(resolveProjectAssetPath('a%20b.png', null)).toBe('a b.png');
    expect(resolveProjectAssetPath('a.png?v=2#x', 'index.html')).toBe('a.png');
  });

  it('never leaves the project or fetches remote and inline URLs', () => {
    expect(resolveProjectAssetPath('https://cdn.test/a.png', 'index.html')).toBeNull();
    expect(resolveProjectAssetPath('//cdn.test/a.png', 'index.html')).toBeNull();
    expect(resolveProjectAssetPath('data:image/png;base64,AAAA', 'index.html')).toBeNull();
    expect(resolveProjectAssetPath('javascript:alert(1)', 'index.html')).toBeNull();
    expect(resolveProjectAssetPath('#top', 'index.html')).toBeNull();
    expect(resolveProjectAssetPath('', 'index.html')).toBeNull();
    // URL resolution clamps `..` at the project root.
    expect(resolveProjectAssetPath('../../../etc/passwd', 'index.html')).toBe('etc/passwd');
    expect(resolveProjectAssetPath('a%2F..%2F..%2Fx', 'index.html')).toBeNull();
  });
});

describe('inlineProjectAssets', () => {
  const asset = (size: number, mime = 'image/png') => ({ bytes: new Uint8Array(size).buffer, mime });

  it('inlines project stylesheets and images, and leaves remote ones alone', async () => {
    const doc = parse('<head><link rel="stylesheet" href="site.css"><link rel="stylesheet" href="https://cdn.test/x.css"></head><body><img src="a.png" srcset="a@2x.png 2x"><img src="https://cdn.test/b.png"></body>');
    const fetchAsset = vi.fn(async (path: string) =>
      path.endsWith('.css') ? { bytes: new TextEncoder().encode('p{color:red}').buffer, mime: 'text/css' } : asset(3),
    );
    const { skipped } = await inlineProjectAssets(doc, { sourcePath: 'index.html', fetchAsset, pageName: 'Home' });
    expect(skipped).toBe(0);
    expect(fetchAsset.mock.calls.map(([path]) => path)).toEqual(['site.css', 'a.png']);
    expect(doc.querySelector('style')?.textContent).toBe('p{color:red}');
    expect(doc.querySelectorAll('link')).toHaveLength(1);
    const [local, remote] = [...doc.querySelectorAll('img')];
    expect(local!.getAttribute('src')).toBe('data:image/png;base64,AAAA');
    expect(local!.hasAttribute('srcset')).toBe(false);
    expect(remote!.getAttribute('src')).toBe('https://cdn.test/b.png');
  });

  it('skips assets past the count, size and total limits, and failed loads', async () => {
    const images = Array.from({ length: HTML_ASSET_LIMITS.maxAssets + 3 }, (_, index) => `<img src="i${index}.png">`).join('');
    const doc = parse(`<body>${images}<img src="big.png"></body>`);
    const fetchAsset = vi.fn(async (path: string) => {
      if (path === 'i1.png') throw new Error('missing');
      if (path === 'i2.png') return asset(HTML_ASSET_LIMITS.maxAssetBytes + 1);
      return asset(10);
    });
    const { skipped } = await inlineProjectAssets(doc, { sourcePath: null, fetchAsset, pageName: 'p' });
    // 50 fetched (2 of them fail or are too big), 4 more over the count limit.
    expect(fetchAsset).toHaveBeenCalledTimes(HTML_ASSET_LIMITS.maxAssets);
    expect(skipped).toBe(2 + 4);

    const total = parse('<body><img src="a.png"><img src="b.png"><img src="c.png"><img src="d.png"></body>');
    const big = vi.fn(async () => asset(HTML_ASSET_LIMITS.maxAssetBytes));
    expect((await inlineProjectAssets(total, { sourcePath: null, fetchAsset: big, pageName: 'p' })).skipped).toBe(1);
  });

  it('stops when aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      inlineProjectAssets(parse('<img src="a.png">'), { sourcePath: null, fetchAsset: async () => asset(1), pageName: 'p', signal: controller.signal }),
    ).rejects.toThrow();
  });
});

describe('Tailwind detection', () => {
  it('detects the CDN script and the CSS entry points', () => {
    expect(isTailwindHTML('<script src="https://cdn.tailwindcss.com"></script>')).toBe(true);
    expect(isTailwindHTML('<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>')).toBe(true);
    expect(isTailwindHTML('<style>@import "tailwindcss";</style>')).toBe(true);
    expect(isTailwindHTML('<style>@tailwind utilities;</style>')).toBe(true);
    expect(isTailwindHTML('<p class="flex">no tailwind runtime</p>')).toBe(false);
  });

  it('collects the class tokens', () => {
    expect(collectClassTokens(parse('<div class="flex  gap-2"><p class="gap-2 text-sm"></p></div>')).sort()).toEqual(['flex', 'gap-2', 'text-sm']);
  });
});

describe('Doop canvas JSON', () => {
  it('positions every frame and sanitizes it', () => {
    const html = doopCanvasToHtml(JSON.stringify({ frames: [{ html: '<p onclick="x()">A</p><script>x()</script>', x: 10, y: 20, width: 300, height: 200 }] }));
    const section = parse(html).querySelector('section')!;
    expect(section.getAttribute('style')).toBe('position:absolute;left:10px;top:20px;width:300px;height:200px;overflow:hidden');
    expect(section.innerHTML).toBe('<p>A</p>');
  });

  it('rejects anything else', () => {
    expect(() => doopCanvasToHtml('not json')).toThrow();
    expect(() => doopCanvasToHtml('{"frames":[]}')).toThrow();
    expect(isDoopCanvas({ frames: Array.from({ length: 101 }, () => ({ html: '' })) })).toBe(false);
    expect(isDoopCanvas({ frames: [{ html: 1 }] })).toBe(false);
  });
});
