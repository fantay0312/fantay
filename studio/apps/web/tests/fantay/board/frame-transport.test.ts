// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';

import {
  buildFrameSrcdoc,
  decideFrameTransport,
  FRAME_BRIDGE_TOKENS,
  FRAME_SANDBOX,
  FRAME_SOURCE_MAX_BYTES,
  frameUrl,
  hashString,
  transportKey,
} from '../../../src/fantay/board/engine/frame-transport';
import { dispatchFrameMessage } from '../../../src/fantay/board/engine/message-router';

const PLAIN = '<!doctype html><html><head><title>Home</title></head><body><h1>Hello</h1></body></html>';

function params(url: string): URLSearchParams {
  return new URL(url, 'http://localhost').searchParams;
}

const decide = (source: string | null, extra: Partial<Parameters<typeof decideFrameTransport>[0]> = {}) =>
  decideFrameTransport({ source, path: 'index.html', sizeBytes: source?.length ?? 0, projectFilePaths: null, editing: false, isDeckProject: false, ...extra });

describe('URL transport (03 §5.1)', () => {
  it('requests every bridge and guard of the raw route, with the mtime cache bust', () => {
    const url = frameUrl({ projectId: 'p1', path: 'pages/home page.html', mtime: 1234.6 });
    expect(url).toContain('/raw/pages/home%20page.html');
    const query = params(url);
    expect(query.getAll('odPreviewBridge')).toEqual([...FRAME_BRIDGE_TOKENS]);
    expect(FRAME_BRIDGE_TOKENS).toEqual(['scroll', 'selection', 'snapshot', 'observability', 'sandbox', 'focus', 'redirect']);
    expect(query.get('v')).toBe('1235');
    expect(query.has('fr')).toBe(false);
    expect(query.getAll('odPreviewBridge')).not.toContain('buildfocus');
    expect(query.has('odMotionPreview')).toBe(false);
  });

  it('adds `fr` and the build-focus bridge only while the agent writes the file', () => {
    const building = params(frameUrl({ projectId: 'p1', path: 'index.html', building: true, filesRefreshKey: 7 }));
    expect(building.get('fr')).toBe('7');
    expect(building.getAll('odPreviewBridge')).toContain('buildfocus');
    const idle = params(frameUrl({ projectId: 'p1', path: 'index.html', building: false, filesRefreshKey: 7 }));
    expect(idle.has('fr')).toBe(false);
  });

  it('flags motion compositions and the reload counter', () => {
    const query = params(frameUrl({ projectId: 'p1', path: 'motion-source/a/index.html', motion: true, reload: 3 }));
    expect(query.get('odMotionPreview')).toBe('1');
    expect(query.get('r')).toBe('3');
    expect(params(frameUrl({ projectId: 'p1', path: 'index.html', reload: 0 })).has('r')).toBe(false);
  });

  it('uses the FileViewer preview sandbox: scripts and forms, never same-origin', () => {
    expect(FRAME_SANDBOX.split(' ')).toEqual(['allow-scripts', 'allow-forms', 'allow-downloads']);
    expect(FRAME_SANDBOX).not.toContain('allow-same-origin');
  });
});

describe('transport decision (URL by default, srcdoc only where the URL path cannot carry it)', () => {
  it('loads plain pages through the URL', () => {
    expect(decide(PLAIN)).toBe('url');
    expect(decide(null)).toBe('url');
  });

  it('uses srcdoc for Edit, decks, forms / hash routers, tweaks and root-relative project assets', () => {
    expect(decide(PLAIN, { editing: true })).toBe('srcdoc');
    expect(decide(PLAIN, { isDeckProject: true })).toBe('srcdoc');
    expect(decide('<html><body><section class="slide">1</section><section class="slide">2</section></body></html>')).toBe('srcdoc');
    expect(decide('<html><body><form><input name="q"></form></body></html>')).toBe('srcdoc');
    expect(decide('<html><body><a href="#/about">About</a></body></html>')).toBe('srcdoc');
    expect(decide('<html><body><div class="tw-panel"></div></body></html>')).toBe('srcdoc');
    expect(decide('<html><body><img src="/assets/logo.png"></body></html>', { projectFilePaths: new Set(['assets/logo.png']) })).toBe('srcdoc');
    expect(decide('<html><body><img src="/assets/logo.png"></body></html>', { projectFilePaths: new Set(['other.png']) })).toBe('url');
  });

  it('never fetches or inlines a page above 2 MiB (even for Edit)', () => {
    expect(FRAME_SOURCE_MAX_BYTES).toBe(2 * 1024 * 1024);
    expect(decide(PLAIN, { sizeBytes: FRAME_SOURCE_MAX_BYTES + 1, editing: true })).toBe('url');
    expect(decide('<form></form>', { sizeBytes: FRAME_SOURCE_MAX_BYTES + 1 })).toBe('url');
  });
});

describe('srcdoc documents', () => {
  it('carries the preview base, the selection bridge and (for Edit) the edit bridge', async () => {
    const fetchBaseHref = vi.fn(async () => ({ href: 'http://localhost/api/projects/p1/raw/pages/', projectRoot: '' }) as never);
    const viewing = await buildFrameSrcdoc(
      { projectId: 'p1', path: 'pages/a.html', source: PLAIN, projectFilePaths: null, editing: false, deck: false, workspaceContext: null },
      { fetchBaseHref },
    );
    expect(fetchBaseHref).toHaveBeenCalledWith('p1', 'pages/a.html', null);
    expect(viewing.srcDoc).toContain('<base href="http://localhost/api/projects/p1/raw/pages/"');
    const editing = await buildFrameSrcdoc(
      { projectId: 'p1', path: 'pages/a.html', source: PLAIN, projectFilePaths: null, editing: true, deck: false, workspaceContext: null, reloadKey: 2 },
      { fetchBaseHref },
    );
    expect(editing.srcDoc).not.toBe(viewing.srcDoc);
    expect(editing.srcDoc).toContain('od-edit');
    expect(editing.srcDoc).toContain('data-od-reload-key="2"');
  });

  it('keys transports by document so the double buffer swaps only on a change', () => {
    expect(transportKey({ kind: 'url', src: '/a?v=1' })).toBe('url:/a?v=1');
    expect(transportKey({ kind: 'srcdoc', srcDoc: 'abc' })).toBe(`srcdoc:3:${hashString('abc')}`);
    expect(transportKey({ kind: 'srcdoc', srcDoc: 'abc' })).not.toBe(transportKey({ kind: 'srcdoc', srcDoc: 'abd' }));
    expect(transportKey(null)).toBe('');
  });
});

describe('message router (03 §3.17)', () => {
  it('opens only the project HTML pages a frame links to, with the 文件 tab checks', () => {
    const onOpenFile = vi.fn();
    const send = (fileName: unknown) => dispatchFrameMessage({ onOpenFile }, { type: 'od:preview-open-file', fileName });
    for (const fileName of ['pages/about.html', 'index.HTM']) send(fileName);
    for (const fileName of ['', '../secret.html', 'pages/../a.html', 'pages//a.html', './a.html', 'notes.txt', 'cover.png', `${'a/'.repeat(2100)}x.html`, 42]) send(fileName);
    expect(onOpenFile.mock.calls.map(([name]) => name)).toEqual(['pages/about.html', 'index.HTM']);
  });
});
