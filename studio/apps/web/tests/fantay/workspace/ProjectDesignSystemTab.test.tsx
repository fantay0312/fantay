// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// 设计系统 root of a regular project (spec 02 §7.8): session from the ProjectView bridge, design-system
// change through runProjectCommand, read-only gating, loading / failed / loaded states.
import '../helpers/radix-jsdom';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { I18nProvider } from '../../../src/i18n';
import { navigate } from '../../../src/router';
import { fetchDesignSystem } from '../../../src/providers/registry';
import {
  NO_RUNNING_CONVERSATIONS,
  resetFantayProjectBridgeForTests,
  useFantayProjectBridge,
  type FantayProjectBridgeInput,
} from '../../../src/fantay/shell/project-bridge';
import { ProjectDesignSystemTab } from '../../../src/fantay/workspace/ProjectDesignSystemTab';
import type { DesignSystemDetail, DesignSystemSummary } from '../../../src/types';

vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  fetchDesignSystem: vi.fn(),
}));

vi.mock('../../../src/router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/router')>()),
  navigate: vi.fn(),
}));

vi.mock('../../../src/runtime/design-kit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/runtime/design-kit')>()),
  useDesignKit: vi.fn((source: { title: string }) => ({
    kit: { name: source.title, editable: false, canUpload: false, colors: [], fonts: [], typography: {}, logoAlternates: [] },
    loading: false,
  })),
}));

vi.mock('../../../src/components/DesignSystemStudio', () => ({
  DesignSystemStudio: ({ dataTestId, kit, editable, embedded, badgeSlot, actionsSlot }: {
    dataTestId?: string;
    kit: { name: string };
    editable?: boolean;
    embedded?: boolean;
    badgeSlot?: ReactNode;
    actionsSlot?: ReactNode;
  }) => (
    <div data-testid={dataTestId} data-editable={String(editable)} data-embedded={String(embedded)}>
      {kit.name}
      {badgeSlot}
      {actionsSlot}
    </div>
  ),
}));

const mockedFetchDesignSystem = vi.mocked(fetchDesignSystem);
const mockedNavigate = vi.mocked(navigate);

const SYSTEMS = [
  { id: 'ds-aurora', title: 'Aurora', category: 'brand', summary: '', swatches: ['#101010', '#202020', '#303030', '#404040', '#505050'] },
  { id: 'ds-mono', title: 'Mono', category: 'brand', summary: '', swatches: ['#000000'] },
] as DesignSystemSummary[];

function detail(id: string, title: string): DesignSystemDetail {
  return { id, title, category: 'brand', summary: '', swatches: ['#101010', 'rgb(1, 2, 3)'], body: `# ${title}` };
}

let onChangeDesignSystem = vi.fn();

function bridgeInput(overrides: Partial<FantayProjectBridgeInput> = {}): FantayProjectBridgeInput {
  return {
    projectId: 'project-1',
    projectName: 'Landing',
    designSystemId: null,
    designSystems: SYSTEMS,
    conversations: [],
    activeConversationId: null,
    runningConversationIds: NO_RUNNING_CONVERSATIONS,
    readOnly: false,
    projectMetadata: null,
    mediaProviders: undefined,
    onNewConversation: vi.fn(),
    onSelectConversation: vi.fn(),
    onChangeDesignSystem,
    onOpenSettings: vi.fn(),
    ...overrides,
  };
}

function Bridge({ input }: { input: FantayProjectBridgeInput }) {
  useFantayProjectBridge(input);
  return null;
}

function renderTab(session: Partial<FantayProjectBridgeInput> | null) {
  return render(
    <>
      {session ? <Bridge input={bridgeInput(session)} /> : null}
      <ProjectDesignSystemTab projectId="project-1" />
    </>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
  onChangeDesignSystem = vi.fn();
  mockedFetchDesignSystem.mockReset();
  mockedNavigate.mockReset();
});

afterEach(() => {
  cleanup();
  resetFantayProjectBridgeForTests();
  vi.unstubAllEnvs();
});

