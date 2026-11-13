// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import type { ComponentProps } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesignEditorHost } from '../../../src/fantay/design/DesignEditorHost';
import { putDesignOpenRequest, resetDesignOpenRequestsForTests } from '../../../src/fantay/design/design-open-requests';
import { __resetToastsForTests } from '../../../src/fantay/ui';
import {
  resetWorkspaceBusForTests,
  subscribeWorkspaceCommand,
  type WorkspaceCommandOf,
} from '../../../src/fantay/workspace/workspace-bus';
import {
  FakeEditor,
  HELLO,
  OPEN_RESULT,
  bytes,
  connectFakeEditor,
  designSummary,
  installFetch,
  jsonResponse,
  settle,
  type FetchCall,
  type FetchRoute,
  type WireMessage,
} from './helpers/fake-editor';

type HostProps = ComponentProps<typeof DesignEditorHost>;

const editors: FakeEditor[] = [];

beforeEach(() => {
  document.documentElement.dataset.theme = 'dark';
});

afterEach(() => {
  cleanup();
  for (const editor of editors.splice(0)) editor.close();
  resetDesignOpenRequestsForTests();
  resetWorkspaceBusForTests();
  __resetToastsForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete document.documentElement.dataset.theme;
});

function frame(): HTMLIFrameElement {
  return screen.getByTestId('design-editor-frame') as HTMLIFrameElement;
}

function phase(): string | undefined {
  return screen.getByTestId('design-editor-host').dataset.phase;
}

function connect(): FakeEditor {
  const editor = connectFakeEditor(frame());
  editors.push(editor);
  return editor;
}

async function mount(props: HostProps): Promise<{ editor: FakeEditor; rerender: (next: HostProps) => void }> {
  const view = render(<DesignEditorHost {...props} />);
  const editor = connect();
  await settle(() => phase() === 'editing' || phase() === 'failed');
  return { editor, rerender: (next) => view.rerender(<DesignEditorHost {...next} />) };
}

const contentRoute =
  (path: string, text: string, sha256: string, format: 'fig' | 'op' = 'fig'): FetchRoute =>
  (call) =>
    call.method === 'GET' && call.url.pathname.endsWith('/designs/content') && call.url.searchParams.get('path') === path
      ? new Response(bytes(text), { status: 200, headers: { 'X-Design-Sha256': sha256, 'X-Design-Format': format, ETag: `"${sha256}"` } })
      : undefined;

const putRoute =
  (respond: (call: FetchCall) => Response): FetchRoute =>
  (call) =>
    call.method === 'PUT' && call.url.pathname.endsWith('/designs/content') ? respond(call) : undefined;

function lastOpen(editor: FakeEditor): Record<string, unknown> {
  const open = editor.requestsOf('document.open').at(-1);
  if (!open) throw new Error('no document.open yet');
  return open.payload as Record<string, unknown>;
}

