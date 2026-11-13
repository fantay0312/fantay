// @vitest-environment jsdom
/**
 * Share popover shell and the TokenToSea share panel it hosts.
 *
 * The legacy ShareTab (OpenDesign/Vela publish-public link, Link access switch,
 * workspace visibility scope and its byte-exact DOM baseline) is no longer
 * rendered by FileViewer: `TokenToSeaSharePanel` owns public sharing and the
 * Vela transport stays inactive. These specs pin the shell that survived the
 * swap (one popover, header with deployment, Close) and the TokenToSea flows
 * reachable from both the toolbar and the artifact-card entry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { WorkspaceCollabContext } from '@open-design/contracts';
import {
  buildWorkspacePermissions,
  buildWorkspaceSeatSummary,
} from '@open-design/contracts';

import { FileViewer } from '../../src/components/FileViewer';
import { CollabProvider, type CollabContextValue } from '../../src/collab/collab-context';
import { resetConsumedActionRequestsForTests } from '../../src/runtime/action-request';
import type { ProjectFile } from '../../src/types';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  resetConsumedActionRequestsForTests();
});

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
      version: 1, kind: 'html', title: 'Page', entry: 'index.html',
      renderer: 'html', exports: ['html'],
    },
  } as ProjectFile;
}

const SHARE_URL = 'https://design.tokentosea.com/s/stable-share';
const OWNER = { id: 'tts|owner', name: 'Owner' };
type Publication = { id: string; title: string; status: 'active' | 'stopped'; url: string; revision: number; version: string };
function activePublication(): Publication {
  return { id: 'stable-share', title: 'Page', status: 'active', url: SHARE_URL, revision: 1, version: 'v1' };
}

/**
 * TokenToSea share routes as the daemon proxies them (identity only, no tokens),
 * plus the deploy reads the header's provider menu performs.
 */
function stubFetch(options: { signedIn?: boolean; published?: boolean } = {}) {
  const { signedIn = true } = options;
  let current: Publication | null = options.published ? activePublication() : null;
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof Request ? input.url : String(input);
    const method = init?.method ?? 'GET';
    if (url === '/api/tokentosea/status') {
      return Response.json({ configured: true, clientId: null, redirectUri: '', signedIn, pending: false, user: signedIn ? OWNER : null });
    }
    if (url.startsWith('/api/tokentosea/shares?')) {
      return Response.json({ user: signedIn ? OWNER : null, publication: signedIn ? current : null });
    }
    if (url === '/api/tokentosea/shares/publish' && method === 'POST') {
      current = activePublication();
      return Response.json(current);
    }
    if (/^\/api\/tokentosea\/shares\/[^/]+\/state$/.test(url) && method === 'POST' && current) {
      const body = JSON.parse(String(init?.body)) as { status: Publication['status'] };
      current = { ...current, status: body.status, revision: current.revision + 1 };
      return Response.json(current);
    }
    if (/^\/api\/tokentosea\/shares\/[^/]+\/comments$/.test(url)) return Response.json({ comments: [] });
    if (url.includes('/deployments')) return Response.json({ deployments: [] });
    if (url.includes('/deploy/config')) return Response.json({ providerId: 'cloudflare-pages', configured: false });
    return Response.json({});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

type FetchMock = ReturnType<typeof stubFetch>;
/** Every TokenToSea write (publish, stop/resume, comment). Reads are GETs. */
function shareWrites(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([input, init]) =>
    String(input).startsWith('/api/tokentosea/shares') && (init?.method ?? 'GET') !== 'GET');
}
/** The retired OpenDesign/Vela publish-public transport must stay silent. */
function legacyPublishRequests(fetchMock: FetchMock) {
  return fetchMock.mock.calls.filter(([input]) => String(input).includes('publish-public'));
}

function teamContext(): WorkspaceCollabContext {
  return {
    workspaceId: 'workspace-a',
    workspaceType: 'team',
    workspaceMemberId: 'member-a',
    role: 'owner',
    memberStatus: 'active',
    lifecycleState: 'active',
    billingState: 'active',
    planId: 'team_plus',
    providerMode: 'platform_credits',
    teamId: 'team-workspace-a',
    seatSummary: buildWorkspaceSeatSummary({ seatLimit: 3, usedSeats: 1 }),
    permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
  };
}

