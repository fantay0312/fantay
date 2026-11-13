// @vitest-environment jsdom
/**
 * TokenToSea publishes the saved file, so the Share panel must refuse to
 * publish while Manual Edit can still change those bytes (FileViewer's
 * shareSourceSettled edit gate), and accept again once editing ends.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { FileViewer } from '../../src/components/FileViewer';
import type { ProjectFile } from '../../src/types';

const source = '<!doctype html><html><body><main data-od-id="hero">Hero</main></body></html>';
const file: ProjectFile = {
  name: 'preview.html', path: 'preview.html', type: 'file', size: 1024, mtime: 1710000000, mime: 'text/html', kind: 'html',
  artifactManifest: { version: 1, kind: 'html', title: 'Preview', entry: 'preview.html', renderer: 'html', exports: ['html'] },
};
const user = { id: 'tts|owner', name: 'Owner' };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

function stubFetch() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/tokentosea/status') return Response.json({ configured: true, clientId: null, redirectUri: '', signedIn: true, pending: false, user });
    if (url.startsWith('/api/tokentosea/shares?')) return Response.json({ user, publication: null });
    if (url === '/api/tokentosea/shares/publish' && init?.method === 'POST') {
      return Response.json({ id: 's', title: 'Preview', status: 'active', url: 'https://design.tokentosea.com/s/s', revision: 1, version: 'v1' });
    }
    if (url.startsWith('/api/tokentosea/')) return Response.json({});
    return new Response(source, { status: 200, headers: { 'Content-Type': 'text/html' } });
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', webcrypto);
  return fetchMock;
}

async function enterManualEditMode() {
  const frame = await waitFor(() => {
    const node = screen.getByTestId('artifact-preview-frame') as HTMLIFrameElement;
    if (!node.contentWindow) throw new Error('Preview frame not ready');
    return node;
  });
  const postMessage = vi.spyOn(frame.contentWindow!, 'postMessage');
  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  const capture = postMessage.mock.calls.map(([value]) => value)
    .find(value => (value as { type?: unknown } | null)?.type === 'od:preview-runtime-state-capture') as { id: string } | undefined;
  if (capture) {
    act(() => {
      window.dispatchEvent(new MessageEvent('message', {
        data: { type: 'od:preview-runtime-state-captured', id: capture.id, state: { version: 1, hash: '', htmlAttrs: {}, bodyAttrs: {}, entries: [] } },
        source: frame.contentWindow,
      }));
    });
  }
  await waitFor(() => expect(screen.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'true'));
}

it('refuses TokenToSea publishing while Manual Edit is on and allows it once editing ends', async () => {
  const fetchMock = stubFetch();
  render(<FileViewer projectId="manual-edit-share-guard" projectKind="prototype" file={file} liveHtml={source} />);
  fireEvent.click(await screen.findByRole('button', { name: /^share$/i }));
  const publish = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(publish).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }));

  await enterManualEditMode();
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  const guarded = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/tokentosea/shares?')).length).toBeGreaterThan(1));
  await act(async () => {});
  expect(guarded).toBeDisabled();
  expect(screen.getByText('作品保存完成后即可发布。')).toBeVisible();
  fireEvent.click(guarded);
  expect(fetchMock.mock.calls.some(([url, init]) => String(url) === '/api/tokentosea/shares/publish' && init?.method === 'POST')).toBe(false);

  fireEvent.click(screen.getByTestId('manual-edit-mode-toggle'));
  await waitFor(() => expect(screen.getByTestId('manual-edit-mode-toggle')).toHaveAttribute('aria-pressed', 'false'));
  if (!screen.queryByTestId('tokentosea-share-panel')) fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  await waitFor(() => expect(screen.getByRole('button', { name: '发布并复制链接' })).toBeEnabled());
});