describe('DesignEditorHost — boot, open and save', () => {
  it('sends init with theme/locale/messages, opens the project bytes and saves with If-Match', async () => {
    const saved = vi.fn();
    const { calls } = installFetch([
      contentRoute('designs/a.fig', 'PK-a', 'sha-1'),
      putRoute(() => jsonResponse({ design: designSummary('p1', 'designs/a.fig', 'sha-2', 3), created: false, previousSha256: 'sha-1' })),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, onSaved: saved });

    const init = editor.requestsOf('init')[0]?.payload as Record<string, unknown>;
    expect(init).toMatchObject({ theme: 'dark', locale: 'en', forwardShortcuts: [], closeOnEscape: false });
    expect((init.messages as Record<string, string>)['designEditor.frameTitle']).toBe('Design editor');
    const open = lastOpen(editor);
    expect(open).toMatchObject({
      source: 'bytes',
      identity: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' },
      name: 'a',
      format: 'fig',
      sha256: 'sha-1',
      readOnly: false,
    });
    expect((open.bytes as ArrayBuffer).byteLength).toBe(4);
    expect(screen.getByTestId('design-editor-header')).toHaveTextContent('a.fig');
    expect(screen.getByTestId('design-save-status')).toHaveTextContent('Saved');

    const response = await editor.request('document.save', { bytes: bytes('PK-b'), format: 'fig', baseSha256: 'sha-1', reason: 'autosave' });
    expect(response).toMatchObject({ ok: true, payload: { path: 'designs/a.fig', sha256: 'sha-2', size: 3 } });
    const put = calls.find((call) => call.method === 'PUT');
    expect(new Headers(put?.init?.headers).get('if-match')).toBe('"sha-1"');
    expect(saved).toHaveBeenCalledWith({ projectId: 'p1', path: 'designs/a.fig', sha256: 'sha-2', size: 3, created: false, source: null });
  });

  it('exports and stores a cover after 2 s without further saves', async () => {
    const covers: FetchCall[] = [];
    installFetch([
      contentRoute('designs/a.fig', 'PK', 'sha-1'),
      putRoute(() => jsonResponse({ design: designSummary('p1', 'designs/a.fig', 'sha-2'), created: false, previousSha256: 'sha-1' })),
      (call) => {
        if (call.method !== 'PUT' || !call.url.pathname.endsWith('/designs/cover')) return undefined;
        covers.push(call);
        return new Response(null, { status: 204 });
      },
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    editor.on('document.exportCover', () => ({ png: bytes('PNG'), width: 800, height: 600, pageId: '0:1', sourceSha256: 'sha-2' }));
    await editor.request('document.save', { bytes: bytes('PK2'), format: 'fig', baseSha256: 'sha-1', reason: 'autosave' });
    expect(editor.requestsOf('document.exportCover')).toHaveLength(0);
    await settle(() => covers.length === 1, 4000);
    expect(editor.requestsOf('document.exportCover')[0]?.payload).toEqual({ maxEdge: 1600 });
    expect(covers[0]?.url.searchParams.get('path')).toBe('designs/a.fig');
    expect(new Headers(covers[0]?.init?.headers).get('x-design-sha256')).toBe('sha-2');
  });

  it('reflects editor state, selection and view events', async () => {
    const onSelectionChange = vi.fn();
    const onViewChange = vi.fn();
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, onSelectionChange, onViewChange });
    editor.emit('state', { dirty: true, saving: false, readOnly: false, sha256: 'sha-1', lastSavedAt: null, format: 'fig', error: null });
    editor.emit('view', { zoom: 0.5, pageId: '0:1', pages: [{ id: '0:1', name: 'Page 1' }] });
    editor.emit('selection', { pageId: '0:1', nodeIds: ['1:2'], nodes: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 10, height: 20 }] });
    await settle(() => onSelectionChange.mock.calls.length === 1);
    await settle(() => screen.getByTestId('design-save-status').textContent === 'Unsaved changes');
    expect(screen.getByTestId('design-zoom')).toHaveTextContent('50%');
    expect(onViewChange).toHaveBeenCalledWith({ zoom: 0.5, pageId: '0:1', pages: [{ id: '0:1', name: 'Page 1' }] });
    fireEvent.keyDown(screen.getByRole('button', { name: 'Zoom 50%' }), { key: 'Enter' });
    fireEvent.click(screen.getByRole('menuitem', { name: /Zoom to fit/ }));
    await settle(() => editor.requestsOf('view.command').length === 1);
    expect(editor.requestsOf('view.command')[0]?.payload).toEqual({ command: 'zoomFit' });
    expect(onSelectionChange).toHaveBeenCalledWith({
      pageId: '0:1',
      nodeIds: ['1:2'],
      nodes: [{ id: '1:2', name: 'Hero', type: 'FRAME', width: 10, height: 20 }],
      projectId: 'p1',
      path: 'designs/a.fig',
    });
  });

  it('answers asset.fetch for project paths only', async () => {
    installFetch([
      contentRoute('designs/a.fig', 'PK', 'sha-1'),
      (call) => (call.url.pathname === '/api/projects/p1/raw/img/a.png' ? new Response(bytes('png!'), { status: 200, headers: { 'Content-Type': 'image/png' } }) : undefined),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    const ok = await editor.request('asset.fetch', { path: 'img/a.png' });
    expect(ok).toMatchObject({ ok: true, payload: { mime: 'image/png' } });
    expect(((ok.payload as { bytes: ArrayBuffer }).bytes).byteLength).toBe(4);
    const refused = await editor.request('asset.fetch', { path: '../../etc/passwd' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'INVALID_REQUEST' } });
  });

  it('maps a too-large save to TOO_LARGE with the localized message', async () => {
    installFetch([
      contentRoute('designs/a.fig', 'PK', 'sha-1'),
      putRoute(() => jsonResponse({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'too big' } }, 413)),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    const response = await editor.request('document.save', { bytes: bytes('x'), format: 'fig', baseSha256: 'sha-1', reason: 'autosave' });
    expect(response).toMatchObject({ ok: false, error: { code: 'TOO_LARGE' } });
    await settle(() => screen.getByTestId('design-save-status').dataset.status === 'failed');
    expect(screen.getByTestId('design-save-status')).toHaveTextContent('over 64 MB');
  });
});