function collabValue(workspaceContext: WorkspaceCollabContext | null): CollabContextValue {
  return {
    workspaceContext,
    workspaceContextLoading: false,
    enabled: false,
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
}

function renderViewer(workspaceContext: WorkspaceCollabContext | null, options: { streaming?: boolean; viewerOnly?: boolean; shareRequest?: { nonce: number; anchorId: string } } = {}) {
  const viewer = (
    <>
    {options.shareRequest ? <button data-artifact-anchor={options.shareRequest.anchorId}>Card Share</button> : null}
    <FileViewer
      projectId="project-1"
      projectKind="prototype"
      file={htmlFile()}
      liveHtml="<html><body><h1>Hello</h1></body></html>"
      streaming={options.streaming}
      viewerOnly={options.viewerOnly}
      shareRequest={options.shareRequest}
    />
    </>
  );
  if (!workspaceContext) return render(viewer);
  return render(<CollabProvider value={collabValue(workspaceContext)}>{viewer}</CollabProvider>);
}

function toolbarAction(label: 'Share' | 'Export'): HTMLButtonElement {
  const node = document.querySelector<HTMLButtonElement>(
    `button.chrome-action-unified[aria-label="${label}"]`,
  );
  if (!node) throw new Error(`toolbar ${label} button not rendered`);
  return node;
}

async function openSharePanel(
  options: Parameters<typeof stubFetch>[0] = {},
  workspaceContext: WorkspaceCollabContext | null = null,
): Promise<HTMLElement> {
  stubFetch(options);
  renderViewer(workspaceContext);
  await waitFor(() =>
    expect(document.querySelector('button.chrome-action-unified[aria-label="Share"]')).not.toBeNull(),
  );
  fireEvent.click(toolbarAction('Share'));
  return screen.findByTestId('tokentosea-share-panel');
}

it('does not publish from an open TokenToSea share panel once the viewer turns read-only', async () => {
  const request = stubFetch();
  const context = teamContext();
  const file = htmlFile();
  function Host({ readOnly }: { readOnly: boolean }) {
    return <CollabProvider value={collabValue(context)}><FileViewer projectId="project-1" projectKind="prototype" file={file} liveHtml="<html><body>Hello</body></html>" viewerOnly={readOnly} /></CollabProvider>;
  }
  const { rerender } = render(<Host readOnly={false} />);
  fireEvent.click(toolbarAction('Share'));
  const publish = await screen.findByRole('button', { name: '发布并复制链接' });
  await waitFor(() => expect(publish).toBeEnabled());
  rerender(<Host readOnly />);
  // Viewer-only permission keeps the panel inspectable but cannot publish.
  await waitFor(() => expect(screen.getByRole('button', { name: '发布并复制链接' })).toBeDisabled());
  fireEvent.click(screen.getByRole('button', { name: '发布并复制链接' }));
  expect(shareWrites(request)).toEqual([]);
  expect(legacyPublishRequests(request)).toEqual([]);
});

describe('Z11a · 分享面板外壳', () => {
  it('未登录 TokenToSea:分享面板提示用 TokenToSea 账号登录后发布', async () => {
    const panel = await openSharePanel({ signedIn: false });
    expect(panel).toHaveTextContent('通过 TokenToSea 分享');
    expect(await within(panel).findByRole('button', { name: 'Sign in with TokenToSea' })).toBeVisible();
    expect(panel).toHaveTextContent('使用你的 TokenToSea 账号发布和管理分享。');
    expect(within(panel).queryByRole('button', { name: '发布并复制链接' })).toBeNull();
    expect(screen.getByRole('heading', { name: 'Share', level: 2 })).toBeVisible();
  });

  /**
   * 页签按钮**不走基线**。它们身上会多出一个 `export-ready-nudge` 类,出现与否
   * 取决于时序,拿它做逐字节基线必然间歇性发红 —— 而发红的守卫最后都会被关掉。
   * 它们本来也不随面板搬走,所以这里只钉住「还是那两枚、顺序没变、都还在同一个
   * 外壳里」。
   */
  it('页签按钮那一对留在原地,不随面板搬走', async () => {
    stubFetch();
    renderViewer(null);
    await waitFor(() =>
      expect(document.querySelector('button.chrome-action-unified[aria-label="Share"]')).not.toBeNull(),
    );
    const bar = toolbarAction('Share').parentElement;
    expect(bar, '两枚页签按钮的外壳没了').not.toBeNull();

    const labels = [...bar!.querySelectorAll('button.chrome-action-unified')].map((b) =>
      b.getAttribute('aria-label'),
    );
    expect(labels, 'Export 在前、Share 在后的顺序变了').toEqual(['Export', 'Share']);
    expect(
      toolbarAction('Share').parentElement,
      '两枚按钮被拆到了不同的外壳里',
    ).toBe(toolbarAction('Export').parentElement);
    expect(bar!.closest('.share-menu'), '按钮外壳脱离了 .share-menu').not.toBeNull();
  });
});

describe('OPEND-3796 share error explanations', () => {
  it.each([
    ['a daemon-owned explanation', { error: '入口文件与 index.html 冲突，请重命名后分享', stderr: 'private-child-output' }, '入口文件与 index.html 冲突，请重命名后分享'],
    ['a structured failure', { error: { code: 'UPSTREAM', detail: 'private-child-output' } }, '分享服务暂时不可用'],
  ] as const)('renders %s without raw diagnostics or an implicit retry', async (_case, body, message) => {
    const fetchMock = stubFetch();
    const fallback = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input, init) => {
      if (String(input) === '/api/tokentosea/shares/publish' && init?.method === 'POST') {
        return Response.json(body, { status: 409 });
      }
      return fallback(input, init);
    });
    renderViewer(teamContext());
    fireEvent.click(toolbarAction('Share'));
    const publish = await screen.findByRole('button', { name: '发布并复制链接' });
    await waitFor(() => expect(publish).toBeEnabled());
    fireEvent.click(publish);
    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    // The same action stays available as an explicit, user-initiated retry.
    await waitFor(() => expect(screen.getByRole('button', { name: '发布并复制链接' })).toBeEnabled());
    expect(document.body).not.toHaveTextContent('private-child-output');
    expect(shareWrites(fetchMock)).toHaveLength(1);
  });
});

