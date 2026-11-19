// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// The wall between a Mermaid file from anywhere and the page: whatever pele produces, and whatever a
// hostile SVG could hold, nothing that runs, loads, navigates or escapes the drawing survives.
import { render } from 'pele';
import { describe, expect, it } from 'vitest';

import { diagramRenderOptions } from '../../../src/fantay/artifact/viewers/diagram/render';
import { sanitizeDiagramSvg } from '../../../src/fantay/artifact/viewers/diagram/sanitize-svg';

const FONTS = { ui: 'sans-serif', mono: 'monospace' };

function draw(source: string, overrides: Record<string, unknown> = {}): string {
  return render(source, { ...diagramRenderOptions(FONTS, 'test'), measurer: undefined, ...overrides }).svg;
}

function markupOf(svg: SVGSVGElement): string {
  const host = document.createElement('div');
  host.append(svg);
  return host.innerHTML;
}

/** Everything in the markup that could run, load or navigate (namespace declarations are names, not addresses). */
function activeParts(input: string): string[] {
  const markup = input.replace(/\sxmlns(?::[a-z]+)?="[^"]*"/gi, '');
  const found: string[] = [];
  const patterns: Array<[string, RegExp]> = [
    ['script', /<script/i],
    ['event handler', /\son[a-z]+\s*=/i],
    ['javascript: address', /javascript:/i],
    ['href', /\s(?:xlink:)?href\s*=/i],
    ['remote url()', /url\(\s*['"]?(?!#)/i],
    ['http address', /https?:\/\//i],
    ['image', /<image/i],
    ['foreignObject', /<foreignobject/i],
    ['style element', /<style/i],
    ['use', /<use/i],
    ['animation', /<(?:animate|set)\b/i],
    ['iframe', /<iframe/i],
    ['target', /\starget\s*=/i],
  ];
  for (const [name, pattern] of patterns) if (pattern.test(markup)) found.push(name);
  return found;
}

describe('sanitizeDiagramSvg', () => {
  it('keeps pele drawings whole', () => {
    const source = 'flowchart TD\n  A([顾客打开小程序]) --> B{首次订阅?}\n  B -->|是| C[/填写口味问卷/]\n  B -->|否| D[(订单库)]\n  subgraph 履约\n    D --> E((签收))\n  end';
    const raw = draw(source);
    const clean = sanitizeDiagramSvg(raw);
    expect(clean).not.toBeNull();
    const parsed = new DOMParser().parseFromString(raw, 'image/svg+xml').documentElement;
    expect(clean!.svg.querySelectorAll('*').length).toBe(parsed.querySelectorAll('*').length);
    expect(clean!.svg.textContent).toContain('顾客打开小程序');
    expect(clean!.svg.getAttribute('viewBox')).toBe(parsed.getAttribute('viewBox'));
    expect(clean!.svg.getAttribute('style')).toContain('font-family:var(--pele-font');
    expect(clean!.svg.querySelector('[data-id="A"]')).not.toBeNull();
  });

  it('makes Mermaid click links inert, keeping only the address to copy', () => {
    const raw = draw(
      [
        'flowchart LR',
        '  A[官网] --> B[说明] --> C[邮箱] --> D[脚本] --> E[电话] --> F[相对]',
        '  click A href "https://example.com/coffee" _blank',
        '  click B "https://example.com/plans"',
        '  click C href "mailto:hello@example.com"',
        '  click D href "javascript:alert(document.cookie)"',
        '  click E href "tel:+864001234567"',
        '  click F href "notes/x.md"',
        '  click A call steal()',
      ].join('\n'),
    );
    expect(raw).toContain('href="https://example.com/coffee"');
    const clean = sanitizeDiagramSvg(raw)!;
    const markup = markupOf(clean.svg);
    expect(activeParts(markup.replace(/data-diagram-link="[^"]*"/g, ''))).toEqual([]);
    expect(clean.links).toEqual(['https://example.com/coffee', 'https://example.com/plans', 'mailto:hello@example.com', 'tel:+864001234567']);
    expect(Array.from(clean.svg.querySelectorAll('[data-diagram-link]'), (element) => element.localName)).toEqual(['a', 'a', 'a', 'a']);
  });

  it('never lets a picture load, from the network or from the app', () => {
    const raw = draw('flowchart LR\n  A@{ img: "https://example.com/t.png", label: "远程" }\n  B@{ img: "/api/projects/x/files/secret.png", label: "本地" }\n  A --> B', {
      images: true,
    });
    expect(raw).toContain('<image');
    const markup = markupOf(sanitizeDiagramSvg(raw)!.svg);
    expect(activeParts(markup)).toEqual([]);
    // With the viewer's own options pele does not even draw them.
    expect(draw('flowchart LR\n  A@{ img: "https://example.com/t.png", label: "远程" }')).not.toContain('<image');
  });

  it('does not let front matter or an init directive restyle the page', () => {
    const raw = draw(
      '---\nconfig:\n  themeVariables:\n    pie1: "red;position:fixed;inset:0"\n    pie2: "#123456"\n---\n%%{init: {"themeCSS": "body { display: none }", "fontFamily": "x;background:url(https://example.com/t.gif)"}}%%\npie\n  "a": 1\n  "b": 2',
    );
    const clean = sanitizeDiagramSvg(raw)!;
    const markup = markupOf(clean.svg);
    expect(markup).not.toMatch(/position|display:\s*none|example\.com/);
    expect(clean.svg.getAttribute('style')).toContain('--pele-series-2:#123456');
  });

  it('removes script, handlers, javascript: links and remote references from hostile markup', () => {
    const hostile = [
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 10 10"',
      ' onload="steal()" style="position:fixed;inset:0;z-index:99999;--_bg:#fff;transform:scale(9)">',
      '<script>steal()</script>',
      '<style>@import url(https://example.com/a.css); svg { background: url(https://example.com/t.gif) }</style>',
      '<g onclick="steal()" onmouseover="steal()"><rect width="5" height="5" fill="url(https://example.com/p.svg#x)"/></g>',
      '<a href="javascript:steal()"><text>one</text></a>',
      '<a xlink:href="javascript:steal()"><text>two</text></a>',
      '<a href="https://example.com/ok" target="_top"><text>three</text></a>',
      '<image href="https://example.com/t.png" width="1" height="1"/>',
      '<use href="https://example.com/sprite.svg#icon"/>',
      '<use xlink:href="data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PmFsZXJ0KDEpPC9zY3JpcHQ+PC9zdmc+#a"/>',
      '<foreignObject width="10" height="10"><iframe src="https://example.com"></iframe><img src="x" onerror="steal()"></foreignObject>',
      '<animate attributeName="href" to="javascript:steal()"/><set attributeName="onclick" to="steal()"/>',
      '<rect style="fill:red;background-image:url(https://example.com/t.gif)" width="1" height="1"/>',
      '<rect style="behavior:url(x.htc)" width="1" height="1"/>',
      '<g data-diagram-link="https://example.com/planted"><text>four</text></g>',
      '<linearGradient id="g"><stop offset="0" stop-color="#000"/></linearGradient><rect fill="url(#g)" width="1" height="1"/>',
      '</svg>',
    ].join('');
    const clean = sanitizeDiagramSvg(hostile)!;
    const markup = markupOf(clean.svg);
    expect(activeParts(markup.replace(/data-diagram-link="https:\/\/example\.com\/ok"/, ''))).toEqual([]);
    expect(markup).not.toMatch(/steal|position|z-index|transform/);
    expect(clean.links).toEqual(['https://example.com/ok']);
    expect(clean.svg.querySelector('g[data-diagram-link]')).toBeNull();
    // A same-document gradient reference is a picture, not an address: it stays.
    expect(clean.svg.querySelector('rect[fill="url(#g)"]')).not.toBeNull();
    expect(clean.svg.textContent).toContain('three');
  });

  it('refuses markup that is not one SVG drawing', () => {
    expect(sanitizeDiagramSvg('<div>not a drawing</div>')).toBeNull();
    expect(sanitizeDiagramSvg('<svg></svg><svg></svg>')).toBeNull();
    expect(sanitizeDiagramSvg('')).toBeNull();
  });
});
