// @vitest-environment jsdom
// SPDX-License-Identifier: AGPL-3.0-only
// What a notebook may put in the page: structure and text. Nothing that runs, loads, navigates the
// app or restyles it.
import { describe, expect, it } from 'vitest';

import { protectMath, renderNotebookMarkdown, sanitizeOutputHtml } from '../../../src/fantay/artifact/viewers/notebook/notebook-html';

function dom(html: string): HTMLElement {
  const container = document.createElement('div');
  container.innerHTML = html;
  return container;
}

const PIXEL = 'data:image/png;base64,iVBORw0KGgo=';

describe('sanitizeOutputHtml', () => {
  it('keeps a table and its text', () => {
    const html = sanitizeOutputHtml(
      '<div><style scoped>.dataframe th { color: red }</style><table border="1" class="dataframe"><thead><tr style="text-align: right;"><th></th><th>月份</th></tr></thead><tbody><tr><th>0</th><td colspan="2">5月</td></tr></tbody></table></div>',
    );
    const root = dom(html);
    expect(root.querySelector('table')).not.toBeNull();
    expect(root.querySelector('td')?.getAttribute('colspan')).toBe('2');
    expect(root.textContent).toContain('月份');
    expect(root.textContent).not.toContain('color: red');
    expect(html).not.toMatch(/style|class|border=/);
  });

  it('removes everything that could run, load, submit or navigate', () => {
    const html = sanitizeOutputHtml(
      [
        '<p onclick="alert(1)" id="app" style="position:fixed">text</p>',
        '<script>alert(1)</script>',
        '<img src="https://example.test/tracker.gif" alt="t">',
        '<img src="x" onerror="alert(1)">',
        '<iframe src="https://example.test"></iframe>',
        '<a href="javascript:alert(1)">link</a>',
        '<a href="https://example.test">out</a>',
        '<form action="/api"><input name="q"><button>go</button></form>',
        '<svg><script>alert(1)</script></svg>',
        '<link rel="stylesheet" href="https://example.test/x.css">',
        '<object data="x"></object><embed src="x">',
      ].join(''),
    );
    const root = dom(html);
    expect(root.querySelectorAll('script, img, iframe, a, form, input, button, svg, link, object, embed, style')).toHaveLength(0);
    expect(html).not.toMatch(/onclick|onerror|javascript:|https:|style=|id=/);
    expect(root.textContent).toContain('text');
    expect(root.textContent).toContain('link');
  });

  it('keeps pictures that are embedded and nothing else', () => {
    const root = dom(sanitizeOutputHtml(`<img src="${PIXEL}" alt="chart"><img src="data:image/svg+xml;base64,PHN2Zz4="><img src="data:text/html;base64,PGI+">`));
    const images = Array.from(root.querySelectorAll('img'));
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute('src')).toBe(PIXEL);
  });

  it('returns nothing when no text or picture is left', () => {
    expect(sanitizeOutputHtml('<div id="chart"></div><script>draw()</script>')).toBe('');
    expect(sanitizeOutputHtml('   ')).toBe('');
  });
});

describe('protectMath', () => {
  it('sets display math as a block and inline math as code', () => {
    expect(protectMath('where $x_i$ and $y_i$ are')).toBe('where `$x_i$` and `$y_i$` are');
    expect(protectMath('a\n$$\\bar{r} = \\frac{1}{T}$$\nb')).toBe('a\n\n\n```math\n\\bar{r} = \\frac{1}{T}\n```\n\n\nb');
  });

  it('leaves money and code alone', () => {
    expect(protectMath('costs $5 and $10 each')).toBe('costs $5 and $10 each');
    expect(protectMath('run `echo $HOME and $PATH` now')).toBe('run `echo $HOME and $PATH` now');
    expect(protectMath('```sh\necho $a $b\n```')).toBe('```sh\necho $a $b\n```');
    expect(protectMath('no dollars')).toBe('no dollars');
  });
});

describe('renderNotebookMarkdown', () => {
  it('renders prose, tables with alignment and task lists', () => {
    const root = dom(renderNotebookMarkdown('# 标题\n\n**粗体** 文本\n\n| 指标 | 目标 |\n| :-- | --: |\n| 续订率 | 75% |\n\n- [x] 完成\n- [ ] 待办'));
    expect(root.querySelector('h1')?.textContent).toBe('标题');
    expect(root.querySelector('strong')?.textContent).toBe('粗体');
    expect(root.querySelectorAll('td')[1]?.getAttribute('align')).toBe('right');
    expect(root.querySelector('[data-table-scroll] > table')).not.toBeNull();
    const boxes = Array.from(root.querySelectorAll('input'));
    expect(boxes).toHaveLength(2);
    expect(boxes.every((box) => box.getAttribute('type') === 'checkbox' && box.hasAttribute('disabled'))).toBe(true);
  });

  it('shows raw HTML as text and never as markup', () => {
    const root = dom(renderNotebookMarkdown('before <script>alert(1)</script> <img src=x onerror=alert(1)> after'));
    expect(root.querySelectorAll('script, img')).toHaveLength(0);
    expect(root.textContent).toContain('<script>');
  });

  it('keeps links that leave the app and turns the others into text', () => {
    const root = dom(renderNotebookMarkdown('[外部](https://example.test/a) [邮件](mailto:a@example.test) [本地](./data/) [锚点](#top) [根](/settings)'));
    const links = Array.from(root.querySelectorAll('a'));
    expect(links.map((link) => link.getAttribute('href'))).toEqual(['https://example.test/a', 'mailto:a@example.test']);
    expect(links.every((link) => link.getAttribute('target') === '_blank' && link.getAttribute('rel') === 'noreferrer noopener')).toBe(true);
    expect(root.textContent).toContain('本地');
    expect(root.textContent).toContain('锚点');
  });

  it('shows an attached picture and describes any other', () => {
    const root = dom(renderNotebookMarkdown('![图表](attachment:图表-1.png)\n\n![远程图](https://example.test/a.png)\n\n![缺失](attachment:none.png)', { '图表-1.png': PIXEL }));
    const images = Array.from(root.querySelectorAll('img'));
    expect(images.map((image) => [image.getAttribute('src'), image.getAttribute('alt')])).toEqual([[PIXEL, '图表']]);
    expect(root.innerHTML).not.toContain('example.test');
    expect(root.textContent).toContain('远程图');
    expect(root.textContent).toContain('缺失');
  });

  it('keeps TeX readable', () => {
    const root = dom(renderNotebookMarkdown('其中 $N^{due}_t$ 与 $x_i$、$y_i$ 有关'));
    expect(Array.from(root.querySelectorAll('code')).map((code) => code.textContent)).toEqual(['$N^{due}_t$', '$x_i$', '$y_i$']);
    expect(root.querySelector('em')).toBeNull();
  });
});
