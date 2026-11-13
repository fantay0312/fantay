// @vitest-environment jsdom

/**
 * Publish guards and the sharing size limit as FileViewer exposes them today.
 *
 * Public sharing is owned by `TokenToSeaSharePanel`. The legacy client-side
 * share-plan preflight, Link access switch, bounded upload progress and the
 * publish-public retry/too_large taxonomy were retired with the Vela transport;
 * the 20 MB limit is enforced by the daemon's TokenToSea publish route (413)
 * and surfaced by the panel. Only HTTP is stubbed: the viewer, panel and
 * response parsing are real.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
  type WorkspaceCollabContext,
} from '@open-design/contracts';

import { FileViewer } from '../../src/components/FileViewer';
import {
  CollabProvider,
  type CollabContextValue,
} from '../../src/collab/collab-context';
import type { ProjectFile } from '../../src/types';

const analytics = vi.hoisted(() => ({
  track: vi.fn(),
  newRequestId: vi.fn(() => 'request-publish-1'),
}));

vi.mock('../../src/analytics/provider', () => ({
  useAnalytics: () => ({
    track: analytics.track,
    newRequestId: analytics.newRequestId,
  }),
}));

function teamWorkspaceContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'ws-1',
    workspaceType: 'team',
    teamId: 'team-1',
    workspaceMemberId: 'wm-1',
    role: 'member',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: null,
    providerMode: 'platform_credits',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 5, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'member', lifecycleState: 'active' }),
  };
}

function htmlFile(): ProjectFile {
  return {
    name: 'index.html',
    path: 'index.html',
    type: 'file',
    size: 1024,
    mtime: 1710000000,
    kind: 'html',
    mime: 'text/html',
    artifactManifest: {
      version: 1,
      kind: 'html',
      title: 'Page',
      entry: 'index.html',
      renderer: 'html',
      exports: ['html'],
    },
  };
}

function renderProjectFileViewer(
  context: WorkspaceCollabContext,
  props: ComponentProps<typeof FileViewer>,
) {
  const collab: CollabContextValue = {
    workspaceContext: context,
    workspaceContextLoading: false,
    enabled: true,
    member: null,
    present: [],
    publishedVersion: null,
    syncState: null,
    viewerOnly: false,
    writerAuthority: 'allowed',
    isOwner: true,
    isEffectiveOwner: true,
    isSharedNonOwner: false,
    ownerDisplayName: null,
    ownerRole: null,
    downloadPending: false,
    reportChange: () => {},
    requestPublish: () => {},
    refreshPresence: () => {},
    checkStatusNow: () => {},
  };
  const tree = (next: ComponentProps<typeof FileViewer>, nextContext = context) => (
    <CollabProvider value={{ ...collab, workspaceContext: nextContext }}>
      <FileViewer {...next} />
    </CollabProvider>
  );
  const result = render(tree(props));
  return {
    ...result,
    rerenderWith: (next: ComponentProps<typeof FileViewer>, nextContext = context) => result.rerender(tree(next, nextContext)),
  };
}

const OWNER = { id: 'tts|owner', name: 'Owner' };
/** Contract shape of a TokenToSea publication (POST /api/tokentosea/shares/publish). */
function publicationFor(url: string, id: string) {
  return { id, title: 'Page', status: 'active' as const, url, revision: 1, version: 'v1' };
}
const publication = publicationFor('https://design.tokentosea.com/s/current-response', 's15');
const sizeMessage = '每次分享最多 20 MB';
const sensitive = 'secret-raw-error-token';

/**
 * `publish` answers each POST in order (a Response or a pending promise); once
 * it is exhausted every further POST succeeds with `publication`.
 */
