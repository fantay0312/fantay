// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { FileViewer } from '../../src/components/FileViewer';

const publication = { id: 'public-share', url: 'https://design.tokentosea.com/s/public-share', title: 'Design', status: 'active', revision: 1, version: 'v1' };
const user = { id: 'tts|alice', name: 'Alice' };
const props: ComponentProps<typeof FileViewer> = { projectKind: 'prototype', projectId: 'proj', file: { name: 'index.html', path: 'index.html', type: 'file', size: 123, mtime: 1, kind: 'html', mime: 'text/html', artifactManifest: { version: 1, kind: 'html', title: 'Page', entry: 'index.html', renderer: 'html', exports: ['html'] } }, liveHtml: '<html><body>share fixture</body></html>' };
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
function route(read: () => Response | Promise<Response>, mutate?: (url: string, body: Record<string, unknown>) => Response) {
  const request = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/tokentosea/shares') && init?.method === 'POST') return mutate?.(url, JSON.parse(String(init.body))) ?? Response.json(publication);
    if (url.startsWith('/api/tokentosea/shares?')) return read();
    if (url.endsWith('/comments')) return Response.json({ comments: [] });
    if (url === '/api/tokentosea/status') return Response.json({ configured: true, signedIn: false, user: null });
    return Response.json({ deployments: [] });
  }); vi.stubGlobal('fetch', request); return request;
}
async function open(next = props) { const view = render(<FileViewer {...next} />); await act(async () => fireEvent.click(await screen.findByRole('button', { name: /^share$/i }))); return view; }
function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
it('restores a TokenToSea link without a Vela workspace or republishing', async () => {
  const request = route(() => Response.json({ user, publication })); await open();
  expect(await screen.findByText(publication.url)).toBeVisible();
  const legacyRequests = request.mock.calls.map(([u]) => String(u)).filter(u => /publish-public|integrations\/vela/.test(u));
  expect(legacyRequests).toEqual([]);
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('keeps a known link visible if a later status read fails', async () => {
  let fail = false; route(() => fail ? Response.json({ error: 'Temporary outage' }, { status: 503 }) : Response.json({ user, publication })); await open();
  expect(await screen.findByText(publication.url)).toBeVisible(); fail = true;
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Temporary outage')).toBeVisible(); expect(screen.getByText(publication.url)).toBeVisible();
});
it.each(['file', 'project'] as const)('ignores an old TokenToSea response after changing %s', async change => {
  const held = deferred<Response>(); let reads = 0;
  route(() => ++reads === 1 ? held.promise : Response.json({ user, publication: null })); const view = await open();
  const next = change === 'file' ? { ...props, file: { ...props.file, name: 'other.html', path: 'other.html' } } : { ...props, projectId: 'other-project' };
  view.rerender(<FileViewer {...next} />);
  await waitFor(() => expect(reads).toBeGreaterThan(1));
  await act(async () => held.resolve(Response.json({ user, publication })));
  expect(screen.queryByText(publication.url)).toBeNull();
});
it('clears the previous account link on a new TokenToSea account read', async () => {
  let account = user; route(() => Response.json({ user: account, publication: account === user ? publication : null })); await open();
  expect(await screen.findByText(publication.url)).toBeVisible(); account = { id: 'tts|bob', name: 'Bob' };
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('Bob')).toBeVisible(); expect(screen.queryByText(publication.url)).toBeNull();
});
it('publishes through the TokenToSea route with an idempotency key', async () => {
  let result: typeof publication | null = null;
  const request = route(() => Response.json({ user, publication: result }), (_url, body) => { expect(body).toMatchObject({ projectId: 'proj', fileName: 'index.html' }); expect(typeof body.requestKey).toBe('string'); result = publication; return Response.json(publication); });
  await open(); fireEvent.click(await screen.findByRole('button', { name: '发布并复制链接' }));
  expect(await screen.findByText(publication.url)).toBeVisible(); expect(request.mock.calls.some(([url]) => String(url).includes('/api/tokentosea/shares/publish'))).toBe(true);
});
it('stops and resumes the same TokenToSea link', async () => {
  let status = 'active'; route(() => Response.json({ user, publication: { ...publication, status } }), (_url, body) => { status = String(body.status); return Response.json({ ...publication, status }); });
  await open(); fireEvent.click(await screen.findByRole('button', { name: '停止分享' }));
  fireEvent.click(await screen.findByRole('button', { name: '恢复同一链接' }));
  expect(await screen.findByRole('button', { name: '停止分享' })).toBeVisible(); expect(screen.getByText(publication.url)).toBeVisible();
});
it('uses TokenToSea login for a signed-out publisher', async () => {
  route(() => Response.json({ user: null, publication: null })); await open();
  // The viewer renders without an I18nProvider, so the account button uses the en dictionary.
  expect(await screen.findByRole('button', { name: 'Sign in with TokenToSea' })).toBeVisible();
  expect(screen.queryByRole('button', { name: '发布并复制链接' })).toBeNull();
});
