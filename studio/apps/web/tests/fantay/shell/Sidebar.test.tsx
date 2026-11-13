// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The Fantay sidebar (spec 02 §11.3–§11.4 with plan R9 and amendment C3), rendered inside FantayShell:
// 工作台 under 主页, one 项目 list with kind marks, run-status dots with their labels, the active
// project, lazy chat lists, the row menu (new chat here, inline rename, delete confirmation), and the 资源 rows.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDisplayStatus } from '@open-design/contracts';
import type { Route } from '../../../src/router';
import type { Conversation, Project } from '../../../src/types';

const mocks = vi.hoisted(() => ({
  route: { kind: 'home', view: 'home' } as Route,
  navigate: vi.fn(),
  statuses: new Map<string, ProjectDisplayStatus>(),
  listConversations: vi.fn<(projectId: string) => Promise<Conversation[]>>(async () => []),
  acknowledge: vi.fn(),
}));

vi.mock('../../../src/router', () => ({
  canGoBackInApp: () => false,
  goBack: vi.fn(),
  navigate: mocks.navigate,
  useRoute: () => mocks.route,
}));

vi.mock('../../../src/collab/useWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/collab/useWorkspaceContext')>();
  return {
    ...actual,
    useWorkspaceContext: () => ({ context: null, loading: false, resourceReadIdentity: null, identityChangePending: false }),
  };
});

vi.mock('../../../src/hooks/useProjectRunStatuses', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/hooks/useProjectRunStatuses')>();
  return { ...actual, useProjectRunStatuses: () => mocks.statuses, acknowledgeProjectCompletion: mocks.acknowledge };
});

vi.mock('../../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/state/projects')>();
  return { ...actual, listConversations: (projectId: string) => mocks.listConversations(projectId) };
});

vi.mock('../../../src/components/ProjectSearchModal', () => ({ ProjectSearchModal: () => null }));

