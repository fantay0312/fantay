// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect, useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProjectView } from '../../src/components/ProjectView';
import { FantayShellContext, type FantayShellContextValue } from '../../src/fantay/shell/shell-context';
import { navigate } from '../../src/router';
import type {
  AgentInfo,
  AppConfig,
  Conversation,
  DesignSystemSummary,
  Project,
  SkillSummary,
} from '../../src/types';
import {
  cacheTabsLocally,
  createConversation,
  listConversations,
  listMessages,
  loadTabs,
} from '../../src/state/projects';
import { fetchPreviewComments, fetchProjectFiles } from '../../src/providers/registry';

vi.mock('../../src/i18n', () => ({
  useI18n: () => ({
    locale: 'en',
    setLocale: () => undefined,
    t: (key: string) => key,
  }),
  useT: () => (key: string) => key,
}));

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
}));

vi.mock('../../src/collab/useProjectCollab', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/collab/useProjectCollab')>();
  return { ...actual, useProjectCollab: (...args: Parameters<typeof actual.useProjectCollab>) => ({
    ...actual.useProjectCollab(...args), viewerOnly: false, materializationPending: false,
  }) };
});

vi.mock('../../src/providers/anthropic', () => ({
  streamMessage: vi.fn(),
}));

vi.mock('../../src/providers/daemon', () => ({
  fetchChatRunStatus: vi.fn(),
  listActiveChatRuns: vi.fn().mockResolvedValue([]),
  listProjectRuns: vi.fn().mockResolvedValue([]),
  publishDaemonRunFinishedEvent: vi.fn(),
  reattachDaemonRun: vi.fn(),
  streamViaDaemon: vi.fn(),
}));

vi.mock('../../src/providers/project-events', () => ({
  useProjectFileEvents: vi.fn(),
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
  return {
    ...actual,
    deletePreviewComment: vi.fn(),
    fetchDesignSystem: vi.fn(),
    fetchLiveArtifacts: vi.fn().mockResolvedValue([]),
    fetchPreviewComments: vi.fn(),
    fetchProjectFiles: vi.fn().mockResolvedValue([]),
    fetchSkill: vi.fn(),
    getTemplate: vi.fn(),
    patchPreviewCommentStatus: vi.fn(),
    upsertPreviewComment: vi.fn(),
    writeProjectTextFile: vi.fn(),
  };
});

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return {
    ...actual,
    cacheTabsLocally: vi.fn((_projectId: string, state: { tabs: string[]; active: string | null }) => state),
    createConversation: vi.fn(),
    listConversations: vi.fn(),
    listMessages: vi.fn(),
    loadTabs: vi.fn(),
    patchConversation: vi.fn(),
    patchProject: vi.fn(),
    persistTabsToDaemonNow: vi.fn(),
    saveMessage: vi.fn(),
    saveTabs: vi.fn(),
  };
});

vi.mock('../../src/components/AppChromeHeader', () => ({
  AppChromeHeader: ({ children }: { children: ReactNode }) => (
    <header>{children}</header>
  ),
}));

vi.mock('../../src/components/AvatarMenu', () => ({
  AvatarMenu: () => null,
}));

vi.mock('../../src/components/FileWorkspace', () => ({
  DESIGN_SYSTEM_TAB: '__design_system__',
  FileWorkspace: ({ tabsState, onTabsStateChange, designSystemProject, openRequest }: {
    tabsState: { tabs: string[]; active: string | null };
    onTabsStateChange: (state: { tabs: string[]; active: string | null }) => void;
    designSystemProject?: DesignSystemSummary | null;
    openRequest?: { name: string; nonce: number } | null;
  }) => {
    useEffect(() => {
      if (!openRequest?.name) return;
      if (tabsState.active === openRequest.name && tabsState.tabs.includes(openRequest.name)) return;
      const tabs = tabsState.tabs.includes(openRequest.name)
        ? tabsState.tabs
        : [...tabsState.tabs, openRequest.name];
      onTabsStateChange({ tabs, active: openRequest.name });
    }, [onTabsStateChange, openRequest?.name, openRequest?.nonce, tabsState.tabs]);
    return (
      <div data-testid="file-workspace">
        <output data-testid="workspace-active-tab">{tabsState.active ?? ''}</output>
        <output data-testid="workspace-design-system-id">{designSystemProject?.id ?? ''}</output>
        <button
          type="button"
          data-testid="close-all-tabs"
          onClick={() => onTabsStateChange({ tabs: [], active: null })}
        >
          close all tabs
        </button>
      </div>
    );
  },
}));