describe('Shared share shell header', () => {
  it.each([false, true])('keeps deployment in the header ahead of the TokenToSea action, published=%s', async published => {
    stubFetch({ published });
    renderViewer(teamContext());
    fireEvent.click(toolbarAction('Share'));
    const action = published
      ? await screen.findByRole('button', { name: '复制链接' })
      : await screen.findByRole('button', { name: '发布并复制链接' });
    const heading = screen.getByRole('heading', { name: 'Share', level: 2 });
    const more = screen.getByRole('button', { name: 'More sharing options' });
    expect(heading.parentElement).toContainElement(more);
    expect(heading.compareDocumentPosition(action) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(more);
    expect(screen.getByRole('menuitem', { name: /Deploy to Vercel/i })).toBeVisible();
  });
  it.each([
    ['toolbar', false], ['toolbar', true], ['artifact-card', false], ['artifact-card', true],
  ] as const)('%s published=%s closes and reopens without changing publication', async (origin, published) => {
    const fetchMock = stubFetch({ published });
    renderViewer(teamContext(), origin === 'artifact-card'
      ? { shareRequest: { nonce: 701, anchorId: 'header-card' } } : {});
    if (origin === 'toolbar') fireEvent.click(toolbarAction('Share'));
    if (published) await screen.findByRole('link', { name: SHARE_URL });
    else await screen.findByRole('button', { name: '发布并复制链接' });
    const heading = await screen.findByRole('heading', { name: 'Share', level: 2 });
    expect(heading.parentElement?.nextElementSibling).toHaveAttribute('data-testid', 'tokentosea-share-panel');
    if (published) expect(screen.getByRole('link', { name: SHARE_URL })).toHaveAttribute('href', SHARE_URL);
    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveAccessibleName('Close');
    expect(close).toBeEnabled();
    fireEvent.click(close);
    expect(screen.queryByRole('heading', { name: 'Share' })).toBeNull();
    expect(screen.queryByTestId('tokentosea-share-panel')).toBeNull();
    fireEvent.click(toolbarAction('Share'));
    await screen.findByRole('heading', { name: 'Share' });
    if (published) expect(await screen.findByRole('link', { name: SHARE_URL })).toHaveAttribute('href', SHARE_URL);
    expect(shareWrites(fetchMock)).toEqual([]);
    expect(legacyPublishRequests(fetchMock)).toEqual([]);
  });
});

describe('G4 · TokenToSea publishing from both share entries', () => {
  it.each(['toolbar', 'artifact-card'] as const)('%s publishes through TokenToSea without the retired OpenDesign label', async (origin) => {
    const fetchMock = stubFetch();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } });
    renderViewer(teamContext(), origin === 'artifact-card'
      ? { shareRequest: { nonce: 401, anchorId: 'g4-card' } } : {});
    expect(toolbarAction('Share')).toBeEnabled();
    if (origin === 'toolbar') fireEvent.click(toolbarAction('Share'));
    const publish = await screen.findByRole('button', { name: '发布并复制链接' });
    await waitFor(() => expect(publish).toBeEnabled());
    expect(screen.queryByText('QUICK SHARE · OPENDESIGN')).toBeNull();
    expect(screen.getAllByTestId('tokentosea-share-panel')).toHaveLength(1);
    if (origin === 'artifact-card') expect(document.querySelector('[data-artifact-anchor="g4-card"]')).not.toBeNull();
    fireEvent.click(publish);
    expect(await screen.findByText('分享链接已复制')).toBeVisible();
    expect(writeText).toHaveBeenCalledWith(SHARE_URL);
    expect(screen.getByRole('link', { name: SHARE_URL })).toHaveAttribute('href', SHARE_URL);
    const writes = shareWrites(fetchMock);
    expect(writes.map(([input, init]) => [String(input), init?.method])).toEqual([['/api/tokentosea/shares/publish', 'POST']]);
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ projectId: 'project-1', fileName: 'index.html', requestKey: expect.any(String) });
    expect(legacyPublishRequests(fetchMock)).toEqual([]);
  });

  it.each(['toolbar', 'artifact-card'] as const)('%s hydrates the exact publication URL and keeps copy/stop usable', async (origin) => {
    const fetchMock = stubFetch({ published: true });
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { userAgent: navigator.userAgent, clipboard: { writeText } });
    renderViewer(teamContext(), origin === 'artifact-card'
      ? { shareRequest: { nonce: 402, anchorId: 'g4-published-card' } } : {});
    if (origin === 'toolbar') fireEvent.click(toolbarAction('Share'));
    const link = await screen.findByRole('link', { name: SHARE_URL });
    expect(link).toHaveAttribute('href', SHARE_URL);
    expect(screen.getByText('链接分享中')).toBeVisible();
    expect(screen.queryByText('QUICK SHARE · OPENDESIGN')).toBeNull();
    const copy = screen.getByRole('button', { name: '复制链接' });
    await waitFor(() => expect(copy).toBeEnabled());
    fireEvent.click(copy);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(SHARE_URL));
    expect(await screen.findByText('链接已复制')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '停止分享' }));
    // A stopped share resumes the same link; it is never re-published.
    expect(await screen.findByText('分享已停止')).toBeVisible();
    expect(screen.getByRole('button', { name: '恢复同一链接' })).toBeVisible();
    expect(screen.queryByRole('button', { name: '发布并复制链接' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更新分享内容' })).toBeNull();
    const writes = shareWrites(fetchMock);
    expect(writes.map(([input]) => String(input))).toEqual(['/api/tokentosea/shares/stable-share/state']);
    expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({ status: 'stopped', revision: 1 });
    expect(legacyPublishRequests(fetchMock)).toEqual([]);
  });
});