import { I18nProvider } from '../../../src/i18n';
import { resetMotionCreateForTests } from '../../../src/fantay/motion/motion-create-store';
import { FantayShell, type FantayShellProps } from '../../../src/fantay/shell/FantayShell';
import { resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';
import {
  NO_RUNNING_CONVERSATIONS,
  resetFantayProjectBridgeForTests,
  useFantayProjectBridge,
  type FantayProjectBridgeInput,
} from '../../../src/fantay/shell/project-bridge';
import { resetProjectOrganizationForTests } from '../../../src/fantay/shell/project-organization-store';
import {
  SIDEBAR_COLLAPSED_STORAGE_KEY,
  SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY,
  SIDEBAR_SECTIONS_STORAGE_KEY,
  resetSidebarStoreForTests,
} from '../../../src/fantay/shell/sidebar-store';
import {
  getSidebarConversations,
  loadSidebarConversations,
  reconcileSidebarConversation,
  resetSidebarConversationsForTests,
} from '../../../src/fantay/shell/sidebar/use-sidebar-conversations';
import { resetWorkspaceBusForTests } from '../../../src/fantay/workspace/workspace-bus';
import { __resetToastsForTests } from '../../../src/fantay/ui/toast';

function project(id: string, updatedAt: number, extra: Partial<Project> = {}): Project {
  return { id, name: `Project ${id}`, skillId: null, designSystemId: null, createdAt: 1, updatedAt, ...extra };
}

function conversation(id: string, projectId: string, updatedAt: number, extra: Partial<Conversation> = {}): Conversation {
  return { id, projectId, title: `Chat ${id}`, messageCount: 1, createdAt: 1, updatedAt, ...extra };
}

const PROJECTS: Project[] = [
  project('alpha', 30),
  project('beta', 20),
  project('film', 25, { skillId: 'fantay-movie', metadata: { kind: 'video', intent: 'motion-design' } }),
  project('reel', 15, { metadata: { kind: 'video' } }),
  project('brand', 10, { metadata: { kind: 'brand' } }),
];

function Bridge({ input }: { input: FantayProjectBridgeInput }) {
  useFantayProjectBridge(input);
  return null;
}

function bridgeInput(overrides: Partial<FantayProjectBridgeInput> = {}): FantayProjectBridgeInput {
  return {
    projectId: 'alpha',
    projectName: 'Project alpha',
    designSystemId: null,
    designSystems: [],
    conversations: [conversation('a1', 'alpha', 2), conversation('a2', 'alpha', 5, { title: null })],
    activeConversationId: 'a1',
    runningConversationIds: NO_RUNNING_CONVERSATIONS,
    readOnly: false,
    projectMetadata: null,
    mediaProviders: undefined,
    onNewConversation: vi.fn(),
    onSelectConversation: vi.fn(),
    onChangeDesignSystem: vi.fn(),
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

function renderSidebar(overrides: Partial<FantayShellProps> = {}, extra: ReactNode = null) {
  const props: FantayShellProps = {
    clientType: 'web',
    hostPlatform: undefined,
    projects: PROJECTS,
    projectsLoading: false,
    onOpenProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDuplicateProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onOpenSettings: vi.fn(),
    children: <div data-testid="app-main" />,
    ...overrides,
  };
  render(
    <I18nProvider initial="zh-CN">
      <FantayShell {...props} />
      {extra}
    </I18nProvider>,
  );
  return props;
}

beforeEach(() => {
  vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
  window.localStorage.clear();
  window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0');
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
  mocks.route = { kind: 'home', view: 'home' };
  mocks.navigate.mockClear();
  mocks.statuses = new Map();
  mocks.listConversations.mockReset();
  mocks.listConversations.mockImplementation(async () => []);
  mocks.acknowledge.mockClear();
  resetSidebarStoreForTests();
  resetSidebarConversationsForTests();
  resetFantayCommandsForTests();
  resetFantayProjectBridgeForTests();
  resetWorkspaceBusForTests();
  resetMotionCreateForTests();
  __resetToastsForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('sections and rows', () => {
  it('places 工作台 under 主页 and keeps the individual projects in the 项目 section', () => {
    renderSidebar();
    const ids = ['home', 'workbench', 'section-projects'];
    const rows = ids.map((id) => screen.getByTestId(`fantay-sidebar-${id}`));
    rows.slice(1).forEach((row, index) => {
      expect(rows[index]!.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });
    expect(screen.getByTestId('fantay-sidebar-section-projects').contains(rows[1]!)).toBe(false);
    expect(screen.queryByTestId('fantay-sidebar-all-projects')).toBeNull();
    expect(screen.queryByTestId('fantay-sidebar-all-design-systems')).toBeNull();
    expect(screen.queryByTestId('fantay-sidebar-all-movies')).toBeNull();
  });

  it('lists every project kind in 项目, newest first, with no 视频与动画 or 设计系统 section', () => {
    renderSidebar();
    const projects = screen.getByTestId('fantay-sidebar-section-projects');
    const rows = Array.from(projects.querySelectorAll('[data-testid^="fantay-sidebar-project-item-"]')).map((row) =>
      row.getAttribute('data-testid')?.replace('fantay-sidebar-project-item-', ''),
    );
    expect(rows).toEqual(['alpha', 'film', 'beta', 'reel', 'brand']);
    expect(within(projects).getByTestId('fantay-sidebar-section-toggle-projects').textContent).toContain('项目');
    expect(screen.queryByTestId('fantay-sidebar-section-motion')).toBeNull();
    expect(screen.queryByTestId('fantay-sidebar-section-designSystems')).toBeNull();
    expect(screen.queryByTestId('fantay-sidebar-legacy-canvas')).toBeNull();
  });

  it('puts 素材库, 插件, 自动化 and 社区 between 工作台 and 项目, with no 资源 section', () => {
    renderSidebar();
    expect(screen.queryByTestId('fantay-sidebar-section-resources')).toBeNull();
    const order = Array.from(
      screen.getByTestId('fantay-sidebar-body').querySelectorAll('[data-testid^="fantay-sidebar-"]'),
    ).map((node) => node.getAttribute('data-testid'));
    const indexes = [
      'fantay-sidebar-workbench',
      'fantay-sidebar-materials',
      'fantay-sidebar-plugins',
      'fantay-sidebar-automations',
      'fantay-sidebar-community',
      'fantay-sidebar-section-projects',
    ].map((id) => order.indexOf(id));
    expect(indexes).not.toContain(-1);
    expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
  });

  it('draws 置顶, the groups and 已归档 from the daemon', async () => {
    const organization = {
      groups: [{ id: 'g', name: '客户', position: 0, createdAt: 1, updatedAt: 1 }],
      projects: [
        { projectId: 'alpha', groupId: null, pinnedAt: 1, archivedAt: null },
        { projectId: 'beta', groupId: 'g', pinnedAt: null, archivedAt: null },
        { projectId: 'reel', groupId: null, pinnedAt: null, archivedAt: 1 },
      ],
    };
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(organization))));
    resetProjectOrganizationForTests();
    try {
      renderSidebar();
      const pinned = await screen.findByTestId('fantay-sidebar-section-pinned');
      expect(within(pinned).getByTestId('fantay-sidebar-project-item-alpha')).toBeInTheDocument();
      const group = screen.getByTestId('fantay-sidebar-section-group:g');
      expect(within(group).getByTestId('fantay-sidebar-project-item-beta')).toBeInTheDocument();
      const plain = screen.getByTestId('fantay-sidebar-section-projects');
      expect(within(plain).queryByTestId('fantay-sidebar-project-item-alpha')).toBeNull();
      expect(screen.queryByTestId('fantay-sidebar-project-item-reel')).toBeNull();
      expect(screen.getByTestId('fantay-sidebar-archived').textContent).toContain('1');
    } finally {
      cleanup();
      resetProjectOrganizationForTests();
      vi.unstubAllGlobals();
    }
  });

  it('creates a group from the dialog: a name is required, and cancelling creates nothing', async () => {
    const created: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method !== 'POST') return new Response(JSON.stringify({ groups: [], projects: [] }));
        created.push((JSON.parse(String(init.body)) as { name: string }).name);
        const group = { id: 'new', name: '客户', position: 0, createdAt: 1, updatedAt: 1 };
        return new Response(JSON.stringify({ group }), { status: 201 });
      }),
    );
    resetProjectOrganizationForTests();
    try {
      renderSidebar();
      const FIELD = 'fantay-sidebar-new-group-name';

      fireEvent.click(screen.getByTestId('fantay-sidebar-new-group'));
      const field = await screen.findByTestId(FIELD);
      expect(screen.getByTestId(`${FIELD}-submit`)).toHaveAttribute('data-disabled');
      fireEvent.change(field, { target: { value: '不要了' } });
      fireEvent.click(screen.getByRole('button', { name: '取消' }));
      await waitFor(() => expect(screen.queryByTestId(FIELD)).toBeNull());
      expect(created).toEqual([]);

      fireEvent.click(screen.getByTestId('fantay-sidebar-new-group'));
      const reopened = await screen.findByTestId(FIELD);
      expect(reopened).toHaveValue('');
      fireEvent.change(reopened, { target: { value: ' 客户 ' } });
      fireEvent.click(screen.getByTestId(`${FIELD}-submit`));
      await waitFor(() => expect(screen.queryByTestId(FIELD)).toBeNull());

      const section = await screen.findByTestId('fantay-sidebar-section-group:new');
      expect(created).toEqual(['客户']);
      expect(within(section).getByTestId('fantay-sidebar-section-toggle-group:new')).toHaveAttribute('aria-expanded', 'true');
    } finally {
      cleanup();
      resetProjectOrganizationForTests();
      vi.unstubAllGlobals();
    }
  });

  it('marks motion and design-system rows, and leaves plain projects unmarked', () => {
    renderSidebar();
    const film = screen.getByTestId('fantay-sidebar-project-mark-film');
    expect(film).toHaveAttribute('data-kind', 'motion');
    expect(film).toHaveAttribute('aria-label', '视频与动画');
    expect(screen.getByTestId('fantay-sidebar-project-mark-reel')).toHaveAttribute('data-kind', 'motion');
    const brand = screen.getByTestId('fantay-sidebar-project-mark-brand');
    expect(brand).toHaveAttribute('data-kind', 'designSystem');
    expect(brand).toHaveAttribute('aria-label', '设计系统');
    expect(screen.queryByTestId('fantay-sidebar-project-mark-alpha')).toBeNull();
  });

  it('shows skeletons while App loads the catalogue and empty captions after', () => {
    renderSidebar({ projects: [], projectsLoading: true });
    expect(screen.getByTestId('fantay-sidebar-skeleton-projects')).toBeInTheDocument();
    cleanup();
    renderSidebar({ projects: [], projectsLoading: false });
    expect(screen.getByTestId('fantay-sidebar-empty-projects').textContent).toBe('还没有项目，从主页开始创作。');
  });

  it('folds a section and remembers it', () => {
    renderSidebar();
    const toggle = screen.getByTestId('fantay-sidebar-section-toggle-projects');
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('fantay-sidebar-section-projects')).toHaveAttribute('data-collapsed', '');
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_SECTIONS_STORAGE_KEY) ?? '{}')).toEqual({ projects: true });
  });
});

