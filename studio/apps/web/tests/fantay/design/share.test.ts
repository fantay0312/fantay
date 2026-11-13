// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';

import { designHtmlPathFor, shareDesignAsWebPage } from '../../../src/fantay/design/share';
import { installFetch, jsonResponse } from './helpers/fake-editor';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('share = save as web page', () => {
  it('derives the sibling HTML path', () => {
    expect(designHtmlPathFor('designs/首页.fig')).toBe('designs/首页.html');
    expect(designHtmlPathFor('designs/board.OP')).toBe('designs/board.html');
    expect(designHtmlPathFor('designs/raw')).toBe('designs/raw.html');
  });

  it('exports the page and writes designs/<name>.html, reporting whether it is new', async () => {
    let exists = false;
    const { calls } = installFetch([
      (call) => (call.method === 'HEAD' ? new Response(null, { status: exists ? 200 : 404 }) : undefined),
      (call) =>
        call.method === 'POST' && call.url.pathname === '/api/projects/p1/files'
          ? jsonResponse({ file: { name: 'designs/首页.html', path: 'designs/首页.html', size: 20, mtime: 1, kind: 'html', mime: 'text/html' } })
          : undefined,
    ]);
    const exportHtml = vi.fn(async () => '<!doctype html><h1>首页</h1>');
    await expect(shareDesignAsWebPage({ exportHtml }, { projectId: 'p1', path: 'designs/首页.fig' })).resolves.toEqual({ htmlPath: 'designs/首页.html', created: true });
    expect(exportHtml).toHaveBeenCalledWith('page');
    expect(calls[0]?.url.pathname).toBe('/api/projects/p1/raw/designs/%E9%A6%96%E9%A1%B5.html');
    const form = calls.find((call) => call.method === 'POST')?.init?.body as FormData;
    expect(form.get('name')).toBe('designs/首页.html');
    expect(await (form.get('file') as File).text()).toBe('<!doctype html><h1>首页</h1>');

    exists = true;
    await expect(shareDesignAsWebPage({ exportHtml }, { projectId: 'p1', path: 'designs/首页.fig' })).resolves.toEqual({ htmlPath: 'designs/首页.html', created: false });
  });

  it('refuses an empty page and surfaces write failures', async () => {
    installFetch([
      (call) => (call.method === 'HEAD' ? new Response(null, { status: 404 }) : undefined),
      (call) => (call.method === 'POST' ? jsonResponse({ error: { code: 'FORBIDDEN', message: 'viewer' } }, 403) : undefined),
    ]);
    await expect(shareDesignAsWebPage({ exportHtml: async () => '  ' }, { projectId: 'p1', path: 'designs/a.fig' })).rejects.toMatchObject({ code: 'EMPTY_DOCUMENT' });
    await expect(shareDesignAsWebPage({ exportHtml: async () => '<p>x</p>' }, { projectId: 'p1', path: 'designs/a.fig' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
  });
});