describe('ProjectDesignSystemTab', () => {
  it('waits for the project session', () => {
    renderTab(null);
    const loading = screen.getByTestId('fantay-project-ds-loading');
    expect(within(loading).getByRole('status')).toHaveTextContent('Loading design system…');
    expect(mockedFetchDesignSystem).not.toHaveBeenCalled();
  });

  it('ignores the session of another project', () => {
    render(
      <>
        <Bridge input={bridgeInput({ projectId: 'project-2' })} />
        <ProjectDesignSystemTab projectId="project-1" />
      </>,
    );
    expect(screen.getByTestId('fantay-project-ds-loading')).toBeInTheDocument();
  });

  it('offers the catalogue when no design system is chosen and switches through ProjectView', () => {
    renderTab({ designSystemId: null });
    const none = screen.getByTestId('fantay-project-ds-none');
    expect(none).toHaveTextContent("This project doesn't use a design system yet");

    const choose = screen.getByTestId('fantay-project-ds-choose');
    expect(choose).toHaveTextContent('Choose a design system');
    fireEvent.keyDown(choose, { key: 'Enter' });
    const options = screen.getAllByRole('menuitemradio');
    expect(options.map((option) => option.textContent)).toEqual(['Aurora', 'Mono']);
    expect(options[0]).toHaveAttribute('aria-checked', 'false');
    // four swatches at most, painted with background-color only
    const swatches = options[0]!.querySelectorAll('[data-slot="ds-swatches"] > span');
    expect(swatches).toHaveLength(4);
    const swatchStyle = (swatches[0] as HTMLElement).getAttribute('style') ?? '';
    expect(swatchStyle).toMatch(/background-color:/);
    expect(swatchStyle).not.toMatch(/(^|;)\s*background:/);

    fireEvent.click(screen.getByTestId('fantay-project-ds-option-ds-mono'));
    expect(onChangeDesignSystem).toHaveBeenCalledWith('ds-mono');
    expect(mockedFetchDesignSystem).not.toHaveBeenCalled();
  });

  it('disables the choice with the read-only reason', () => {
    renderTab({ designSystemId: null, readOnly: true });
    const choose = screen.getByTestId('fantay-project-ds-choose');
    expect(choose).toHaveAttribute('aria-disabled', 'true');
    fireEvent.keyDown(choose, { key: 'Enter' });
    fireEvent.keyDown(choose, { key: 'ArrowDown' });
    fireEvent.pointerDown(choose, { button: 0, ctrlKey: false });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(onChangeDesignSystem).not.toHaveBeenCalled();
  });

  it('loads the chosen design system and renders it read-only', async () => {
    mockedFetchDesignSystem.mockResolvedValue(detail('ds-aurora', 'Aurora'));
    renderTab({ designSystemId: 'ds-aurora' });
    expect(screen.getByTestId('fantay-project-ds-loading')).toBeInTheDocument();

    const studio = await screen.findByTestId('fantay-project-design-system');
    expect(studio).toHaveTextContent('Aurora');
    expect(studio).toHaveAttribute('data-editable', 'false');
    expect(studio.closest('[data-fx-legacy]')).not.toBeNull();
    expect(mockedFetchDesignSystem).toHaveBeenCalledWith('ds-aurora', null);
    // One header: the title and controls sit in the studio's identity bar, not in a bar above it.
    expect(studio).toHaveAttribute('data-embedded', 'true');
    expect(within(studio).getByTestId('fantay-project-ds-title')).toHaveTextContent('Aurora');
    expect(within(studio).getByTestId('fantay-project-ds-change')).toBeInTheDocument();

    // 更换 marks the current system and switches through ProjectView
    const change = screen.getByTestId('fantay-project-ds-change');
    expect(change).toHaveTextContent('Change');
    fireEvent.keyDown(change, { key: 'Enter' });
    expect(screen.getByTestId('fantay-project-ds-option-ds-aurora')).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(screen.getByTestId('fantay-project-ds-option-ds-mono'));
    expect(onChangeDesignSystem).toHaveBeenCalledWith('ds-mono');

    // A preset has no detail route: it opens in the manager's preset list, focused on itself.
    fireEvent.click(screen.getByTestId('fantay-project-ds-open'));
    expect(mockedNavigate).toHaveBeenCalledWith({ kind: 'home', view: 'design-systems' });
    expect(window.sessionStorage.getItem('od:focus-design-system')).toBe('ds-aurora');
    window.sessionStorage.removeItem('od:focus-design-system');
  });

  it('does not re-run ProjectView for the system already in use', async () => {
    mockedFetchDesignSystem.mockResolvedValue(detail('ds-aurora', 'Aurora'));
    renderTab({ designSystemId: 'ds-aurora' });
    await screen.findByTestId('fantay-project-design-system');
    fireEvent.keyDown(screen.getByTestId('fantay-project-ds-change'), { key: 'Enter' });
    fireEvent.click(screen.getByTestId('fantay-project-ds-option-ds-aurora'));
    expect(onChangeDesignSystem).not.toHaveBeenCalled();
  });

  it('shows the failure with a retry that loads again', async () => {
    mockedFetchDesignSystem.mockResolvedValueOnce(null).mockResolvedValueOnce(detail('ds-aurora', 'Aurora'));
    renderTab({ designSystemId: 'ds-aurora' });
    const error = await screen.findByTestId('fantay-project-ds-error');
    expect(error).toHaveAttribute('role', 'alert');
    expect(error).toHaveTextContent("Couldn't load the design system");

    fireEvent.click(screen.getByTestId('fantay-project-ds-retry'));
    expect(await screen.findByTestId('fantay-project-design-system')).toBeInTheDocument();
    expect(mockedFetchDesignSystem).toHaveBeenCalledTimes(2);
  });

  it('reloads when ProjectView switches the design system', async () => {
    mockedFetchDesignSystem.mockImplementation(async (id: string) => detail(id, id === 'ds-mono' ? 'Mono' : 'Aurora'));
    const view = renderTab({ designSystemId: 'ds-aurora' });
    expect(await screen.findByTestId('fantay-project-design-system')).toHaveTextContent('Aurora');

    view.rerender(
      <>
        <Bridge input={bridgeInput({ designSystemId: 'ds-mono' })} />
        <ProjectDesignSystemTab projectId="project-1" />
      </>,
    );
    await waitFor(() => expect(screen.getByTestId('fantay-project-design-system')).toHaveTextContent('Mono'));
    expect(mockedFetchDesignSystem).toHaveBeenLastCalledWith('ds-mono', null);
  });

  it('speaks zh-CN', () => {
    render(
      <I18nProvider initial="zh-CN">
        <Bridge input={bridgeInput({ designSystemId: null })} />
        <ProjectDesignSystemTab projectId="project-1" />
      </I18nProvider>,
    );
    expect(screen.getByTestId('fantay-project-ds-none')).toHaveTextContent('此项目还没有使用设计系统');
    expect(screen.getByTestId('fantay-project-ds-choose')).toHaveTextContent('选择设计系统');
  });
});