describe('rows', () => {
  it('does not restore a deleted chat from an older in-flight list', async () => {
    let finish!: (list: Conversation[]) => void;
    mocks.listConversations.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const loading = loadSidebarConversations('alpha', null);
    reconcileSidebarConversation('alpha', 'deleted', null);
    finish([conversation('deleted', 'alpha', 1)]);
    await loading;
    expect(getSidebarConversations('alpha')).toMatchObject({ status: 'ready', conversations: [], fetchedAt: 0 });
  });
  it('keeps pinned conversations first and makes archived conversations discoverable', async () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: 'a1', fileName: null };
    renderSidebar({}, <Bridge input={bridgeInput({ conversations: [
      conversation('a1', 'alpha', 3),
      conversation('pinned', 'alpha', 1, { pinnedAt: 5 }),
      conversation('archived', 'alpha', 8, { archivedAt: 8 }),
    ] })} />);
    const chats = screen.getByTestId('fantay-sidebar-project-chats-alpha');
    const rows = () => Array.from(chats.querySelectorAll('[data-sidebar-row]')).map(row => row.getAttribute('data-testid'));
    expect(rows()).toEqual(['fantay-sidebar-conversation-pinned', 'fantay-sidebar-conversation-a1']);
    fireEvent.click(within(chats).getByRole('button', { name: '已归档 (1)' }));
    expect(await screen.findByTestId('fantay-sidebar-conversation-archived')).toBeVisible();
  });
  it('labels run-status dots and marks the active project', () => {
    mocks.statuses = new Map<string, ProjectDisplayStatus>([
      ['alpha', 'running'],
      ['beta', 'awaiting_input'],
      ['reel', 'failed'],
      ['film', 'succeeded'],
    ]);
    mocks.route = { kind: 'project', projectId: 'beta', conversationId: null, fileName: null };
    renderSidebar();
    expect(screen.getByTestId('fantay-sidebar-status-alpha')).toHaveAttribute('aria-label', '运行中');
    expect(screen.getByTestId('fantay-sidebar-status-alpha')).toHaveAttribute('data-tone', 'running');
    expect(screen.getByTestId('fantay-sidebar-status-beta')).toHaveAttribute('data-tone', 'waiting');
    expect(screen.getByTestId('fantay-sidebar-status-reel')).toHaveAttribute('data-tone', 'failed');
    expect(screen.getByTestId('fantay-sidebar-status-film')).toHaveAttribute('data-tone', 'unread');
    expect(screen.queryByTestId('fantay-sidebar-status-brand')).toBeNull();
    expect(screen.getByTestId('fantay-sidebar-project-beta')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('fantay-sidebar-project-alpha')).not.toHaveAttribute('aria-current');
  });

  it('opens projects through App, and fantay-movie projects on their film (07 motionProjectOpenRoute)', () => {
    const props = renderSidebar();
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-alpha'));
    expect(props.onOpenProject).toHaveBeenCalledWith('alpha', undefined);
    expect(mocks.acknowledge).toHaveBeenCalledWith('alpha');
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-film'));
    expect(props.onOpenProject).toHaveBeenLastCalledWith('film', 'movie-studio.json');
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-reel'));
    expect(props.onOpenProject).toHaveBeenLastCalledWith('reel', undefined);
  });

  it('loads an expanded project’s chats lazily and opens one by route', async () => {
    mocks.listConversations.mockImplementation(async (projectId) =>
      projectId === 'beta' ? [conversation('b1', 'beta', 1), conversation('b2', 'beta', 9, { latestRun: { status: 'failed' } })] : [],
    );
    renderSidebar();
    expect(mocks.listConversations).not.toHaveBeenCalled();
    const expand = screen.getByTestId('fantay-sidebar-project-expand-beta');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(expand).toHaveAttribute('aria-label', '展开 Project beta');
    fireEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-conversation-b2')).toBeInTheDocument());
    expect(mocks.listConversations).toHaveBeenCalledWith('beta');
    expect(JSON.parse(window.localStorage.getItem(SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY) ?? '[]')).toEqual(['beta']);
    // newest first; the failed latest run is a labelled dot
    const chats = screen.getByTestId('fantay-sidebar-project-chats-beta');
    const order = Array.from(chats.querySelectorAll('[data-testid^="fantay-sidebar-conversation-"]')).map((row) =>
      row.getAttribute('data-testid'),
    );
    expect(order).toEqual(['fantay-sidebar-conversation-b2', 'fantay-sidebar-conversation-b1']);
    expect(within(screen.getByTestId('fantay-sidebar-conversation-b2')).getByRole('img')).toHaveAttribute('aria-label', '失败');
    fireEvent.click(screen.getByTestId('fantay-sidebar-conversation-b1'));
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'project', projectId: 'beta', conversationId: 'b1', fileName: null });
  });

  it('shows the open project’s chats live from ProjectView and switches through its handler', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    const input = bridgeInput();
    renderSidebar({}, <Bridge input={input} />);
    expect(mocks.listConversations).not.toHaveBeenCalled();
    expect(screen.getByTestId('fantay-sidebar-project-expand-alpha')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('fantay-sidebar-conversation-a1')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('fantay-sidebar-conversation-a2').textContent).toContain('未命名对话');
    fireEvent.click(screen.getByTestId('fantay-sidebar-conversation-a2'));
    expect(input.onSelectConversation).toHaveBeenCalledWith('a2');
    expect(mocks.navigate).not.toHaveBeenCalled();
  });

  it('folds and unfolds the open project from its chevron without rewriting the remembered expansions', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    renderSidebar({}, <Bridge input={bridgeInput()} />);
    const expand = screen.getByTestId('fantay-sidebar-project-expand-alpha');
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByTestId('fantay-sidebar-project-chats-alpha')).not.toHaveAttribute('data-expanded');
    fireEvent.click(expand);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('fantay-sidebar-project-chats-alpha')).toHaveAttribute('data-expanded', '');
    expect(window.localStorage.getItem(SIDEBAR_EXPANDED_PROJECTS_STORAGE_KEY)).toBeNull();
  });

  it('caps the chat preview at six with a show-all toggle', async () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    const many = Array.from({ length: 8 }, (_, index) => conversation(`c${index}`, 'alpha', index));
    renderSidebar({}, <Bridge input={bridgeInput({ conversations: many, activeConversationId: null })} />);
    const chats = screen.getByTestId('fantay-sidebar-project-chats-alpha');
    expect(chats.querySelectorAll('[data-testid^="fantay-sidebar-conversation-"]')).toHaveLength(6);
    fireEvent.click(within(chats).getByText('显示全部 8 个对话'));
    expect(chats.querySelectorAll('[data-testid^="fantay-sidebar-conversation-"]')).toHaveLength(8);
    fireEvent.click(within(chats).getByText('收起'));
    expect(chats.querySelectorAll('[data-testid^="fantay-sidebar-conversation-"]')).toHaveLength(6);
  });
});

