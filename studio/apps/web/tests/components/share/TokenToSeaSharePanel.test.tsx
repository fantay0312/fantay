// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
import { TokenToSeaSharePanel } from '../../../src/components/share/TokenToSeaSharePanel';
import { PROJECT_SHARE_HISTORY_CHANGED_EVENT } from '../../../src/components/share/share-publication-events';

const user = { id: 'tts|owner', name: 'Owner' };
const publication = { id: 'share-1', title: 'Page', status: 'active' as const, url: 'https://design.tokentosea.com/s/share-1', revision: 1, version: 'v1' };
const PUBLISH = '/api/tokentosea/shares/publish';
// The in-flight publish store is module-level by design; give every test its own document.
let projectSequence = 0;
let projectId = '';
let write: ReturnType<typeof vi.fn>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
/** `publish` answers each publish POST in order; once exhausted every publish succeeds. */
function stub(options: { published?: boolean; publish?: Array<Response | Promise<Response>>; status?: () => Response } = {}) {
  const queue = [...(options.publish ?? [])];
  let current: typeof publication | null = options.published ? publication : null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === '/api/tokentosea/status') return Response.json({ configured: true, clientId: null, redirectUri: '', signedIn: true, pending: false, user });
    if (url.startsWith('/api/tokentosea/shares?')) return options.status?.() ?? Response.json({ user, publication: current });
    if (url === PUBLISH && init?.method === 'POST') {
      const response = queue.length ? await queue.shift()! : Response.json(publication);
      if (response.ok) current = await response.clone().json();
      return response;
    }
    if (url.endsWith('/state') && init?.method === 'POST') {
      current = { ...publication, status: JSON.parse(String(init.body)).status };
      return Response.json(current);
    }
    if (url.endsWith('/comments')) return Response.json({ comments: [] });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}
const posts = (fetchMock: ReturnType<typeof vi.fn>, path = PUBLISH) =>
  fetchMock.mock.calls.filter(([url, init]) => String(url) === path && (init as RequestInit | undefined)?.method === 'POST');
const postBody = (call: unknown[] | undefined) => JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
const panel = (disabled = false) => <TokenToSeaSharePanel projectId={projectId} fileName="index.html" disabled={disabled} />;

beforeEach(() => {
  projectId = `panel-project-${++projectSequence}`;
  vi.stubGlobal('crypto', webcrypto);
  write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it('blocks copy and stop/resume, not only publish, while disabled (viewer-only or streaming)', async () => {
  const fetchMock = stub({ published: true });
  const view = render(panel(true));
  const copy = await screen.findByRole('button', { name: '复制链接' });
  const stop = screen.getByRole('button', { name: '停止分享' });
  // Wait for the status read to settle so only the disabled prop holds the controls.
  await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/comments'))).toBe(true));
  await act(async () => {});
  for (const control of [copy, stop, screen.getByRole('button', { name: '更新分享内容' })]) {
    expect(control).toBeDisabled();
    fireEvent.click(control);
  }
  expect(write).not.toHaveBeenCalled();
  expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === 'POST')).toEqual([]);
  view.rerender(panel(false));
  await waitFor(() => expect(screen.getByRole('button', { name: '停止分享' })).toBeEnabled());
  expect(screen.getByRole('button', { name: '复制链接' })).toBeEnabled();
});

it('keeps an in-flight publish across a remount: no second publish, and the reopened panel completes it', async () => {
  const held = deferred<Response>();
  const fetchMock = stub({ publish: [held.promise] });
  const first = render(panel());
  const publish = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(publish).toBeEnabled());
  fireEvent.click(publish);
  expect(screen.getByRole('button', { name: '正在发布…' })).toBeDisabled();
  first.unmount(); // Closing the Share popover unmounts the panel.
  render(panel());
  const reopened = await screen.findByRole('button', { name: '正在发布…' });
  await waitFor(() => expect(fetchMock.mock.calls.filter(([url]) => String(url).startsWith('/api/tokentosea/shares?')).length).toBeGreaterThan(1));
  expect(reopened).toBeDisabled();
  fireEvent.click(reopened);
  expect(posts(fetchMock)).toHaveLength(1);
  await act(async () => held.resolve(Response.json(publication)));
  expect(await screen.findByText('分享链接已复制')).toBeVisible();
  expect(screen.getByRole('link', { name: publication.url })).toBeVisible();
  // Both the closed and the reopened panel observed the publish; it is copied once.
  expect(write.mock.calls).toEqual([[publication.url]]);
  expect(posts(fetchMock)).toHaveLength(1);
});