describe('DesignEditorHost — conflicts', () => {
  it('shows the conflict banner on 409; reload / save copy / overwrite drive the editor', async () => {
    let contentSha = 'sha-1';
    const { calls } = installFetch([
      (call) => contentRoute('designs/a.fig', `PK-${contentSha}`, contentSha)(call),
      putRoute(() => jsonResponse({ error: { code: 'CONFLICT', message: 'changed', details: { reason: 'DESIGN_REVISION_MISMATCH', currentSha256: 'sha-9', path: 'designs/a.fig' } } }, 409)),
      (call) => (call.url.pathname === '/api/projects/p1/designs' ? jsonResponse({ designs: [designSummary('p1', 'designs/a.fig', 'sha-9')] }) : undefined),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    editor.on('document.saveCopy', (payload) => ({ path: (payload as { targetPath: string }).targetPath, sha256: 'sha-c', size: 1, savedAt: 1 }));
    editor.on('document.forceSave', () => ({ path: 'designs/a.fig', sha256: 'sha-f', size: 1, savedAt: 1 }));

    const conflict = async () => {
      const response = await editor.request('document.save', { bytes: bytes('mine'), format: 'fig', baseSha256: 'sha-1', reason: 'autosave' });
      expect(response).toMatchObject({ ok: false, error: { code: 'CONFLICT', details: { currentSha256: 'sha-9' } } });
      await settle(() => screen.queryByTestId('design-conflict-banner') !== null);
    };

    await conflict();
    expect(screen.getByTestId('design-conflict-banner')).toHaveTextContent('This design was changed elsewhere');
    contentSha = 'sha-9';
    fireEvent.click(screen.getByRole('button', { name: 'Load latest version' }));
    await settle(() => editor.requestsOf('document.open').length === 2 && screen.queryByTestId('design-conflict-banner') === null);
    expect(lastOpen(editor)).toMatchObject({ source: 'bytes', sha256: 'sha-9' });

    await conflict();
    fireEvent.click(screen.getByRole('button', { name: 'Save as a copy' }));
    await settle(() => editor.requestsOf('document.saveCopy').length === 1 && screen.queryByTestId('design-conflict-banner') === null);
    expect(editor.requestsOf('document.saveCopy')[0]?.payload).toEqual({ targetPath: 'designs/a-2.fig' });
    expect(calls.some((call) => call.url.pathname === '/api/projects/p1/designs')).toBe(true);

    await conflict();
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my version' }));
    await settle(() => editor.requestsOf('document.forceSave').length === 1 && screen.queryByTestId('design-conflict-banner') === null);
    expect(editor.requestsOf('document.forceSave')[0]?.payload).toEqual({ baseSha256: 'sha-9' });
  });

  it('a copy save that meets an existing file moves on to the next free name', async () => {
    const replaced = vi.fn();
    const puts: string[] = [];
    installFetch([
      contentRoute('designs/a.fig', 'PK', 'sha-1'),
      putRoute((call) => {
        const path = call.url.searchParams.get('path') ?? '';
        puts.push(path);
        if (path === 'designs/a-2.fig') return jsonResponse({ error: { code: 'CONFLICT', message: 'exists', details: { currentSha256: 'other' } } }, 409);
        return jsonResponse({ design: designSummary('p1', path, 'sha-copy'), created: true, previousSha256: null }, 201);
      }),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, onDocumentReplaced: replaced });
    const response = await editor.request('document.save', { bytes: bytes('copy'), format: 'fig', baseSha256: null, reason: 'copy', targetPath: 'designs/a-2.fig' });
    expect(puts).toEqual(['designs/a-2.fig', 'designs/a-3.fig']);
    expect(response).toMatchObject({ ok: true, payload: { path: 'designs/a-3.fig' } });
    expect(replaced).toHaveBeenCalledWith({ projectId: 'p1', path: 'designs/a-3.fig' });
    await settle(() => screen.getByTestId('design-editor-header').textContent?.includes('a-3.fig') === true);
  });
});

describe('DesignEditorHost — close, switch and theme', () => {
  it('shows the unsaved dialog when the close flush fails; keep stays, discard closes', async () => {
    const onRequestClose = vi.fn();
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, closeOnEscape: true, onRequestClose });
    expect((editor.requestsOf('init')[0]?.payload as { closeOnEscape: boolean }).closeOnEscape).toBe(true);
    editor.on('document.flush', () => ({ saved: false, dirty: true, sha256: 'sha-1', error: { code: 'NETWORK', message: 'offline' } }));

    editor.emit('request-close', {});
    await settle(() => screen.queryByRole('alertdialog') !== null);
    expect(editor.requestsOf('document.flush')[0]?.payload).toEqual({ reason: 'close' });
    expect(screen.getByRole('alertdialog')).toHaveTextContent('Changes not saved');
    expect(screen.getByRole('alertdialog')).toHaveTextContent("Saving failed: The service can't be reached. Check your network connection and try again.");
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await settle(() => screen.queryByRole('alertdialog') === null);
    expect(onRequestClose).not.toHaveBeenCalled();

    editor.emit('request-close', {});
    await settle(() => screen.queryByRole('alertdialog') !== null);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    await settle(() => onRequestClose.mock.calls.length === 1);
  });

  it('closes right away when the flush saved', async () => {
    const onRequestClose = vi.fn();
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, onRequestClose });
    editor.on('document.flush', () => ({ saved: true, dirty: false, sha256: 'sha-2' }));
    editor.emit('request-close', {});
    await settle(() => onRequestClose.mock.calls.length === 1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('switches documents in the same iframe after flushing the old one', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK-a', 'sha-a'), contentRoute('designs/b.fig', 'PK-b', 'sha-b')]);
    const { editor, rerender } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    const iframe = frame();
    rerender({ document: { kind: 'project', projectId: 'p1', path: 'designs/b.fig' } });
    await settle(() => editor.requestsOf('document.open').length === 2);
    expect(editor.requestsOf('document.flush')[0]?.payload).toEqual({ reason: 'switch' });
    expect(lastOpen(editor)).toMatchObject({ identity: { kind: 'project', projectId: 'p1', path: 'designs/b.fig' }, sha256: 'sha-b' });
    expect(frame()).toBe(iframe);
    expect(editor.requestsOf('init')).toHaveLength(1);
  });

  it('asks before switching away from unsaved changes; keep returns to the document, discard switches', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK-a', 'sha-a'), contentRoute('designs/b.fig', 'PK-b', 'sha-b')]);
    const onDocumentReplaced = vi.fn();
    const a: HostProps = { document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, onDocumentReplaced };
    const b: HostProps = { document: { kind: 'project', projectId: 'p1', path: 'designs/b.fig' }, onDocumentReplaced };
    const { editor, rerender } = await mount(a);
    editor.on('document.flush', () => ({ saved: false, dirty: true, sha256: 'sha-a', error: { code: 'CONFLICT', message: 'changed' } }));

    rerender(b);
    await settle(() => screen.queryByRole('alertdialog') !== null);
    fireEvent.click(screen.getByRole('button', { name: 'Keep editing' }));
    await settle(() => onDocumentReplaced.mock.calls.length === 1);
    expect(onDocumentReplaced).toHaveBeenCalledWith({ projectId: 'p1', path: 'designs/a.fig' });
    expect(editor.requestsOf('document.open')).toHaveLength(1);

    rerender(a); // the workspace went back to a.fig
    rerender(b); // …and the user picks b.fig again: asked again
    await settle(() => screen.queryByRole('alertdialog') !== null);
    fireEvent.click(screen.getByRole('button', { name: 'Discard and close' }));
    await settle(() => editor.requestsOf('document.open').length === 2);
    expect(lastOpen(editor)).toMatchObject({ identity: { path: 'designs/b.fig' } });
  });

  it('sends a theme event when the app theme changes, without changing the iframe src', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    const iframe = frame();
    const src = iframe.getAttribute('src');
    expect(src).toBe('/canvas-editor/index.html?embed=1&v=1&theme=dark&locale=en');
    document.documentElement.dataset.theme = 'light';
    await settle(() => editor.eventsOf('theme').length === 1);
    expect(editor.eventsOf('theme')[0]?.payload).toEqual({ theme: 'light' });
    expect(frame()).toBe(iframe);
    expect(frame().getAttribute('src')).toBe(src);
  });

  it('keeps an inactive editor alive for keepAliveMs, then flushes and drops the iframe; reopens when shown', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const doc: HostProps['document'] = { kind: 'project', projectId: 'p1', path: 'designs/a.fig' };
    const { editor, rerender } = await mount({ document: doc, keepAliveMs: 30 });
    rerender({ document: doc, keepAliveMs: 30, active: false });
    await settle(() => screen.queryByTestId('design-editor-frame') === null);
    expect(editor.requestsOf('document.flush').at(-1)?.payload).toEqual({ reason: 'hidden' });
    rerender({ document: doc, keepAliveMs: 30, active: true });
    await settle(() => screen.queryByTestId('design-editor-frame') !== null);
    const next = connect();
    await settle(() => phase() === 'editing');
    expect(next.requestsOf('document.open')).toHaveLength(1);
  });

  it('tells the editor when it becomes hidden and visible again', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK', 'sha-1')]);
    const { editor, rerender } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' } });
    rerender({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, active: false });
    await settle(() => editor.eventsOf('visibility').length === 1);
    rerender({ document: { kind: 'project', projectId: 'p1', path: 'designs/a.fig' }, active: true });
    await settle(() => editor.eventsOf('visibility').length === 2);
    expect(editor.eventsOf('visibility').map((event: WireMessage) => event.payload)).toEqual([{ visible: false }, { visible: true }]);
  });
});