function stubFetch(options: { publish?: Array<Response | Promise<Response>> } = {}) {
  const queue = [...(options.publish ?? [])];
  let current: ReturnType<typeof publicationFor> | null = null;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === '/api/tokentosea/status') {
      return Response.json({ configured: true, clientId: null, redirectUri: '', signedIn: true, pending: false, user: OWNER });
    }
    if (url.startsWith('/api/tokentosea/shares?')) return Response.json({ user: OWNER, publication: current });
    if (url === '/api/tokentosea/shares/publish' && init?.method === 'POST') {
      const response = queue.length ? await queue.shift()! : Response.json(publication);
      if (response.ok) current = await response.clone().json();
      return response;
    }
    if (/^\/api\/tokentosea\/shares\/[^/]+\/comments$/.test(url)) return Response.json({ comments: [] });
    return new Response(JSON.stringify({ deployments: [] }), { status: 200 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const props: ComponentProps<typeof FileViewer> = {
  projectKind: 'prototype', projectId: 's15-project', file: htmlFile(),
  liveHtml: '<html><body>S15</body></html>',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
let write: ReturnType<typeof vi.fn>;
beforeEach(() => {
  analytics.track.mockReset();
  write = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function setup(options: Parameters<typeof stubFetch>[0] = {}) {
  const fetch = stubFetch(options);
  const view = renderProjectFileViewer(teamWorkspaceContext(), props);
  fireEvent.click(await screen.findByRole('button', { name: /^share$/i }));
  await waitFor(() => expect(publishButton()).toBeEnabled());
  return { fetch, view };
}
function publishButton() {
  return screen.getByRole('button', { name: '发布并复制链接' }) as HTMLButtonElement;
}
async function publish() {
  await act(async () => { fireEvent.click(publishButton()); });
}
function posts(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([url, init]) => String(url) === '/api/tokentosea/shares/publish' && init?.method === 'POST');
}
function postBody(call: unknown[] | undefined) {
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body)) as Record<string, unknown>;
}
function legacyPublishRequests(fetch: ReturnType<typeof vi.fn>) {
  return fetch.mock.calls.filter(([url]) => /publish-public|\/share-plan/.test(String(url)));
}

it('3639: a routing-only 3 MiB preview publishes the original file by reference, never the preview text', async () => {
  const fallback = stubFetch();
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).includes('/text-preview/')) return Promise.resolve(Response.json({
      text: '<html><body>Routing preview only</body></html>', truncated: true,
      poweredPreview: { required: false },
    }));
    return fallback(input, init);
  });
  vi.stubGlobal('fetch', fetch);
  renderProjectFileViewer(teamWorkspaceContext(), { ...props, liveHtml: undefined,
    file: { ...htmlFile(), size: 3 * 1024 * 1024 } });
  await vi.waitFor(() => expect(fetch.mock.calls.some(([url]) => String(url).includes('/text-preview/'))).toBe(true));
  const share = screen.getByRole('button', { name: /^share$/i });
  expect(share).toBeEnabled();
  expect(screen.queryByRole('button', { name: /^export$/i })).toBeNull();
  fireEvent.click(share);
  await waitFor(() => expect(publishButton()).toBeEnabled());
  await publish();
  await vi.waitFor(() => expect(posts(fetch)).toHaveLength(1));
  // The daemon reads the original file; the browser never uploads preview text.
  expect(postBody(posts(fetch)[0])).toEqual({ projectId: 's15-project', fileName: 'index.html', requestKey: expect.any(String) });
  expect(String(posts(fetch)[0]?.[1]?.body)).not.toContain('Routing preview only');
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/raw/'))).toBe(false);
  expect(legacyPublishRequests(fetch)).toEqual([]);
});