describe('a new chat from the project row', () => {
  function Stage({ publish }: { publish: { current: (input: FantayProjectBridgeInput) => void } }) {
    const [input, setInput] = useState<FantayProjectBridgeInput | null>(null);
    publish.current = setInput;
    return input ? <Bridge input={input} /> : null;
  }

  it('starts it through the open project', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    const input = bridgeInput();
    renderSidebar({}, <Bridge input={input} />);
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-new-chat-alpha'));
    expect(input.onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('opens a folded project so the new chat is there to see', () => {
    renderSidebar();
    const expand = screen.getByTestId('fantay-sidebar-project-expand-beta');
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-new-chat-beta'));
    expect(expand).toHaveAttribute('aria-expanded', 'true');
  });

  it('waits for a project opened from elsewhere to pick a chat and resolve its access', () => {
    const publish = { current: (_input: FantayProjectBridgeInput) => undefined as void };
    const props = renderSidebar({}, <Stage publish={publish} />);
    fireEvent.click(screen.getByTestId('fantay-sidebar-project-new-chat-beta'));
    expect(props.onOpenProject).toHaveBeenCalledWith('beta');

    const onNewConversation = vi.fn();
    const session = { projectId: 'beta', onNewConversation };
    act(() => publish.current(bridgeInput({ ...session, activeConversationId: null, readOnly: true })));
    act(() => publish.current(bridgeInput({ ...session, activeConversationId: 'b1', readOnly: true })));
    expect(onNewConversation).not.toHaveBeenCalled();

    act(() => publish.current(bridgeInput({ ...session, activeConversationId: 'b1', readOnly: false })));
    expect(onNewConversation).toHaveBeenCalledTimes(1);
  });

  it('keeps a chat nothing was sent in out of the list, and marks its project instead', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: 'fresh', fileName: null };
    const input = bridgeInput({
      conversations: [conversation('a1', 'alpha', 2), conversation('fresh', 'alpha', 9, { title: null, messageCount: 0 })],
      activeConversationId: 'fresh',
    });
    renderSidebar({}, <Bridge input={input} />);
    expect(screen.getByTestId('fantay-sidebar-conversation-a1')).toBeInTheDocument();
    expect(screen.queryByTestId('fantay-sidebar-conversation-fresh')).toBeNull();
    const head = screen.getByTestId('fantay-sidebar-project-alpha').closest('[draggable]');
    expect(head).toHaveClass('bg-paper-deep');
  });

  it('shows the new chat once its first run starts', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: 'fresh', fileName: null };
    const fresh = conversation('fresh', 'alpha', 9, { title: null, messageCount: 0 });
    renderSidebar({}, <Bridge input={bridgeInput({ conversations: [fresh], activeConversationId: 'fresh', runningConversationIds: ['fresh'] })} />);
    expect(screen.getByTestId('fantay-sidebar-conversation-fresh')).toBeInTheDocument();
  });

  it('folds the open project from its own row instead of reopening it', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    const props = renderSidebar({}, <Bridge input={bridgeInput()} />);
    const row = screen.getByTestId('fantay-sidebar-project-alpha');
    const expand = screen.getByTestId('fantay-sidebar-project-expand-alpha');
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    fireEvent.click(row);
    expect(expand).toHaveAttribute('aria-expanded', 'false');
    expect(row).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(row);
    expect(expand).toHaveAttribute('aria-expanded', 'true');
    expect(props.onOpenProject).not.toHaveBeenCalled();
  });

  it('marks one row at a time: the open chat, not its project as well', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    renderSidebar({}, <Bridge input={bridgeInput()} />);
    const head = screen.getByTestId('fantay-sidebar-project-alpha').closest('[draggable]');
    expect(screen.getByTestId('fantay-sidebar-conversation-a1')).toHaveAttribute('aria-current', 'page');
    expect(head).toHaveAttribute('data-active', '');
    expect(head).not.toHaveClass('bg-paper-deep');
  });
});