describe('DesignEditorHost — creation sources', () => {
  it('takes a pending blank request and queues one design board draft after the first save', async () => {
    const inserts: WorkspaceCommandOf<'board.insert'>[] = [];
    subscribeWorkspaceCommand('board.insert', (command) => {
      inserts.push(command);
      return true;
    });
    putDesignOpenRequest('p1', 'designs/new.fig', { kind: 'blank', title: '新页面', sourceNodeId: 'frame-1' });
    let created = true;
    const { calls } = installFetch([
      putRoute(() => {
        const body = { design: designSummary('p1', 'designs/new.fig', created ? 'sha-1' : 'sha-2'), created, previousSha256: created ? null : 'sha-1' };
        created = false;
        return jsonResponse(body, body.created ? 201 : 200);
      }),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/new.fig' } });
    expect(calls.some((call) => call.method === 'GET' && call.url.pathname.endsWith('/designs/content'))).toBe(false);
    expect(lastOpen(editor)).toEqual({
      source: 'blank',
      identity: { kind: 'project', projectId: 'p1', path: 'designs/new.fig' },
      name: '新页面',
      pageName: 'Page 1',
    });

    const first = await editor.request('document.save', { bytes: bytes('PK'), format: 'fig', baseSha256: null, reason: 'convert' });
    expect(first).toMatchObject({ ok: true, payload: { path: 'designs/new.fig', sha256: 'sha-1' } });
    expect(new Headers(calls.find((call) => call.method === 'PUT')?.init?.headers).get('if-none-match')).toBe('*');
    expect(inserts).toEqual([
      { type: 'board.insert', projectId: 'p1', select: true, drafts: [{ kind: 'design', path: 'designs/new.fig', title: '新页面', sourceNodeId: 'frame-1' }] },
    ]);
    await editor.request('document.save', { bytes: bytes('PK2'), format: 'fig', baseSha256: 'sha-1', reason: 'autosave' });
    expect(inserts).toHaveLength(1);
  });

  it('converts a project page: reads the HTML and opens it as html', async () => {
    installFetch([
      (call) => (call.url.pathname === '/api/projects/p1/raw/landing.html' ? new Response('<h1>Hi</h1>', { status: 200, headers: { 'Content-Type': 'text/html' } }) : undefined),
    ]);
    const { editor } = await mount({ document: { kind: 'convert-html', projectId: 'p1', path: 'designs/landing.fig', sourcePath: 'landing.html' } });
    expect(lastOpen(editor)).toEqual({
      source: 'html',
      identity: { kind: 'project', projectId: 'p1', path: 'designs/landing.fig' },
      name: 'landing',
      html: '<h1>Hi</h1>',
      sourcePath: 'landing.html',
    });
  });

  it('imports a local file with its bytes and name', async () => {
    installFetch([]);
    const file = new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' });
    const { editor } = await mount({ document: { kind: 'import-file', projectId: 'p1', path: 'designs/logo.fig', file } });
    const open = lastOpen(editor);
    expect(open).toMatchObject({ source: 'import', fileName: 'logo.svg', name: 'logo', identity: { kind: 'project', projectId: 'p1', path: 'designs/logo.fig' } });
    expect((open.bytes as ArrayBuffer).byteLength).toBe(6);
  });

  it('places the image of a new-from-image request after opening a blank design', async () => {
    putDesignOpenRequest('p1', 'designs/hero.fig', { kind: 'new-from-image', image: { path: 'images/hero.png', mime: 'image/png' }, title: 'Hero' });
    installFetch([
      (call) => (call.url.pathname === '/api/projects/p1/raw/images/hero.png' ? new Response(bytes('PNG!'), { status: 200, headers: { 'Content-Type': 'image/png' } }) : undefined),
    ]);
    const { editor } = await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/hero.fig' } });
    expect(lastOpen(editor)).toMatchObject({ source: 'blank', name: 'Hero' });
    await settle(() => editor.requestsOf('insert').length === 1);
    const items = (editor.requestsOf('insert')[0]?.payload as { items: Array<{ kind: string; name: string; mime: string; bytes: ArrayBuffer }> }).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'image', name: 'hero.png', mime: 'image/png' });
    expect(items[0]?.bytes.byteLength).toBe(4);
  });
});

