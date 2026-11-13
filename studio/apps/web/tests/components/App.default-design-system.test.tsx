// @vitest-environment jsdom
import '../helpers/signed-in-tokentosea';
// Fantay fork: a fresh install (no stored designSystemId) auto-selects the
// `fantay` design system, then upstream's `default`, then the first one.
// Harness trimmed from App.switch-cloud-persistence.test.tsx: App's real
// config owner runs; only data loaders and heavy views are stubbed.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { App } from '../../src/App';
import type { Route } from '../../src/router';
import type { AppConfig, DesignSystemSummary, Project } from '../../src/types';
import {
  fetchComposioConfigFromDaemon,
  fetchDaemonConfig,
  fetchMediaProvidersFromDaemon,
  loadConfig,
  mergeDaemonConfig,
  saveConfig,
} from '../../src/state/config';
import {
  daemonIsLive,
  fetchAgents,
  fetchAppVersionInfo,
  fetchDesignSystems,
  fetchDesignTemplates,
  fetchPromptTemplates,
  fetchSkills,
} from '../../src/providers/registry';
import { listProjects, listTemplates } from '../../src/state/projects';
import {
  resetWorkspaceBillingCache,
  resetWorkspaceContextCache,
} from '../../src/collab/useWorkspaceContext';
import { resetWorkspaceDirectoryCache } from '../../src/components/EntryNavRail';

const PROJECT_ROUTE: Route = {
  kind: 'project' as const,
  projectId: 'project-1',
  conversationId: null,
  fileName: null,
};
const useRouteMock = vi.fn<() => Route>(() => PROJECT_ROUTE);
const useProjectRouteWorkspaceContextMock = vi.hoisted(() => vi.fn());

vi.mock('../../src/router', () => ({
  navigate: vi.fn(),
  useRoute: () => useRouteMock(),
}));

vi.mock('../../src/collab/useProjectRouteWorkspaceContext', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../../src/collab/useProjectRouteWorkspaceContext')
  >();
  return {
    ...actual,
    useProjectRouteWorkspaceContext: useProjectRouteWorkspaceContextMock,
  };
});

vi.mock('../../src/components/EntryView', () => ({
  EntryView: () => <div>Entry view</div>,
}));

vi.mock('../../src/components/ProjectView', () => ({
  ProjectView: (props: { config: AppConfig }) => (
    <output data-testid="design-system">{props.config.designSystemId ?? 'none'}</output>
  ),
}));

vi.mock('../../src/components/pet/PetOverlay', () => ({
  PetOverlay: () => null,
}));

vi.mock('../../src/components/pet/pets', () => ({
  migrateCustomPetAtlas: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../src/components/WorkspaceTabsBar', () => ({
  openWorkspaceTab: vi.fn(),
  WorkspaceTabsBar: () => null,
}));

vi.mock('../../src/components/MemoryToast', async () => {
  const actual = await vi.importActual<typeof import('../../src/components/MemoryToast')>(
    '../../src/components/MemoryToast',
  );
  return { ...actual, MemoryToast: () => null };
});

vi.mock('../../src/components/PrivacyConsentModal', () => ({
  PrivacyConsentModal: () => null,
}));

vi.mock('../../src/providers/registry', async () => {
  const actual = await vi.importActual<typeof import('../../src/providers/registry')>(
    '../../src/providers/registry',
  );
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

vi.mock('../../src/state/projects', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/projects')>(
    '../../src/state/projects',
  );
  return { ...actual, listProjects: vi.fn(), listTemplates: vi.fn() };
});

vi.mock('../../src/state/config', async () => {
  const actual = await vi.importActual<typeof import('../../src/state/config')>(
    '../../src/state/config',
  );
  return {
    ...actual,
    fetchComposioConfigFromDaemon: vi.fn(),
    fetchDaemonConfig: vi.fn(),
    fetchMediaProvidersFromDaemon: vi.fn(),
    loadConfig: vi.fn(),
    mergeDaemonConfig: vi.fn(),
    saveConfig: vi.fn(),
    syncComposioConfigToDaemon: vi.fn().mockResolvedValue(true),
  };
});

