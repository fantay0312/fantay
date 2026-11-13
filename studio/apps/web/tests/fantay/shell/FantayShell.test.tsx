// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// FantayShell (spec 02 §6.2, §14 with amendments B5/B6 and plans R9/R18): layout modes, the one persistent
// account-actions host, shortcuts in the capture phase (mod+\ only, ⌘K outside EntryShell), shell commands,
// the account menu (Settings ▸ 账户 + ThemeSegmented), `sidebar.focus`, published geometry, the Toaster.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useLayoutEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Route } from '../../../src/router';

const mocks = vi.hoisted(() => ({
  route: { kind: 'home', view: 'home' } as Route,
  navigate: vi.fn(),
  host: null as unknown,
  listConversations: vi.fn(async () => []),
}));

vi.mock('../../../src/router', () => ({
  canGoBackInApp: () => false,
  goBack: vi.fn(),
  navigate: mocks.navigate,
  useRoute: () => mocks.route,
}));

vi.mock('@open-design/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-design/host')>();
  return { ...actual, getOpenDesignHost: () => mocks.host };
});

vi.mock('../../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => ({ context: null, loading: false, resourceReadIdentity: null, identityChangePending: false }),
  };
});

vi.mock('../../../src/hooks/useProjectRunStatuses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/hooks/useProjectRunStatuses')>();
  return { ...actual, useProjectRunStatuses: () => new Map(), acknowledgeProjectCompletion: vi.fn() };
});

vi.mock('../../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/state/projects')>();
  return { ...actual, listConversations: mocks.listConversations };
});

vi.mock('../../../src/components/ProjectSearchModal', () => ({
  ProjectSearchModal: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="project-search-modal">
      <button type="button" onClick={onClose}>
        close search
      </button>
    </div>
  ),
}));

import { ENTRY_SEARCH_OPEN_EVENT, subscribeEntryNewProject } from '../../../src/components/entryRailBridge';
import { WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID } from '../../../src/components/workspaceChromeActions';
import { I18nProvider } from '../../../src/i18n';
import { resetMaterialsDrawerForTests, getMaterialsDrawerState } from '../../../src/fantay/materials/materials-drawer-store';
import { FantayShell, type FantayShellProps } from '../../../src/fantay/shell/FantayShell';
import { resetFantayCommandsForTests, runFantayCommand } from '../../../src/fantay/shell/commands';
import {
  NO_RUNNING_CONVERSATIONS,
  resetFantayProjectBridgeForTests,
  useFantayProjectBridge,
  type FantayProjectBridgeInput,
} from '../../../src/fantay/shell/project-bridge';
import { resetSidebarStoreForTests, SIDEBAR_COLLAPSED_STORAGE_KEY } from '../../../src/fantay/shell/sidebar-store';
import { resetWorkspaceBusForTests, sendWorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';
import { __resetToastsForTests, toast } from '../../../src/fantay/ui/toast';
import { resetSidebarConversationsForTests } from '../../../src/fantay/shell/sidebar/use-sidebar-conversations';
import type { Project } from '../../../src/types';

function setWindowWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
}

/** Mimics upstream EntryTopRightCluster: resolves the host once in a layout effect, falls back to <body>. */
function ClusterProbe() {
  const [host, setHost] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    setHost(document.getElementById(WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID) ?? document.body);
  }, []);
  return host ? createPortal(<span data-testid="cluster-probe">credits</span>, host) : null;
}

function Bridge({ input }: { input: FantayProjectBridgeInput }) {
  useFantayProjectBridge(input);
  return null;
}

function project(id: string, extra: Partial<Project> = {}): Project {
  return { id, name: `Project ${id}`, skillId: null, designSystemId: null, createdAt: 1, updatedAt: 1, ...extra };
}

function shellProps(overrides: Partial<FantayShellProps> = {}): FantayShellProps {
  return {
    clientType: 'web',
    hostPlatform: undefined,
    projects: [project('p1'), project('p2')],
    projectsLoading: false,
    onOpenProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onOpenSettings: vi.fn(),
    children: <div data-testid="app-main">main</div>,
    ...overrides,
  };
}