describe('S12 · HTML share menu', () => {
  it.each(['streaming', 'viewerOnly'] as const)('keeps provider actions disabled while %s', async (restriction) => {
    stubFetch();
    renderViewer(teamContext(), { [restriction]: true });
    if (restriction === 'viewerOnly') {
      expect(toolbarAction('Share')).toBeDisabled();
      fireEvent.click(toolbarAction('Share'));
      expect(screen.queryByRole('menuitem', { name: /Deploy to/i })).toBeNull();
      return;
    }
    fireEvent.click(toolbarAction('Share'));
    fireEvent.click(screen.getByRole('button', { name: 'More sharing options' }));
    for (const name of [/Deploy to Vercel/i, /Deploy to Cloudflare Pages/i]) {
      const provider = await screen.findByRole('menuitem', { name });
      expect(provider).toBeDisabled();
      expect(provider).toHaveAttribute('title');
      fireEvent.click(provider);
    }
    expect(screen.queryByRole('combobox', { name: /Provider/i })).toBeNull();
  });

  it('keeps artifact-card Share focused on publishing', async () => {
    stubFetch();
    renderViewer(teamContext(), { shareRequest: { nonce: 123, anchorId: 's12-card' } });
    await screen.findByRole('button', { name: '发布并复制链接' });
    expect(screen.queryByRole('menuitem', { name: /Deploy to/i })).toBeNull();
    expect(document.querySelector('.social-share-grid')).toBeNull();
    expect(screen.getByTestId('tokentosea-share-panel')).toBeVisible();
  });

  it('keeps deployment providers but excludes social sharing after publication', async () => {
    stubFetch({ published: true });
    renderViewer(teamContext());
    fireEvent.click(toolbarAction('Share'));
    await screen.findByRole('link', { name: SHARE_URL });
    const panel = screen.getByTestId('tokentosea-share-panel');
    fireEvent.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(screen.getByRole('menuitem', { name: /Deploy to Vercel/i })).toBeEnabled();
    expect(screen.getByRole('menuitem', { name: /Deploy to Cloudflare Pages/i })).toBeEnabled();
    expect(panel.querySelector('.social-share-grid')).toBeNull();
    expect(panel.querySelectorAll('.social-share-button')).toHaveLength(0);
  });

  it('shows the current Share-panel explanation without publishing', async () => {
    const fetchMock = stubFetch();
    renderViewer(teamContext());
    fireEvent.click(toolbarAction('Share'));
    expect(await screen.findByText('发布可访问的作品链接，评论会同步到这里。')).toBeVisible();
    expect(shareWrites(fetchMock)).toEqual([]);
    expect(legacyPublishRequests(fetchMock)).toEqual([]);
  });
});