describe('row menu', () => {
  function openMenu(projectId: string): HTMLElement {
    fireEvent.keyDown(screen.getByTestId(`fantay-sidebar-project-menu-${projectId}`), { key: 'Enter' });
    return screen.getByRole('menu');
  }

  it('offers the requested project management actions and saves the edit dialog', async () => {
    const props = renderSidebar();
    const menu = openMenu('beta');
    for (const name of ['置顶', '编辑', '分区', '在 Finder 中显示', '全部标为已读', '归档聊天', '移除项目']) {
      expect(within(menu).getByRole('menuitem', { name })).toBeInTheDocument();
    }
    fireEvent.click(within(menu).getByRole('menuitem', { name: '编辑' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'Edited project' } });
    fireEvent.click(within(dialog).getByRole('button', { name: '保存' }));
    await waitFor(() => expect(props.onRenameProject).toHaveBeenCalledWith('beta', 'Edited project'));
  });

  it('renames inline: Enter commits through App, Escape cancels', async () => {
    const props = renderSidebar();
    fireEvent.doubleClick(screen.getByTestId('fantay-sidebar-project-beta'));
    const input = await screen.findByTestId('fantay-sidebar-project-rename-beta');
    expect(input).toHaveValue('Project beta');
    fireEvent.change(input, { target: { value: '  Beta launch  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(props.onRenameProject).toHaveBeenCalledWith('beta', 'Beta launch');
    expect(screen.queryByTestId('fantay-sidebar-project-rename-beta')).toBeNull();

    fireEvent.doubleClick(screen.getByTestId('fantay-sidebar-project-alpha'));
    const second = await screen.findByTestId('fantay-sidebar-project-rename-alpha');
    fireEvent.change(second, { target: { value: 'Nope' } });
    fireEvent.keyDown(second, { key: 'Escape' });
    expect(props.onRenameProject).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('fantay-sidebar-project-alpha').textContent).toContain('Project alpha');
  });

  it('hands the focus back to the row after Enter or Escape in the rename field', async () => {
    renderSidebar();
    fireEvent.doubleClick(screen.getByTestId('fantay-sidebar-project-beta'));
    const input = await screen.findByTestId('fantay-sidebar-project-rename-beta');
    await waitFor(() => expect(input).toHaveFocus());
    fireEvent.change(input, { target: { value: 'Beta 2' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-project-beta')).toHaveFocus());

    fireEvent.doubleClick(screen.getByTestId('fantay-sidebar-project-alpha'));
    const second = await screen.findByTestId('fantay-sidebar-project-rename-alpha');
    await waitFor(() => expect(second).toHaveFocus());
    fireEvent.keyDown(second, { key: 'Escape' });
    await waitFor(() => expect(screen.getByTestId('fantay-sidebar-project-alpha')).toHaveFocus());
  });

  it('starts a new chat in another project once its ProjectView publishes', async () => {
    const props = renderSidebar();
    const menu = openMenu('beta');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /在此项目中新建对话/ }));
    expect(props.onOpenProject).toHaveBeenCalledWith('beta');
    const input = bridgeInput({ projectId: 'beta', projectName: 'Project beta' });
    render(<Bridge input={input} />);
    await waitFor(() => expect(input.onNewConversation).toHaveBeenCalledTimes(1));
  });

  it('asks for confirmation before deleting', async () => {
    const props = renderSidebar();
    const menu = openMenu('alpha');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /删除/ }));
    expect(await screen.findByTestId('project-delete-confirm-dialog')).toBeInTheDocument();
    expect(props.onDeleteProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('project-delete-confirm-cancel'));
    await waitFor(() => expect(screen.queryByTestId('project-delete-confirm-dialog')).toBeNull());
  });

  it('duplicates through App', async () => {
    const props = renderSidebar();
    const menu = openMenu('alpha');
    fireEvent.click(within(menu).getByRole('menuitem', { name: /复制项目/ }));
    await waitFor(() => expect(props.onDuplicateProject).toHaveBeenCalledWith('alpha'));
  });
});