vi.mock('../../src/components/Loading', () => ({
  CenteredLoader: () => <div data-testid="loader" />,
}));

vi.mock('../../src/components/ChatPane', () => ({
  ChatPane: () => <div data-testid="chat-pane" />,
}));

const mockedListConversations = vi.mocked(listConversations);
const mockedCreateConversation = vi.mocked(createConversation);
const mockedListMessages = vi.mocked(listMessages);
const mockedLoadTabs = vi.mocked(loadTabs);
const mockedCacheTabsLocally = vi.mocked(cacheTabsLocally);
const mockedFetchPreviewComments = vi.mocked(fetchPreviewComments);
const mockedFetchProjectFiles = vi.mocked(fetchProjectFiles);
const mockedNavigate = vi.mocked(navigate);

const config: AppConfig = {
  mode: 'api',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  createdAt: 1,
  updatedAt: 1,
};

const conversation: Conversation = {
  id: 'conv-1',
  projectId: project.id,
  title: null,
  createdAt: 1,
  updatedAt: 1,
};

function renderProjectView(props?: {
  project?: Project;
  designSystems?: DesignSystemSummary[];
  routeFileName?: string | null;
  routeConversationId?: string | null;
}) {
  return render(
    <ProjectView
      project={props?.project ?? project}
      routeFileName={props?.routeFileName ?? null}
      routeConversationId={props?.routeConversationId ?? null}
      config={config}
      agents={[] as AgentInfo[]}
      skills={[] as SkillSummary[]}
      designTemplates={[] as SkillSummary[]}
      designSystems={props?.designSystems ?? ([] as DesignSystemSummary[])}
      daemonLive
      onModeChange={vi.fn()}
      onAgentChange={vi.fn()}
      onAgentModelChange={vi.fn()}
      onRefreshAgents={vi.fn()}
      onOpenSettings={vi.fn()}
      onBack={vi.fn()}
      onClearPendingPrompt={vi.fn()}
      onTouchProject={vi.fn()}
      onProjectChange={vi.fn()}
      onProjectsRefresh={vi.fn()}
    />,
  );
}

