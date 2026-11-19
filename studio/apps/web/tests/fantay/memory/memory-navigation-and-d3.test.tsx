// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// The `记忆` page's route (including the old /memory/<tab> links), its sidebar entry with the pending badge
// and how that badge reads the service, and the PA memory modal's default scope (D3).
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ProjectDisplayStatus } from '@open-design/contracts';
import { MEMORY_CENTER_TABS, buildPath, parseRoute, type Route } from '../../../src/router';
import type { Conversation, Project } from '../../../src/types';

const mocks = vi.hoisted(() => ({
  route: { kind: 'home', view: 'home' } as Route,
  navigate: vi.fn(),
  statuses: new Map<string, ProjectDisplayStatus>(),
  listConversations: vi.fn<(projectId: string) => Promise<Conversation[]>>(async () => []),
  acknowledge: vi.fn(),
}));

vi.mock('../../../src/router', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/router')>();
  return {
    ...actual,
    canGoBackInApp: () => false,
    goBack: vi.fn(),
    navigate: mocks.navigate,
    useRoute: () => mocks.route,
  };
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
  return { ...actual, useProjectRunStatuses: () => mocks.statuses, acknowledgeProjectCompletion: mocks.acknowledge };
});

vi.mock('../../../src/state/projects', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/state/projects')>();
  return { ...actual, listConversations: (projectId: string) => mocks.listConversations(projectId) };
});

vi.mock('../../../src/components/ProjectSearchModal', () => ({ ProjectSearchModal: () => null }));

import { I18nProvider } from '../../../src/i18n';
import { paManageZh } from '../../../src/i18n/pa-ui/manage';
import { paPagesZh } from '../../../src/i18n/pa-ui/pages';
import { paShellZh } from '../../../src/i18n/pa-ui/shell';
import { resetMemoryPendingCountForTests, setMemoryPendingCount } from '../../../src/fantay/memory/memory-badge-store';
import { MemoryNavigationLabel } from '../../../src/fantay/memory/MemoryNavigationLabel';
import { resolveDefaultMemoryScope } from '../../../src/fantay/pa/PaMemoryModal';
import { buildFixture } from '../../../src/fantay/pa/lab/fixtures';
import { buildIndex } from '../../../src/fantay/pa/pa-model';
import { FantayShell } from '../../../src/fantay/shell/FantayShell';
import { SIDEBAR_COLLAPSED_STORAGE_KEY, resetSidebarStoreForTests } from '../../../src/fantay/shell/sidebar-store';

describe('/memory URL router', () => {
  it('opens the memory page at /memory', () => {
    expect(parseRoute('/memory')).toEqual({ kind: 'home', view: 'memory' });
    expect(parseRoute('/memory/')).toEqual({ kind: 'home', view: 'memory' });
    expect(buildPath({ kind: 'home', view: 'memory' })).toBe('/memory');
  });

  it('still opens the page from the old /memory/<tab> links', () => {
    for (const tab of MEMORY_CENTER_TABS) {
      const route = parseRoute(`/memory/${tab}`);
      expect(route).toMatchObject({ kind: 'home', view: 'memory' });
      // A link round-trips, with the old default tab folded into the bare path.
      expect(buildPath(route)).toBe(tab === 'agent' ? '/memory' : `/memory/${tab}`);
    }
    // An unknown segment is not a tab; the page still opens.
    expect(parseRoute('/memory/whatever')).toEqual({ kind: 'home', view: 'memory' });
  });
});