const baseConfig: AppConfig = {
  mode: 'api',
  apiKey: '',
  apiProtocol: 'anthropic',
  apiVersion: '',
  baseUrl: 'https://api.anthropic.com',
  model: 'claude-sonnet-4-5',
  apiProviderBaseUrl: 'https://api.anthropic.com',
  apiProtocolConfigs: {},
  agentId: 'codex',
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
};

function system(id: string): DesignSystemSummary {
  return { id, title: id, category: 'Test', summary: '' } as DesignSystemSummary;
}

let appConfigPuts: Array<Record<string, unknown>>;

beforeEach(() => {
  resetWorkspaceContextCache();
  resetWorkspaceBillingCache();
  resetWorkspaceDirectoryCache();
  appConfigPuts = [];
  useRouteMock.mockReturnValue(PROJECT_ROUTE);
  vi.mocked(daemonIsLive).mockResolvedValue(true);
  vi.mocked(fetchAgents).mockResolvedValue([]);
  vi.mocked(fetchSkills).mockResolvedValue([]);
  vi.mocked(fetchDesignTemplates).mockResolvedValue([]);
  vi.mocked(fetchPromptTemplates).mockResolvedValue([]);
  vi.mocked(fetchAppVersionInfo).mockResolvedValue(null);
  vi.mocked(listProjects).mockResolvedValue([project]);
  vi.mocked(listTemplates).mockResolvedValue([]);
  vi.mocked(fetchDaemonConfig).mockResolvedValue({});
  vi.mocked(fetchComposioConfigFromDaemon).mockResolvedValue(null);
  vi.mocked(fetchMediaProvidersFromDaemon).mockResolvedValue({ status: 'ok', providers: {} });
  vi.mocked(mergeDaemonConfig).mockImplementation((local) => local);
  vi.mocked(loadConfig).mockReturnValue({ ...baseConfig });
  useProjectRouteWorkspaceContextMock.mockReturnValue({ context: null, loading: false, retry: vi.fn() });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url === '/api/app-config' && init?.method === 'PUT') {
        appConfigPuts.push(JSON.parse(String(init.body ?? '{}')) as Record<string, unknown>);
      }
      return new Response('{}', { status: 200 });
    }),
  );
  window.history.replaceState(null, '', '/projects/project-1');
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('App default design system', () => {
  it.each([
    ['fantay first', ['airbnb', 'default', 'fantay'], 'fantay'],
    ['default when fantay is absent', ['airbnb', 'default'], 'default'],
    ['the first system otherwise', ['airbnb', 'ant'], 'airbnb'],
  ] as const)('auto-picks %s', async (_label, ids, expected) => {
    vi.mocked(fetchDesignSystems).mockResolvedValue(ids.map(system));
    render(<App />);
    await waitFor(() => expect(screen.getByTestId('design-system')).toHaveTextContent(expected));
    expect(vi.mocked(saveConfig).mock.calls.some(([config]) => config.designSystemId === expected)).toBe(true);
    await waitFor(() =>
      expect(appConfigPuts.some((body) => body.designSystemId === expected)).toBe(true),
    );
  });

  it('keeps a stored selection', async () => {
    vi.mocked(loadConfig).mockReturnValue({ ...baseConfig, designSystemId: 'airbnb' });
    vi.mocked(fetchDesignSystems).mockResolvedValue(['default', 'fantay', 'airbnb'].map(system));
    render(<App />);
    await screen.findByTestId('design-system');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(screen.getByTestId('design-system')).toHaveTextContent('airbnb');
    expect(vi.mocked(saveConfig).mock.calls.some(([config]) => config.designSystemId === 'fantay')).toBe(false);
  });
});