it.each(['viewerOnly', 'streaming'] as const)('3639: routing-only preview preserves %s publication guard', async restriction => {
  const fallback = stubFetch();
  const fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/text-preview/') ? Promise.resolve(Response.json({
      text: '<html><body>Preview</body></html>', truncated: true, poweredPreview: { required: false },
    })) : fallback(input, init));
  vi.stubGlobal('fetch', fetch);
  const routingOnly = { ...props, liveHtml: undefined, file: { ...htmlFile(), size: 3 * 1024 * 1024 } };
  const view = renderProjectFileViewer(teamWorkspaceContext(), { ...routingOnly, [restriction]: true });
  const share = screen.getByRole('button', { name: /^share$/i });
  if (restriction === 'viewerOnly') expect(share).toBeDisabled();
  else {
    fireEvent.click(share);
    expect(await screen.findByRole('button', { name: '发布并复制链接' })).toBeDisabled();
    // Prove the guard on a settled share read: the same action enables once
    // generation ends and goes inert again when it resumes.
    view.rerenderWith(routingOnly);
    await waitFor(() => expect(publishButton()).toBeEnabled());
    view.rerenderWith({ ...routingOnly, streaming: true });
    expect(publishButton()).toBeDisabled();
    fireEvent.click(publishButton());
  }
  expect(posts(fetch)).toHaveLength(0);
  expect(fetch.mock.calls.some(([url]) => String(url).includes('/raw/'))).toBe(false);
});

it('keeps publish inspectable but inert while streaming and restores it after completion', async () => {
  const fetch = stubFetch();
  const view = renderProjectFileViewer(teamWorkspaceContext(), { ...props, streaming: true });
  fireEvent.click(await screen.findByRole('button', { name: /^share$/i }));
  const action = await screen.findByRole('button', { name: '发布并复制链接' });
  expect(action).toBeDisabled();
  expect(screen.getByText('作品保存完成后即可发布。')).toBeVisible();
  fireEvent.click(action);
  expect(posts(fetch)).toHaveLength(0);
  expect(write).not.toHaveBeenCalled();
  view.rerenderWith({ ...props, streaming: false });
  await waitFor(() => expect(publishButton()).toBeEnabled());
  expect(screen.queryByText('作品保存完成后即可发布。')).toBeNull();
  await publish();
  await waitFor(() => expect(write).toHaveBeenCalledWith(publication.url));
  expect(posts(fetch)).toHaveLength(1);
  expect(await screen.findByText(publication.url)).toBeVisible();
  // Once generation resumes, updating the published content is inert again.
  const update = await screen.findByRole('button', { name: '更新分享内容' });
  await waitFor(() => expect(update).toBeEnabled());
  view.rerenderWith({ ...props, streaming: true });
  expect(update).toBeDisabled();
  fireEvent.click(update);
  expect(posts(fetch)).toHaveLength(1);
});

it('daemon 413 size limit ends publishing, explains the limit and retries only on demand', async () => {
  const { fetch } = await setup({ publish: [Response.json({ error: sizeMessage }, { status: 413 })] });
  await publish();
  expect(await screen.findByRole('alert')).toHaveTextContent(sizeMessage);
  await waitFor(() => expect(publishButton()).toBeEnabled());
  expect(screen.queryByRole('button', { name: '正在发布…' })).toBeNull();
  expect(write).not.toHaveBeenCalled();
  // A status re-read (focus) never re-uploads the failed package.
  await act(async () => { window.dispatchEvent(new Event('focus')); });
  expect(posts(fetch)).toHaveLength(1);
  await publish();
  await waitFor(() => expect(write).toHaveBeenCalledWith(publication.url));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(posts(fetch)).toHaveLength(2);
  // The manual retry repeats the same idempotent publish request.
  expect(postBody(posts(fetch)[1])).toEqual(postBody(posts(fetch)[0]));
  expect(write.mock.calls).toEqual([[publication.url]]);
});