describe('ProjectView tab URL hydration', () => {
  it('keeps the dedicated movie workspace as the final hydrated route', async () => {
    mockedListConversations.mockResolvedValue([conversation]);
    mockedLoadTabs.mockResolvedValue({ tabs: ['movie-studio.json'], active: 'movie-studio.json', hasSavedState: true });
    renderProjectView({ routeFileName: 'movie-studio.json' });
    await waitFor(() => expect(mockedNavigate).toHaveBeenLastCalledWith({
      kind: 'home', view: 'movies', embeddedMovie: true, movieProjectId: project.id,
    }, { replace: true }));
  });
  beforeEach(() => {
    mockedListConversations.mockResolvedValue([conversation]);
    mockedCreateConversation.mockResolvedValue(conversation);
    mockedListMessages.mockResolvedValue([]);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });
    mockedFetchProjectFiles.mockResolvedValue([]);
    mockedFetchPreviewComments.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('syncs a persisted active tab to the URL before the file list has hydrated', async () => {
    renderProjectView();

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        // The active conversation id is threaded into the URL alongside
        // the active tab so a reload / share preserves the conversation
        // segment of `/projects/:id/conversations/:cid/files/...`
        // (PerishCode + Codex P1 on PR #1508).
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });

  it('passes brand-extracted backing systems to the in-project Design System tab', async () => {
    const extractedSystem: DesignSystemSummary = {
      id: 'user:baidu',
      title: '百度一下，你就知道',
      category: 'Custom',
      summary: 'Programmatic extraction from DESIGN.md.',
      swatches: [],
      surface: 'web',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    renderProjectView({
      project: {
        ...project,
        name: '百度一下，你就知道',
        designSystemId: null,
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandDesignSystemId: 'user:baidu',
        },
      },
      designSystems: [extractedSystem],
    });

    await waitFor(() => {
      expect(screen.getByTestId('workspace-design-system-id').textContent).toBe('user:baidu');
    });
  });

  it('does not auto-open the brand design system over a routed file', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    const extractedSystem: DesignSystemSummary = {
      id: 'user:baidu',
      title: '百度一下，你就知道',
      category: 'Custom',
      summary: 'Programmatic extraction from DESIGN.md.',
      swatches: [],
      surface: 'web',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    renderProjectView({
      project: {
        ...project,
        name: '百度一下，你就知道',
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandDesignSystemId: 'user:baidu',
        },
      },
      designSystems: [extractedSystem],
      routeFileName: 'brand.html',
    });

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe('brand.html'));
    expect(mockedCacheTabsLocally.mock.calls.at(-1)).toEqual([
      project.id,
      { tabs: ['brand.html'], active: 'brand.html' },
      null,
    ]);
  });

  it('does not auto-open the brand design system over a persisted active tab', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: ['brand.html'], active: 'brand.html', hasSavedState: true });
    const extractedSystem: DesignSystemSummary = {
      id: 'user:baidu',
      title: '百度一下，你就知道',
      category: 'Custom',
      summary: 'Programmatic extraction from DESIGN.md.',
      swatches: [],
      surface: 'web',
      source: 'user',
      status: 'draft',
      isEditable: true,
    };
    renderProjectView({
      project: {
        ...project,
        name: '百度一下，你就知道',
        metadata: {
          kind: 'brand',
          importedFrom: 'brand-extraction',
          brandDesignSystemId: 'user:baidu',
        },
      },
      designSystems: [extractedSystem],
    });

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe('brand.html'));
    expect(mockedCacheTabsLocally).not.toHaveBeenCalledWith(
      project.id,
      expect.objectContaining({ active: '__design_system__' }),
    );
  });

  it('preserves a restarted deep-linked conversation while its DB conversation list hydrates', async () => {
    // Race shape: `loadTabs` resolves and sets the active tab BEFORE
    // `listConversations` resolves and restores `activeConversationId`. The
    // route already identifies the persisted DB conversation, so the interim
    // tab sync must retain it instead of replacing
    // `/projects/:id/conversations/:cid/files/...` with `/projects/:id/files/...`.
    // Once the list resolves, the same id becomes active and remains canonical.
    let resolveConversations: (value: Conversation[]) => void = () => {};
    const conversationsPromise = new Promise<Conversation[]>((resolve) => {
      resolveConversations = resolve;
    });
    mockedListConversations.mockReturnValue(conversationsPromise);
    mockedLoadTabs.mockResolvedValue({ tabs: ['index.html'], active: 'index.html' });

    renderProjectView({ routeConversationId: conversation.id });

    // First navigate: active tab synced, conversation still loading. The
    // existing route is the only conversation authority available.
    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: conversation.id,
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
    expect(mockedNavigate).not.toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: null }),
      { replace: true },
    );

    // Now resolve the conversation list. The routed conversation is present in
    // DB and becomes the active conversation without an intermediate route loss.
    resolveConversations([conversation]);

    await waitFor(() => {
      expect(mockedNavigate).toHaveBeenCalledWith(
        {
          kind: 'project',
          projectId: project.id,
          conversationId: 'conv-1',
          fileName: 'index.html',
        },
        { replace: true },
      );
    });
  });

  it('does not reopen the primary file after the user closes the last tab', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null });
    mockedFetchProjectFiles.mockResolvedValue([
      {
        name: 'index.html',
        path: 'index.html',
        type: 'file',
        size: 1,
        mtime: 1,
        mime: 'text/html',
        kind: 'html',
        artifactManifest: {
          version: 1,
          kind: 'html',
          title: 'Index',
          entry: 'index.html',
          renderer: 'html',
          primary: true,
          exports: ['html'],
        },
      },
    ]);

    renderProjectView();

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe('index.html'));
    // Tab state persists synchronously through cacheTabsLocally (the daemon PUT
    // is debounced via persistTabsToDaemonNow); assert on the synchronous cache
    // write so the test stays deterministic without driving the debounce timer.
    expect(mockedCacheTabsLocally).toHaveBeenCalledWith(
      project.id,
      { tabs: ['index.html'], active: 'index.html' },
      null,
    );

    fireEvent.click(screen.getByTestId('close-all-tabs'));

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe(''));
    await waitFor(() => {
      expect(mockedCacheTabsLocally.mock.calls.at(-1)).toEqual([
        project.id,
        { tabs: [], active: null },
        null,
      ]);
    });
    // Exactly two writes — the initial primary open and the close-all — proving
    // the primary file is not silently reopened after the last tab closes.
    expect(mockedCacheTabsLocally).toHaveBeenCalledTimes(2);
  });

  it.each([
    { tabs: ['restore-me.png'], active: '__design_files__' },
    { tabs: [], active: null },
  ])('keeps a locally restored selection over the default primary file: $active', async (selection) => {
    const actual = await vi.importActual<typeof import('../../src/state/projects')>(
      '../../src/state/projects',
    );
    const cachedProjectId = `local-restoration-${selection.active ?? 'empty'}`;
    const cacheKey = `open-design:project-tabs:v1:${cachedProjectId}`;
    window.localStorage.setItem(cacheKey, JSON.stringify({ ...selection, updatedAt: 2 }));
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(Response.json({
      tabs: [], active: null, hasSavedState: false,
    }));
    let restored;
    try {
      restored = await actual.loadTabs(cachedProjectId, null, {
        reconcileNewerCacheToDaemon: false,
      });
    } finally {
      fetchSpy.mockRestore();
      window.localStorage.removeItem(cacheKey);
    }
    mockedLoadTabs.mockResolvedValue(restored);
    mockedFetchProjectFiles.mockResolvedValue([{
      name: 'restore-me.png', path: 'restore-me.png', type: 'file',
      size: 1, mtime: 1, mime: 'image/png', kind: 'image',
    }]);

    renderProjectView({ project: { ...project, id: cachedProjectId } });

    await waitFor(() => expect(mockedFetchProjectFiles).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent)
      .toBe(selection.active ?? ''));
    expect(mockedCacheTabsLocally).not.toHaveBeenCalledWith(
      cachedProjectId, expect.objectContaining({ active: 'restore-me.png' }), null,
    );
  });

  it('does not auto-open the primary file when saved tabs were explicitly empty', async () => {
    mockedLoadTabs.mockResolvedValue({ tabs: [], active: null, hasSavedState: true });
    mockedFetchProjectFiles.mockResolvedValue([
      {
        name: 'index.html',
        path: 'index.html',
        type: 'file',
        size: 1,
        mtime: 1,
        mime: 'text/html',
        kind: 'html',
        artifactManifest: {
          version: 1,
          kind: 'html',
          title: 'Index',
          entry: 'index.html',
          renderer: 'html',
          primary: true,
          exports: ['html'],
        },
      },
    ]);

    renderProjectView();

    await waitFor(() => expect(screen.getByTestId('workspace-active-tab').textContent).toBe(''));
    expect(mockedCacheTabsLocally).not.toHaveBeenCalled();
  });

  it('collapses the right workspace on empty sub-conversations, keeps the top-right panel toggle interactive, and restores on populated conversations', async () => {
    const populatedConv: Conversation = {
      id: 'conv-populated',
      projectId: project.id,
      title: 'Populated thread',
      createdAt: 1,
      updatedAt: 2,
    };
    const emptySubConv: Conversation = {
      id: 'conv-empty',
      projectId: project.id,
      title: null,
      createdAt: 3,
      updatedAt: 3,
    };
    const emptySubConv2: Conversation = {
      id: 'conv-empty-2',
      projectId: project.id,
      title: null,
      createdAt: 4,
      updatedAt: 4,
    };
    mockedListConversations.mockResolvedValue([populatedConv, emptySubConv, emptySubConv2]);
    mockedListMessages.mockImplementation(async (_projectId: string, convId: string) => (
      convId === populatedConv.id
        ? [{ id: 'msg-1', conversationId: populatedConv.id, role: 'user', content: 'Build hero', createdAt: 2 }]
        : []
    ));
    mockedFetchProjectFiles.mockResolvedValue([
      {
        name: 'index.html',
        path: 'index.html',
        type: 'file',
        size: 128,
        mtime: 1,
        mime: 'text/html',
        kind: 'html',
      },
    ]);

    function ShellHarness({ activeConvId, routeFile }: { activeConvId: string; routeFile: string | null }) {
      const [workspaceCollapsed, setWorkspaceCollapsed] = useState(false);
      const shell: FantayShellContextValue = {
        sidebarCollapsed: false,
        sidebarMode: 'docked',
        toggleSidebar: () => undefined,
        setSidebarCollapsed: () => undefined,
        workspaceMaximized: false,
        setWorkspaceMaximized: () => undefined,
        workspaceCollapsed,
        setWorkspaceCollapsed,
        openMaterials: () => undefined,
        closeMaterials: () => undefined,
        materialsOpen: false,
        openAccountServices: () => undefined,
        openSearch: () => undefined,
        newChat: () => undefined,
        newProject: () => undefined,
      };
      return (
        <FantayShellContext.Provider value={shell}>
          <ProjectView
            project={project}
            routeFileName={routeFile}
            routeConversationId={activeConvId}
            config={config}
            agents={[] as AgentInfo[]}
            skills={[] as SkillSummary[]}
            designTemplates={[] as SkillSummary[]}
            designSystems={[] as DesignSystemSummary[]}
            daemonLive
            onModeChange={vi.fn()}
            onAgentChange={vi.fn()}
            onAgentModelChange={vi.fn()}
            onRefreshAgents={vi.fn()}
            onOpenSettings={vi.fn()}
            onBack={vi.fn()}
            onClearPendingPrompt={vi.fn()}
            onTouchProject={vi.fn()}
            onProjectChange={vi.fn()}
            onProjectsRefresh={vi.fn()}
          />
        </FantayShellContext.Provider>
      );
    }

    const view = render(<ShellHarness activeConvId={emptySubConv.id} routeFile="index.html" />);
    const split = view.container.querySelector('.split');
    expect(split).not.toBeNull();

    await waitFor(() => {
      expect(split?.classList.contains('split-workspace-collapsed')).toBe(true);
    });
    const toggle = screen.getByTestId('fantay-workspace-panel-toggle');
    expect(toggle).toBeTruthy();

    fireEvent.click(toggle);
    await waitFor(() => {
      expect(split?.classList.contains('split-workspace-collapsed')).toBe(false);
    });

    // Opening another empty sub-conversation collapses again, and switching to a populated conversation restores:
    view.rerender(<ShellHarness activeConvId={emptySubConv2.id} routeFile="index.html" />);
    await waitFor(() => {
      expect(split?.classList.contains('split-workspace-collapsed')).toBe(true);
    });

    view.rerender(<ShellHarness activeConvId={populatedConv.id} routeFile="index.html" />);
    await waitFor(() => {
      expect(split?.classList.contains('split-workspace-collapsed')).toBe(false);
    });
  });
});