describe('DesignEditorHost — read-only, failures', () => {
  it('keeps an .op document read-only but lets it convert into a new .fig, which then saves normally', async () => {
    const replaced = vi.fn();
    const puts: Array<{ path: string; ifNoneMatch: string | null; ifMatch: string | null }> = [];
    installFetch([
      contentRoute('designs/board.op', '{"op":1}', 'sha-op', 'op'),
      putRoute((call) => {
        const path = call.url.searchParams.get('path') ?? '';
        const headers = new Headers(call.init?.headers);
        const created = headers.get('if-none-match') === '*';
        puts.push({ path, ifNoneMatch: headers.get('if-none-match'), ifMatch: headers.get('if-match') });
        return jsonResponse(
          { design: designSummary('p1', path, created ? 'sha-fig-1' : 'sha-fig-2'), created, previousSha256: created ? null : 'sha-fig-1' },
          created ? 201 : 200,
        );
      }),
    ]);
    render(<DesignEditorHost document={{ kind: 'project', projectId: 'p1', path: 'designs/board.op' }} onDocumentReplaced={replaced} />);
    const editor = connect();
    editor.on('document.open', () => ({ ...OPEN_RESULT, format: 'op', readOnly: true }));
    await settle(() => phase() === 'editing');
    expect(screen.getByTestId('design-save-status')).toHaveAttribute('data-status', 'readOnly');

    const direct = await editor.request('document.save', { bytes: bytes('{}'), format: 'op', baseSha256: 'sha-op', reason: 'autosave' });
    expect(direct).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });

    const converted = await editor.request('document.save', { bytes: bytes('PK'), format: 'fig', baseSha256: null, reason: 'convert', targetPath: 'designs/board.fig' });
    expect(converted).toMatchObject({ ok: true, payload: { path: 'designs/board.fig', sha256: 'sha-fig-1' } });
    expect(replaced).toHaveBeenCalledWith({ projectId: 'p1', path: 'designs/board.fig' });
    await settle(() => screen.getByTestId('design-save-status').dataset.status === 'saved');

    const next = await editor.request('document.save', { bytes: bytes('PK2'), format: 'fig', baseSha256: 'sha-fig-1', reason: 'autosave' });
    expect(next).toMatchObject({ ok: true, payload: { path: 'designs/board.fig', sha256: 'sha-fig-2' } });
    expect(puts).toEqual([
      { path: 'designs/board.fig', ifNoneMatch: '*', ifMatch: null },
      { path: 'designs/board.fig', ifNoneMatch: null, ifMatch: '"sha-fig-1"' },
    ]);
  });

  it('refuses the .op conversion for viewers', async () => {
    const { calls } = installFetch([contentRoute('designs/board.op', '{"op":1}', 'sha-op', 'op')]);
    render(<DesignEditorHost document={{ kind: 'project', projectId: 'p1', path: 'designs/board.op', readOnly: true }} />);
    const editor = connect();
    editor.on('document.open', () => ({ ...OPEN_RESULT, format: 'op', readOnly: true }));
    await settle(() => phase() === 'editing');
    const converted = await editor.request('document.save', { bytes: bytes('PK'), format: 'fig', baseSha256: null, reason: 'convert', targetPath: 'designs/board.fig' });
    expect(converted).toMatchObject({ ok: false, error: { code: 'READ_ONLY' } });
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('shows the failure panel when the document is missing; Retry starts a new editor', async () => {
    installFetch([]);
    await mount({ document: { kind: 'project', projectId: 'p1', path: 'designs/missing.fig' } });
    expect(phase()).toBe('failed');
    expect(screen.getByTestId('design-editor-failed')).toHaveTextContent("Couldn't open this design: The original file was deleted or renamed.");
    const before = frame();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await settle(() => phase() === 'booting');
    expect(frame()).not.toBe(before);
    connect();
    await settle(() => phase() === 'failed');
  });

  it('shows the incompatible-editor message on a bridge version mismatch', async () => {
    installFetch([]);
    render(<DesignEditorHost document={{ kind: 'project', projectId: 'p1', path: 'designs/a.fig' }} />);
    const target = frame().contentWindow as Window;
    window.dispatchEvent(new MessageEvent('message', { data: { ...HELLO, v: 2 }, origin: window.location.origin, source: target }));
    await settle(() => phase() === 'failed');
    expect(screen.getByTestId('design-editor-failed')).toHaveTextContent("The editor version doesn't match the app. Refresh the page.");
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull();
  });

  it('reopens a project document read-only when readOnly flips true after opening without saving (O4)', async () => {
    const { calls } = installFetch([contentRoute('designs/a.fig', 'PK-a', 'sha-a')]);
    const { rerender } = render(<DesignEditorHost document={{ kind: 'project', projectId: 'p1', path: 'designs/a.fig', readOnly: false }} />);
    const editor = connect();
    await settle(() => phase() === 'editing');
    expect(lastOpen(editor)).toMatchObject({ readOnly: false });

    rerender(<DesignEditorHost document={{ kind: 'project', projectId: 'p1', path: 'designs/a.fig', readOnly: true }} />);
    // The reopen is done only once the editor's reply to the second open has come back over the port and
    // the host returned to `editing`; the request merely reaching the editor leaves the status at `loading`.
    await settle(() => editor.requestsOf('document.open').length === 2 && phase() === 'editing');
    expect(lastOpen(editor)).toMatchObject({ readOnly: true });
    expect(screen.getByTestId('design-save-status')).toHaveAttribute('data-status', 'readOnly');
    expect(calls.some((call) => call.method === 'PUT')).toBe(false);
  });

  it('keeps the iframe unfocusable and sends visibility=false in headless mode (O2)', async () => {
    installFetch([contentRoute('designs/a.fig', 'PK-a', 'sha-a')]);
    render(
      <div>
        <input data-testid="host-input" />
        <DesignEditorHost mode="headless" document={{ kind: 'project', projectId: 'p1', path: 'designs/a.fig' }} />
      </div>,
    );
    const input = screen.getByTestId('host-input');
    input.focus();
    const editor = connect();
    await settle(() => phase() === 'editing');
    expect(frame()).toHaveAttribute('tabindex', '-1');
    expect(frame()).toHaveAttribute('aria-hidden', 'true');
    expect(editor.events).toContainEqual(expect.objectContaining({ type: 'visibility', payload: { visible: false } }));
    fireEvent.focus(frame());
    expect(document.activeElement).toBe(input);
  });
});