it('reuses the in-flight request key when a publish that failed after a remount is retried', async () => {
  const held = deferred<Response>();
  const fetchMock = stub({ publish: [held.promise] });
  const first = render(panel());
  const publish = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(publish).toBeEnabled());
  fireEvent.click(publish);
  first.unmount();
  render(panel());
  await screen.findByRole('button', { name: '正在发布…' });
  await act(async () => held.resolve(Response.json({ error: '发布暂时失败' }, { status: 503 })));
  expect(await screen.findByRole('alert')).toHaveTextContent('发布暂时失败');
  const retry = screen.getByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(retry).toBeEnabled());
  await act(async () => fireEvent.click(retry));
  await waitFor(() => expect(write).toHaveBeenCalledWith(publication.url));
  expect(posts(fetchMock)).toHaveLength(2);
  expect(postBody(posts(fetchMock)[1]).requestKey).toBe(postBody(posts(fetchMock)[0]).requestKey);
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['publish', 'status'] as const)('shows a readable error for a non-JSON %s failure (proxy HTML 502)', async route => {
  const html = () => new Response('<html><body>502 Bad Gateway</body></html>', { status: 502, headers: { 'Content-Type': 'text/html' } });
  let failStatus = false;
  stub({ publish: [html()], status: () => failStatus ? html() : Response.json({ user, publication: null }) });
  render(panel());
  const publish = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(publish).toBeEnabled());
  if (route === 'publish') fireEvent.click(publish);
  else { failStatus = true; await act(async () => { window.dispatchEvent(new Event('focus')); }); }
  expect(await screen.findByRole('alert')).toHaveTextContent('分享服务暂时不可用');
  expect(document.body.textContent).not.toMatch(/SyntaxError|Unexpected token|JSON/);
});

it('clears a failed-copy error once a later copy succeeds', async () => {
  stub({ published: true });
  render(panel());
  const copy = await screen.findByRole('button', { name: '复制链接' });
  await waitFor(() => expect(copy).toBeEnabled());
  write.mockRejectedValueOnce(new Error('denied'));
  await act(async () => fireEvent.click(copy));
  expect(await screen.findByRole('alert')).toHaveTextContent('请手动复制链接');
  await act(async () => fireEvent.click(copy));
  expect(await screen.findByText('链接已复制')).toBeVisible();
  expect(screen.queryByRole('alert')).toBeNull();
});

it('announces project share history after a successful publish only', async () => {
  const changed = vi.fn();
  window.addEventListener(PROJECT_SHARE_HISTORY_CHANGED_EVENT, changed);
  try {
    stub({ publish: [Response.json({ error: '每次分享最多 20 MB' }, { status: 413 })] });
    render(panel());
    const publish = await screen.findByRole('button', { name: '发布并复制链接' });
    await waitFor(() => expect(publish).toBeEnabled());
    await act(async () => fireEvent.click(publish));
    expect(await screen.findByRole('alert')).toHaveTextContent('每次分享最多 20 MB');
    expect(changed).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByRole('button', { name: '发布并复制链接' })).toBeEnabled());
    await act(async () => fireEvent.click(screen.getByRole('button', { name: '发布并复制链接' })));
    await waitFor(() => expect(changed).toHaveBeenCalledTimes(1));
    expect((changed.mock.calls[0]![0] as CustomEvent).detail).toEqual({ projectId });
  } finally {
    window.removeEventListener(PROJECT_SHARE_HISTORY_CHANGED_EVENT, changed);
  }
});