function renderShell(overrides: Partial<FantayShellProps> = {}, extra: ReactNode = null) {
  const props = shellProps(overrides);
  const view = render(
    <I18nProvider initial="zh-CN">
      <ClusterProbe />
      <FantayShell {...props} />
      {extra}
    </I18nProvider>,
  );
  return { props, ...view };
}

function shellRoot(): HTMLElement {
  return screen.getByTestId('fantay-shell');
}

function accountHosts(): NodeListOf<Element> {
  return document.querySelectorAll(`#${WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID}`);
}

function pressToggle(target: Document | Element | Window = document.body): void {
  // jsdom reports a non-mac platform: the primary modifier is Ctrl
  fireEvent.keyDown(target, { key: '\\', code: 'Backslash', ctrlKey: true });
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
  window.localStorage.clear();
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0');
  setWindowWidth(1440);
  mocks.route = { kind: 'home', view: 'home' };
  mocks.navigate.mockClear();
  mocks.host = null;
  resetSidebarStoreForTests();
  resetSidebarConversationsForTests();
  resetFantayCommandsForTests();
  resetFantayProjectBridgeForTests();
  resetWorkspaceBusForTests();
  resetMaterialsDrawerForTests();
  __resetToastsForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('FantayShell layout', () => {
  it('renders the sidebar and the app main column', () => {
    renderShell();
    const root = shellRoot();
    expect(root).toHaveAttribute('data-sidebar', 'expanded');
    expect(root).toHaveAttribute('data-sidebar-mode', 'docked');
    expect(root).toHaveAttribute('data-route-kind', 'home');
    expect(root).toHaveAttribute('data-client-type', 'web');
    expect(root).toHaveAttribute('data-host-platform', 'web');
    expect(screen.getByTestId('fantay-sidebar')).toHaveAttribute('aria-label', '主导航');
    expect(screen.getByTestId('fantay-shell-main')).toContainElement(screen.getByTestId('app-main'));
    expect(screen.getByTestId('fantay-sidebar-new-chat').textContent).toContain('新对话');
  });

  it('renders onboarding chromeless: no sidebar, the main column only', () => {
    mocks.route = { kind: 'home', view: 'onboarding' };
    renderShell();
    expect(shellRoot()).toHaveAttribute('data-chromeless', '');
    expect(screen.queryByTestId('fantay-sidebar')).toBeNull();
    expect(screen.getByTestId('app-main')).toBeInTheDocument();
    expect(accountHosts()).toHaveLength(1);
  });

  it('starts on the rail below 1080 px when no choice is stored', () => {
    window.localStorage.removeItem(SIDEBAR_COLLAPSED_STORAGE_KEY);
    setWindowWidth(1000);
    renderShell();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    expect(screen.getByTestId('fantay-sidebar-rail')).toBeInTheDocument();
    // Chromium resolves -webkit-app-region in tree order: before the main column, the window eats the rail's clicks.
    expect(
      screen.getByTestId('fantay-shell-main').compareDocumentPosition(screen.getByTestId('fantay-sidebar-rail'))
        & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('becomes an overlay sheet below 900 px on the web, and docks again when wider', async () => {
    renderShell();
    act(() => {
      setWindowWidth(800);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'overlay'));
    expect(screen.queryByTestId('fantay-sidebar')).toBeNull();
    fireEvent.click(screen.getByTestId('fantay-sidebar-overlay-open'));
    const sheet = await screen.findByTestId('fantay-sidebar-sheet');
    expect(sheet).toContainElement(screen.getByTestId('fantay-sidebar'));
    // every navigation from the sheet closes it
    fireEvent.click(screen.getByTestId('fantay-sidebar-plugins'));
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'home', view: 'plugins' });
    await waitFor(() => expect(screen.queryByTestId('fantay-sidebar-sheet')).toBeNull());
    act(() => {
      setWindowWidth(1440);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'docked'));
  });

  it('adapts sidebar morphology across wide (expanded), compact (collapsed rail), and mini (overlay topbar + sheet) widths on desktop', async () => {
    renderShell({ clientType: 'desktop', hostPlatform: 'darwin' });
    expect(shellRoot()).toHaveAttribute('data-viewport-tier', 'wide');
    expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'docked');
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
    act(() => {
      setWindowWidth(700);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-viewport-tier', 'compact'));
    expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'docked');
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    expect(shellRoot()).toHaveAttribute('data-host-platform', 'darwin');

    act(() => {
      setWindowWidth(520);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-viewport-tier', 'mini'));
    expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'overlay');
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    expect(screen.getByTestId('fantay-sidebar-overlay-open')).toBeInTheDocument();

    act(() => {
      setWindowWidth(1280);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-viewport-tier', 'wide'));
    expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'docked');
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
  });
});

describe('the account-actions host (B6)', () => {
  it('exists exactly once and is the same node in every sidebar mode', async () => {
    renderShell();
    expect(accountHosts()).toHaveLength(1);
    const host = accountHosts()[0];
    // the upstream cluster resolved the host in its first layout effect
    expect(host).toContainElement(screen.getByTestId('cluster-probe'));
    expect(host).toHaveAttribute('data-fx-legacy');

    pressToggle();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    expect(accountHosts()).toHaveLength(1);
    expect(accountHosts()[0]).toBe(host);

    act(() => {
      setWindowWidth(800);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(shellRoot()).toHaveAttribute('data-sidebar-mode', 'overlay'));
    expect(accountHosts()).toHaveLength(1);
    expect(accountHosts()[0]).toBe(host);
    expect(host).toContainElement(screen.getByTestId('cluster-probe'));

    fireEvent.click(screen.getByTestId('fantay-sidebar-overlay-open'));
    await screen.findByTestId('fantay-sidebar-sheet');
    expect(accountHosts()).toHaveLength(1);
    expect(accountHosts()[0]).toBe(host);
  });
});

describe('shortcuts (B5)', () => {
  it('toggles the sidebar on mod+\\ in the capture phase, even when a later listener claims the key', () => {
    const claim = (event: KeyboardEvent) => event.preventDefault();
    document.addEventListener('keydown', claim);
    renderShell();
    pressToggle();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    pressToggle();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
    expect(window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY)).toBe('0');
    document.removeEventListener('keydown', claim);
  });

  it('binds no mod+B (EntryShell keeps it) and ignores typing targets', () => {
    renderShell();
    fireEvent.keyDown(document.body, { key: 'b', ctrlKey: true });
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
    const input = document.createElement('input');
    document.body.appendChild(input);
    pressToggle(input);
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
    input.remove();
  });

  it('leaves mod+\\ to the native menu accelerator when the host has a menu', () => {
    mocks.host = { client: { type: 'desktop', platform: 'darwin' }, menu: { subscribeCommand: () => () => undefined } };
    renderShell();
    pressToggle();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
  });

  it('opens project search on ⌘K outside EntryShell and hands it to EntryShell at home', () => {
    const onEntrySearch = vi.fn();
    window.addEventListener(ENTRY_SEARCH_OPEN_EVENT, onEntrySearch);
    renderShell();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    // home: EntryShell's own ⌘K handles the key; the shell stays out of it
    expect(onEntrySearch).not.toHaveBeenCalled();
    expect(screen.queryByTestId('project-search-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('fantay-sidebar-search'));
    expect(onEntrySearch).toHaveBeenCalledTimes(1);
    cleanup();

    mocks.route = { kind: 'project', projectId: 'p1', conversationId: null, fileName: null };
    renderShell();
    fireEvent.keyDown(document.body, { key: 'k', ctrlKey: true });
    expect(screen.getByTestId('project-search-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByText('close search'));
    expect(screen.queryByTestId('project-search-modal')).toBeNull();
    window.removeEventListener(ENTRY_SEARCH_OPEN_EVENT, onEntrySearch);
  });
});

describe('shell commands', () => {
  it('registers toggleSidebar, openSettings, search, newProject and newChat', () => {
    const { props } = renderShell();
    const openProjectDialog = vi.fn();
    const unsubscribe = subscribeEntryNewProject(openProjectDialog);
    openProjectDialog.mockClear();
    act(() => {
      expect(runFantayCommand('fantay.toggleSidebar')).toBe(true);
    });
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    act(() => {
      runFantayCommand('fantay.openSettings');
    });
    expect(props.onOpenSettings).toHaveBeenCalledWith();
    act(() => {
      runFantayCommand('fantay.newProject');
    });
    expect(openProjectDialog).toHaveBeenCalledOnce();
    expect(mocks.navigate).toHaveBeenLastCalledWith({ kind: 'home', view: 'home' });
    // A new chat opens the Home composer without opening the project dialog.
    mocks.navigate.mockClear();
    act(() => {
      runFantayCommand('fantay.newChat');
    });
    expect(openProjectDialog).toHaveBeenCalledOnce();
    unsubscribe();
    expect(mocks.navigate).toHaveBeenLastCalledWith({ kind: 'home', view: 'home' });
    cleanup();
    expect(runFantayCommand('fantay.toggleSidebar')).toBe(false);
  });

  it('starts a new chat in the open project through ProjectView', () => {
    mocks.route = { kind: 'project', projectId: 'p1', conversationId: null, fileName: null };
    const onNewConversation = vi.fn();
    const bridge: FantayProjectBridgeInput = {
      projectId: 'p1',
      projectName: 'Project p1',
      designSystemId: null,
      designSystems: [],
      conversations: [],
      activeConversationId: null,
      runningConversationIds: NO_RUNNING_CONVERSATIONS,
      readOnly: false,
      projectMetadata: null,
      mediaProviders: undefined,
      onNewConversation,
      onSelectConversation: vi.fn(),
      onChangeDesignSystem: vi.fn(),
      onOpenSettings: vi.fn(),
    };
    renderShell({}, <Bridge input={bridge} />);
    fireEvent.click(screen.getByTestId('fantay-sidebar-new-chat'));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});

describe('account dock (R9, R18)', () => {
  it('renders 登录 / 注册 button when signed out and falls back to Settings ▸ 账户 when login is unavailable', async () => {
    const { props } = renderShell();
    const accountBtn = screen.getByTestId('fantay-sidebar-account');
    expect(accountBtn).toHaveAttribute('data-account-state', 'signed-out');
    expect(accountBtn.textContent).toContain('登录 / 注册');
    expect(accountBtn.textContent).not.toContain('TokenToSea 账户');
    expect(screen.queryByTestId('fantay-sidebar-wallet')).toBeNull();
    fireEvent.click(accountBtn);
    await waitFor(() => expect(props.onOpenSettings).toHaveBeenCalledWith('account'));
  });

  it('starts OAuth login directly from the signed-out 登录 / 注册 button and supports canceling pending auth', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tokentosea/status')) {
          return new Response(
            JSON.stringify({ configured: true, signedIn: false, pending: false, user: null }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        if (url.endsWith('/api/tokentosea/login')) {
          return new Response(
            JSON.stringify({ authorizeUrl: 'https://tokentosea.com/oauth/authorize?state=test' }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      }),
    );

    const { props } = renderShell();
    const accountBtn = screen.getByTestId('fantay-sidebar-account');
    fireEvent.click(accountBtn);
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-account')).toHaveAttribute('data-account-state', 'pending'));
    expect(screen.getByTestId('fantay-sidebar-account').textContent).toContain('等待授权…');
    expect(openSpy).toHaveBeenCalledWith('https://tokentosea.com/oauth/authorize?state=test', '_blank', 'noopener,noreferrer');
    expect(props.onOpenSettings).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('fantay-sidebar-account'));
    await screen.findByTestId('fantay-sidebar-account-menu');
    fireEvent.click(screen.getByTestId('fantay-sidebar-account-cancel'));
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-account')).toHaveAttribute('data-account-state', 'signed-out'));
    expect(screen.getByTestId('fantay-sidebar-account').textContent).toContain('登录 / 注册');

    openSpy.mockRestore();
    vi.unstubAllGlobals();
  });

  it('routes the signed-in account menu to Settings ▸ 账户 and carries the theme switch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith('/api/tokentosea/status')) {
          return new Response(
            JSON.stringify({
              configured: true,
              signedIn: true,
              pending: false,
              user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          );
        }
        return new Response('{}', { status: 404 });
      }),
    );

    const { props } = renderShell();
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-account').textContent).toContain('Ada'));
    expect(screen.getByTestId('fantay-sidebar-account')).toHaveAttribute('data-account-state', 'signed-in');
    expect(screen.queryByTestId('fantay-sidebar-wallet')).toBeNull();
    fireEvent.click(screen.getByTestId('fantay-sidebar-account'));
    const menu = await screen.findByTestId('fantay-sidebar-account-menu');
    expect(menu).toContainElement(screen.getByTestId('fx-theme-segmented'));
    expect(menu).toContainElement(screen.getByTestId('fantay-sidebar-account-balance'));
    fireEvent.click(screen.getByTestId('fantay-sidebar-account-profile'));
    expect(props.onOpenSettings).toHaveBeenCalledWith('account');
    await waitFor(() => expect(screen.queryByTestId('fantay-sidebar-account-menu')).toBeNull());
    // no diagnostics export on the web
    fireEvent.click(screen.getByTestId('fantay-sidebar-account'));
    await screen.findByTestId('fantay-sidebar-account-menu');
    expect(screen.queryByTestId('fantay-sidebar-account-diagnostics')).toBeNull();
    // the balance tile is a second way into Settings ▸ 账户
    fireEvent.click(screen.getByTestId('fantay-sidebar-account-balance'));
    expect(props.onOpenSettings).toHaveBeenCalledTimes(2);
    expect(props.onOpenSettings).toHaveBeenLastCalledWith('account');
    vi.unstubAllGlobals();
  });

  it('opens Settings from the gear', () => {
    const { props } = renderShell();
    fireEvent.click(screen.getByTestId('fantay-sidebar-settings'));
    expect(props.onOpenSettings).toHaveBeenCalledWith();
  });

  it('mounts the Fantay Toaster', async () => {
    renderShell();
    act(() => {
      toast({ title: 'saved' });
    });
    await waitFor(() => expect(document.querySelector('[data-slot="toaster"]')?.textContent).toContain('saved'));
  });
});

describe('R9 delegations and the workspace bus', () => {
  it('opens the full materials page from the sidebar', () => {
    renderShell();
    fireEvent.click(screen.getByTestId('fantay-sidebar-materials'));
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'home', view: 'materials' });
    expect(getMaterialsDrawerState().open).toBe(false);
  });

  it('reveals the 项目 section for motion on sidebar.focus, unfolding the rail first', async () => {
    renderShell();
    pressToggle();
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'collapsed');
    let handled = false;
    act(() => {
      handled = sendWorkspaceCommand({ type: 'sidebar.focus', section: 'motion' });
    });
    expect(handled).toBe(true);
    expect(shellRoot()).toHaveAttribute('data-sidebar', 'expanded');
    const toggle = await screen.findByTestId('fantay-sidebar-section-toggle-projects');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(toggle).toHaveAttribute('data-flash', '');
  });
});

describe('published geometry', () => {
  it('publishes the current sidebar width for surfaces outside the shell and clears it on unmount', async () => {
    const { unmount } = renderShell();
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--fx-sidebar-w')).toBe('248px');
    expect(style.getPropertyValue('--fx-shell-header-h')).toBe('44px');
    pressToggle();
    expect(style.getPropertyValue('--fx-sidebar-w')).toBe('0px');
    act(() => {
      setWindowWidth(800);
      window.dispatchEvent(new Event('resize'));
    });
    await waitFor(() => expect(style.getPropertyValue('--fx-sidebar-w')).toBe('0px'));
    unmount();
    expect(style.getPropertyValue('--fx-sidebar-w')).toBe('');
  });

  it('collapses to 0 px width on windowed macOS desktop when folded', () => {
    renderShell({ clientType: 'desktop', hostPlatform: 'darwin' });
    expect(document.documentElement.style.getPropertyValue('--fx-sidebar-w')).toBe('220px');
    expect(document.documentElement.style.getPropertyValue('--fx-shell-header-h')).toBe('36px');
    pressToggle();
    expect(document.documentElement.style.getPropertyValue('--fx-sidebar-w')).toBe('0px');
  });
});