describe('section actions and resources', () => {
  it('wires the 项目 add button; the merged kinds have no section add buttons left', () => {
    renderSidebar();
    fireEvent.click(screen.getByTestId('fantay-sidebar-section-add-projects'));
    expect(mocks.navigate).toHaveBeenLastCalledWith({ kind: 'home', view: 'home' });
    expect(screen.queryByTestId('fantay-sidebar-section-add-motion')).toBeNull();
    expect(screen.queryByTestId('fantay-sidebar-section-add-designSystems')).toBeNull();
  });

  it('navigates from 主页, 工作台 and the resource rows', () => {
    renderSidebar();
    const go = (testId: string) => {
      fireEvent.click(screen.getByTestId(testId));
      return mocks.navigate.mock.lastCall?.[0];
    };
    expect(go('fantay-sidebar-home')).toEqual({ kind: 'home', view: 'home' });
    expect(go('fantay-sidebar-workbench')).toEqual({ kind: 'home', view: 'workbench' });
    expect(go('fantay-sidebar-plugins')).toEqual({ kind: 'home', view: 'plugins' });
    expect(go('fantay-sidebar-automations')).toEqual({ kind: 'home', view: 'tasks' });
    expect(go('fantay-sidebar-community')).toEqual({ kind: 'home', view: 'community' });
  });

  it('marks 主页 active at home and 工作台 active on the design-system library', () => {
    renderSidebar();
    expect(screen.getByTestId('fantay-sidebar-home')).toHaveAttribute('aria-current', 'page');
    cleanup();
    mocks.route = { kind: 'home', view: 'design-systems' };
    renderSidebar();
    expect(screen.getByTestId('fantay-sidebar-workbench')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByTestId('fantay-sidebar-home')).not.toHaveAttribute('aria-current');
  });

  it('disables new chat on a read-only project', () => {
    mocks.route = { kind: 'project', projectId: 'alpha', conversationId: null, fileName: null };
    renderSidebar({}, <Bridge input={bridgeInput({ readOnly: true })} />);
    expect(screen.getByTestId('fantay-sidebar-new-chat')).toBeDisabled();
  });

  it('renders the top-left control bar when collapsed and expands the sidebar', async () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    renderSidebar();
    expect(screen.getByTestId('fantay-sidebar-rail')).toBeInTheDocument();
    expect(screen.queryByTestId('fantay-rail-pa')).not.toBeInTheDocument();
    expect(screen.getByTestId('fantay-sidebar-expand')).toBeInTheDocument();
    expect(screen.getByTestId('fantay-sidebar-rail-search')).toBeInTheDocument();
    expect(screen.getByTestId('fantay-sidebar-nav-back')).toBeInTheDocument();
    expect(screen.getByTestId('fantay-sidebar-nav-forward')).toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId('fantay-sidebar-expand'));
    });
    expect(await screen.findByTestId('fantay-sidebar-section-projects')).toBeInTheDocument();
    expect(screen.getByTestId('fantay-sidebar-pa')).toBeInTheDocument();
  });

  it('omits Settings from the top-left control bar while the sidebar is folded', () => {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '1');
    const onOpenSettings = vi.fn();
    renderSidebar({ onOpenSettings });
    expect(screen.queryByTestId('fantay-sidebar-rail-settings')).toBeNull();
    expect(onOpenSettings).not.toHaveBeenCalled();
    expect(screen.getByTestId('fantay-sidebar-rail')).toBeInTheDocument();
  });
});
