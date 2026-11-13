// @vitest-environment jsdom
import '../../helpers/signed-in-tokentosea';
// SPDX-License-Identifier: Apache-2.0
// App with the Fantay shell on (spec 02 §6.1, amendment B6): App renders `<FantayShell>{appMain}</FantayShell>`
// instead of `.workspace-shell__body`, mounts no WorkspaceTabsBar, and the real upstream account cluster of
// the project route (WorkspaceTopRightAccountCluster → EntryTopRightCluster) portals into the sidebar's one
// `#workspace-chrome-account-actions` host, where it stays while the sidebar changes mode. `/movie-app`
// (embeddedMovie) keeps the upstream chrome-free shell. Harness mirrors
// tests/components/App.project-account-cluster.test.tsx.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceCollabContext, WorkspaceDirectoryItem } from '@open-design/contracts';

import type { Route } from '../../../src/router';
import type { AppConfig, Project } from '../../../src/types';

const PROJECT_ROUTE: Route = { kind: 'project', projectId: 'project-1', conversationId: null, fileName: null };
const useRouteMock = vi.fn<() => Route>(() => PROJECT_ROUTE);
const useProjectRouteWorkspaceContextMock = vi.hoisted(() => vi.fn());
const projectViewMounted = vi.hoisted(() => vi.fn());
const workspaceTabsBarRendered = vi.hoisted(() => vi.fn());

vi.mock('../../../src/router', () => ({
  canGoBackInApp: () => false,
  goBack: vi.fn(),
  navigate: vi.fn(),
  useRoute: () => useRouteMock(),
}));

vi.mock('../../../src/collab/useProjectRouteWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/collab/useProjectRouteWorkspaceContext')>();
  return { ...actual, useProjectRouteWorkspaceContext: useProjectRouteWorkspaceContextMock };
});

vi.mock('../../../src/providers/daemon', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/daemon')>();
  return { ...actual, fetchVelaLoginStatus: vi.fn().mockResolvedValue(null) };
});

vi.mock('../../../src/components/EntryView', () => ({ EntryView: () => <div>Entry view</div> }));

vi.mock('../../../src/components/ProjectView', () => ({
  ProjectView: () => {
    useEffect(() => {
      projectViewMounted();
    }, []);
    return <div data-testid="project-view">Project view</div>;
  },
}));

vi.mock('../../../src/components/pet/PetOverlay', () => ({ PetOverlay: () => null }));
vi.mock('../../../src/components/pet/pets', () => ({ migrateCustomPetAtlas: vi.fn().mockResolvedValue(null) }));

vi.mock('../../../src/components/WorkspaceTabsBar', () => ({
  openWorkspaceTab: vi.fn(),
  removeWorkspaceProjectTabs: vi.fn(),
  WorkspaceTabsBar: () => {
    workspaceTabsBarRendered();
    return <div data-testid="workspace-tabs-bar" />;
  },
}));

vi.mock('../../../src/components/MemoryToast', async () => {
  const actual = await vi.importActual<typeof import('../../../src/components/MemoryToast')>('../../../src/components/MemoryToast');
  return { ...actual, MemoryToast: () => null };
});

vi.mock('../../../src/components/PrivacyConsentModal', () => ({ PrivacyConsentModal: () => null }));

vi.mock('../../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../../src/providers/registry')>('../../../src/providers/registry');
  return {
    ...actual,
    daemonIsLive: vi.fn(),
    fetchAgents: vi.fn(),
    fetchAppVersionInfo: vi.fn(),
    fetchDesignSystems: vi.fn(),
    fetchDesignTemplates: vi.fn(),
    fetchPromptTemplates: vi.fn(),
    fetchSkills: vi.fn(),
  };
});

vi.mock('../../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../../src/state/projects')>('../../../src/state/projects');
  return { ...actual, listProjects: vi.fn(), listTemplates: vi.fn() };
});

vi.mock('../../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../../src/state/config')>('../../../src/state/config');
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn(),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
    syncConfigToDaemon: vi.fn().mockResolvedValue(undefined),
  };
});

import { App } from '../../../src/App';
import { resetWorkspaceDirectoryCache } from '../../../src/components/EntryNavRail';
import { WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID } from '../../../src/components/workspaceChromeActions';
import { resetWorkspaceBillingCache, resetWorkspaceContextCache } from '../../../src/collab/useWorkspaceContext';
import { resetFantayCommandsForTests } from '../../../src/fantay/shell/commands';
import { resetFantayProjectBridgeForTests } from '../../../src/fantay/shell/project-bridge';
import { SIDEBAR_COLLAPSED_STORAGE_KEY, resetSidebarStoreForTests } from '../../../src/fantay/shell/sidebar-store';
import {
  daemonIsLive,
  fetchAgents,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../../src/providers/registry';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  fetchMediaProvidersFromDaemon,
  loadConfig,
  mergeDaemonConfig,
} from '../../../src/state/config';
import { listProjects, listTemplates } from '../../../src/state/projects';

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: null,
  skillId: null,
  designSystemId: null,
  onboardingCompleted: true,
  mediaProviders: {},
  agentModels: {},
  agentCliEnv: {},
  privacyDecisionAt: 1778244000000,
};

const project: Project = {
  id: 'project-1',
  name: 'Project 1',
  skillId: null,
  designSystemId: null,
  customInstructions: '',
  createdAt: 1,
  updatedAt: 1,
  workspaceId: 'ws-project',
};

const DIRECTORY_ITEM: WorkspaceDirectoryItem = {
  workspaceId: 'ws-project',
  workspaceMemberId: 'wm-project',
  workspaceName: 'Project Workspace',
  workspaceType: 'personal',
  role: 'owner',
  memberStatus: 'active',
  lifecycleState: 'active',
};