it('S15 closes an over-limit panel and permits a fresh publish after the same HTML is reduced', async () => {
  const { view, fetch } = await setup({ publish: [Response.json({ error: sizeMessage }, { status: 413 })] });
  await publish();
  expect(await screen.findByText(sizeMessage)).toBeVisible();
  expect(posts(fetch)).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  await act(async () => view.rerenderWith({ ...props, file: { ...htmlFile(),
    size: 512, mtime: htmlFile().mtime + 1 },
    liveHtml: '<html><body>smaller</body></html>',
  }));
  expect(posts(fetch)).toHaveLength(1); // Editing a failed package must not auto-upload.
  fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  expect(screen.queryByText(sizeMessage)).toBeNull();
  await waitFor(() => expect(publishButton()).toBeEnabled());
  expect(posts(fetch)).toHaveLength(1); // Reopening only offers a fresh manual attempt.
  await publish();
  expect(await screen.findByText(publication.url)).toBeVisible();
  expect(posts(fetch)).toHaveLength(2);
  expect(write).toHaveBeenCalledExactlyOnceWith(publication.url);
});

it.each(['file', 'project'] as const)('clears a size-limit error when changing %s', async change => {
  const { view, fetch } = await setup({ publish: [Response.json({ error: sizeMessage }, { status: 413 })] });
  await publish();
  expect(await screen.findByText(sizeMessage)).toBeVisible();
  await act(async () => view.rerenderWith({
    ...props,
    ...(change === 'project' ? { projectId: 'next-project' } :
      { file: { ...htmlFile(), name: 'next.html', path: 'next.html' } }),
  }));
  expect(screen.queryByText(sizeMessage)).toBeNull();
  expect(posts(fetch)).toHaveLength(1);
});

it('clipboard rejection preserves the successful publication and offers a manual copy', async () => {
  await setup();
  write.mockRejectedValueOnce(new Error(sensitive));
  await publish();
  expect(await screen.findByText(publication.url)).toBeVisible();
  expect(screen.getByText('分享已发布，可复制下方链接').getAttribute('role')).toBe('status');
  expect(screen.queryByRole('alert')).toBeNull();
  expect(document.body.textContent).not.toContain(sensitive);
  const copy = screen.getByRole('button', { name: '复制链接' });
  await waitFor(() => expect(copy).toBeEnabled());
  await act(async () => { fireEvent.click(copy); });
  expect(await screen.findByText('链接已复制')).toBeVisible();
  expect(write.mock.calls).toEqual([[publication.url], [publication.url]]);
});

it.each(['file', 'project'] as const)('ignores a late publish after changing %s while a new publish is pending', async change => {
  const old = deferred<Response>();
  const next = deferred<Response>();
  const { view, fetch } = await setup({ publish: [old.promise, next.promise] });
  await publish();
  expect(screen.getByRole('button', { name: '正在发布…' })).toBeDisabled();
  const nextProps = { ...props,
    ...(change === 'project' ? { projectId: 'next-project' } :
      { file: { ...htmlFile(), name: 'next.html', path: 'next.html' } }) };
  await act(async () => view.rerenderWith(nextProps));
  if (screen.getByRole('button', { name: /^share$/i }).getAttribute('aria-expanded') !== 'true') {
    fireEvent.click(screen.getByRole('button', { name: /^share$/i }));
  }
  await waitFor(() => expect(publishButton()).toBeEnabled());
  await publish();
  await act(async () => old.resolve(Response.json(publication)));
  expect(write).not.toHaveBeenCalled();
  expect(screen.queryByText(publication.url)).toBeNull();
  expect(screen.getByRole('button', { name: '正在发布…' })).toBeDisabled();
  const nextPublication = publicationFor('https://design.tokentosea.com/s/next-response', 'next');
  await act(async () => next.resolve(Response.json(nextPublication)));
  await waitFor(() => expect(write.mock.calls).toEqual([[nextPublication.url]]));
  expect(await screen.findByText(nextPublication.url)).toBeVisible();
  expect(posts(fetch)).toHaveLength(2);
  expect(postBody(posts(fetch)[1])).toMatchObject(change === 'project'
    ? { projectId: 'next-project', fileName: 'index.html' }
    : { projectId: 's15-project', fileName: 'next.html' });
});