describe('Primary left sidebar `记忆` navigation item', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    window.localStorage.clear();
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    mocks.route = { kind: 'home', view: 'home' };
    mocks.navigate.mockClear();
    resetSidebarStoreForTests();
    resetMemoryPendingCountForTests();
  });

  afterEach(() => {
    cleanup();
    resetMemoryPendingCountForTests();
    vi.unstubAllEnvs();
  });

  it('renders `记忆` alongside primary nav siblings, shows pending badge, and navigates to /memory', () => {
    render(
      <I18nProvider initial="zh-CN">
        <FantayShell
          clientType="web"
          hostPlatform={undefined}
          projects={[]}
          projectsLoading={false}
          onOpenProject={vi.fn()}
          onRenameProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onDeleteProject={vi.fn()}
          onOpenSettings={vi.fn()}
        >
          <div data-testid="main-slot" />
        </FantayShell>
      </I18nProvider>,
    );

    const navOrder = [
      'fantay-sidebar-pa',
      'fantay-sidebar-home',
      'fantay-sidebar-workbench',
      'fantay-sidebar-memory',
      'fantay-sidebar-materials',
      'fantay-sidebar-plugins',
      'fantay-sidebar-automations',
      'fantay-sidebar-community',
    ];
    const nodes = navOrder.map((id) => screen.getByTestId(id));
    expect(nodes[3]!.textContent).toContain('记忆');
    nodes.slice(1).forEach((node, idx) => {
      expect(nodes[idx]!.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    });

    act(() => {
      setMemoryPendingCount(3);
    });
    expect(screen.getByTestId('fantay-memory-pending').textContent).toBe('3');

    fireEvent.click(screen.getByTestId('fantay-sidebar-memory'));
    expect(mocks.navigate).toHaveBeenCalledWith({ kind: 'home', view: 'memory' });
  });

  it('marks `记忆` active with aria-current="page" when viewing /memory', () => {
    mocks.route = { kind: 'home', view: 'memory', memoryTab: 'inspector' };
    render(
      <I18nProvider initial="zh-CN">
        <FantayShell
          clientType="web"
          hostPlatform={undefined}
          projects={[]}
          projectsLoading={false}
          onOpenProject={vi.fn()}
          onRenameProject={vi.fn()}
          onDuplicateProject={vi.fn()}
          onDeleteProject={vi.fn()}
          onOpenSettings={vi.fn()}
        >
          <div />
        </FantayShell>
      </I18nProvider>,
    );

    const memoryBtn = screen.getByTestId('fantay-sidebar-memory');
    expect(memoryBtn).toHaveAttribute('aria-current', 'page');
    expect(memoryBtn).toHaveAttribute('data-active', '');
  });
});

describe('the sidebar 记忆 badge', () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    resetMemoryPendingCountForTests();
  });

  it('reads the inbox counts at most once a minute and hides at zero', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    let inbox = { conflicts: 1, pending: 2 };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({ inbox }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    render(
      <I18nProvider initial="zh-CN">
        <MemoryNavigationLabel />
      </I18nProvider>,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]![0])).toBe('/api/memory-center/overview');
    expect(screen.getByTestId('fantay-memory-pending').textContent).toBe('3');
    expect(screen.getByTestId('fantay-memory-pending').getAttribute('aria-label')).toBe('3 项记忆等你处理');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    inbox = { conflicts: 0, pending: 0 };
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByTestId('fantay-memory-pending')).toBeNull();
  });
});

describe('D3 scope default & private profile labeling rules', () => {
  it('labels `private` explicitly as `个人画像与全局偏好` across PA modal, filter, and scope badges', () => {
    expect(paManageZh['pa.memoryForm.scopePrivate']).toBe('个人画像与全局偏好');
    expect(paPagesZh['pa.memory.filterPrivate']).toBe('个人画像与全局偏好');
    expect(paShellZh['pa.scope.private']).toBe('个人画像与全局偏好');
  });

  it('defaults New Memory from a Bot to scope="agent" + botId, and from a Project to scope="project" + projectId', () => {
    const fixture = buildFixture('project-done', 1_760_000_000_000);
    const index = buildIndex(fixture.snapshot, fixture.channels, fixture.models, null, 'zh');
    const projects: Project[] = [
      { id: 'proj-408', name: '408 复习卡片', skillId: null, designSystemId: null, createdAt: 1, updatedAt: 2 },
    ];
    const bots = [...index.agents.values()];
    expect(bots.length).toBeGreaterThan(0);
    const targetBot = bots[bots.length - 1]!;

    // Explicit Bot preset -> agent + botId
    expect(
      resolveDefaultMemoryScope({ scope: 'agent', scopeId: targetBot.id }, index, projects),
    ).toEqual({ scope: 'agent', scopeId: targetBot.id });

    // Inspected Bot without explicit preset -> agent + botId (never global private)
    expect(
      resolveDefaultMemoryScope(undefined, index, projects, {
        conversationId: null,
        inspectorAgentId: targetBot.id,
      }),
    ).toEqual({ scope: 'agent', scopeId: targetBot.id });

    // Project context -> project + projectId
    expect(
      resolveDefaultMemoryScope({ projectId: 'proj-408' }, index, projects),
    ).toEqual({ scope: 'project', scopeId: 'proj-408' });

    expect(
      resolveDefaultMemoryScope({ scope: 'project' }, index, projects),
    ).toEqual({ scope: 'project', scopeId: 'proj-408' });
  });
});