const WORKSPACE_CONTEXT: WorkspaceCollabContext = {
  ...DIRECTORY_ITEM,
  displayName: 'Project Nova',
  billingState: 'active',
  planId: 'pro',
  providerMode: 'platform_credits',
  seatSummary: { seatLimit: 0, usedSeats: 0, availableSeats: 0, isSeatFull: false },
  permissions: {
    canManageMembers: false,
    canManageBilling: true,
    canInviteMembers: false,
    canManageAutoRecharge: true,
    canShareProjects: false,
    canWriteSyncedFiles: false,
    canViewWorkspaceSettings: false,
    canManageSharedResources: false,
  },
  workspaceSettingsUrl: 'https://cloud.example/settings?workspaceId=ws-project',
};

const BILLING_RESPONSE = {
  summary: {
    workspaceId: 'ws-project',
    membershipTier: 'pro',
    totalAvailableCredits: 0,
    subscriptionCredits: 0,
    rechargeCredits: 0,
    balanceUsd: '12.34',
    subscriptionStatus: 'active',
    availableActions: [],
  },
  workspaceBalance: { billingScopeVersion: 2, workspaceId: 'ws-project', workspaceMemberId: 'wm-project', balanceUsd: '12.34' },
};

function stubFetchByUrl() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const body = url.includes('/api/workspace/directory')
        ? { items: [DIRECTORY_ITEM] }
        : url.includes('/api/workspace/context')
          ? { context: WORKSPACE_CONTEXT }
          : url.includes('/api/workspace/billing')
            ? BILLING_RESPONSE
            : {};
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
}

describe('App with the Fantay shell on', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    window.localStorage.clear();
    window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, '0');
    Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: 1440 });
    resetWorkspaceContextCache();
    resetWorkspaceBillingCache();
    resetWorkspaceDirectoryCache();
    resetSidebarStoreForTests();
    resetFantayCommandsForTests();
    resetFantayProjectBridgeForTests();
    useRouteMock.mockReturnValue(PROJECT_ROUTE);
    vi.mocked(daemonIsLive).mockResolvedValue(true);
    vi.mocked(fetchAgents).mockResolvedValue([]);
    vi.mocked(fetchSkills).mockResolvedValue([]);
    vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
    vi.mocked(fetchDesignSystems).mockResolvedValue([]);
    vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
    vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
    vi.mocked(listProjects).mockResolvedValue([project]);
    vi.mocked(listTemplates).mockResolvedValue([]);
    vi.mocked(fetchDaemonConfig).mockResolvedValue({});
    vi.mocked(fetchComposioConfigFromDaemon).mockResolvedValue(null);
    vi.mocked(fetchMediaProvidersFromDaemon).mockResolvedValue({ status: 'ok', providers: {} });
    vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
    vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
    useProjectRouteWorkspaceContextMock.mockReturnValue({ context: WORKSPACE_CONTEXT, loading: false, retry: vi.fn() });
    stubFetchByUrl();
    window.history.replaceState(null, '', '/projects/project-1');
    projectViewMounted.mockClear();
    workspaceTabsBarRendered.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.clearAllMocks();
    resetWorkspaceContextCache();
    resetWorkspaceBillingCache();
    resetWorkspaceDirectoryCache();
  });

  it('wraps the project route in the shell, without the tabs bar, and docks the account cluster in the sidebar', async () => {
    render(<App />);
    const main = await screen.findByTestId('fantay-shell-main');
    expect(main).toContainElement(await screen.findByTestId('project-view'));
    expect(screen.getByTestId('fantay-shell').parentElement).not.toHaveClass('workspace-shell');
    expect(document.querySelector('.workspace-shell__body')).toBeNull();
    expect(screen.queryByTestId('workspace-tabs-bar')).toBeNull();
    expect(workspaceTabsBarRendered).not.toHaveBeenCalled();

    const credits = await screen.findByTestId('entry-top-right-credits');
    const hosts = document.querySelectorAll(`#${WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID}`);
    expect(hosts).toHaveLength(1);
    expect(hosts[0]).toContainElement(credits);
    expect(screen.getByTestId('fantay-sidebar-dock')).toContainElement(credits);
    // the sidebar lists the route's project and marks it open
    expect(screen.getByTestId('fantay-sidebar-project-project-1')).toHaveAttribute('aria-current', 'page');
  });

  it('keeps the cluster and the project view mounted while the sidebar folds to the rail', async () => {
    render(<App />);
    const credits = await screen.findByTestId('entry-top-right-credits');
    const host = document.getElementById(WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID);
    fireEvent.keyDown(document.body, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(screen.getByTestId('fantay-shell')).toHaveAttribute('data-sidebar', 'collapsed');
    expect(document.getElementById(WORKSPACE_CHROME_ACCOUNT_ACTIONS_ID)).toBe(host);
    expect(host).toContainElement(credits);
    expect(projectViewMounted).toHaveBeenCalledTimes(1);
  });

  it('leaves the chrome-free /movie-app surface exactly as upstream renders it', async () => {
    useRouteMock.mockReturnValue({ kind: 'home', view: 'movies', embeddedMovie: true });
    window.history.replaceState(null, '', '/movie-app');
    const view = render(<App />);
    await screen.findByText('Entry view');
    expect(screen.queryByTestId('fantay-shell')).toBeNull();
    expect(view.container.querySelector('.workspace-shell')).not.toBeNull();
    expect(view.container.querySelector('.workspace-shell__body')).not.toBeNull();
    expect(screen.queryByTestId('workspace-tabs-bar')).toBeNull();
    await act(async () => undefined);
  });
});