describe('Z11a · 基线守不住、但必须守住的几条', () => {
  it('分享与导出仍是同一块弹层的两个页签,不是两块弹层', async () => {
    await openSharePanel();
    expect(document.querySelectorAll('.chrome-unified-popover')).toHaveLength(1);

    fireEvent.click(toolbarAction('Export'));
    await waitFor(() =>
      expect(screen.queryByTestId('tokentosea-share-panel'), '换页签后分享那一份还在').toBeNull(),
    );
    expect(document.querySelectorAll('.chrome-unified-popover'), '叠出了第二块弹层').toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Share' })).toBeNull();
  });

  it('面板挂在预览区容器内,不是 body 级 dialog(负向)', async () => {
    const panel = await openSharePanel();
    expect(panel.closest('.share-menu'), '面板脱离了 .share-menu 容器').not.toBeNull();
    expect(panel.getAttribute('role'), '面板自己不该是 dialog').not.toBe('dialog');
    expect(
      document.body.querySelector(':scope > [data-testid="tokentosea-share-panel"]'),
      '面板被提到了 body 级',
    ).toBeNull();
  });

  it('弹层里仍有可点的 menuitem 行(面板不是空壳)', async () => {
    await openSharePanel();
    fireEvent.click(screen.getByRole('button', { name: 'More sharing options' }));
    expect(
      screen.queryAllByRole('menuitem').length,
      '分享面板里一行 menuitem 都没有,说明搬丢了内容',
    ).toBeGreaterThan(0);
  });
});
