// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// FileWorkspace in Fantay mode (spec 02 §7.2/§14, plan R7/R8/R10, amendment C2), with FANTAY_BOARD_READY
// mocked true and a ProjectBoard stub: root tabs, 画板 as the default root, 文件 returning to the last
// file tab, the board staying mounted (hidden), open-request routing, `workspace.openEditor`, the
// registry editor in renderFileViewer, the board / editor selection as chat context, and the
// unchanged upstream render with the shell off.
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useState, type ComponentProps } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorkspaceContextItem } from '@open-design/contracts';

import { FileWorkspace } from '../../../src/components/FileWorkspace';
import type { FantayFileEditorContext } from '../../../src/fantay/editors/file-editors';
import { resetEditorContextsForTests, setEditorContext } from '../../../src/fantay/editors/editor-context-store';
import type { FantayBoardHostProps } from '../../../src/fantay/workspace/board-host-contract';
import { resetWorkspaceBusForTests, sendWorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';
import type { OpenTabsState, ProjectFile } from '../../../src/types';

const { flags, board } = vi.hoisted(() => ({
  flags: { boardReady: true },
  board: { renders: [] as unknown[] },
}));

vi.mock('../../../src/fantay/workspace/board-host-contract', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fantay/workspace/board-host-contract')>();
  return {
    ...actual,
    get FANTAY_BOARD_READY() {
      return flags.boardReady;
    },
  };
});

vi.mock('../../../src/fantay/board/ProjectBoard', () => ({
  ProjectBoard: (props: FantayBoardHostProps) => {
    board.renders.push(props);
    return (
      <div
        data-testid="board-stub"
        data-active={String(props.active)}
        data-open-request={props.openRequest?.name ?? ''}
      />
    );
  },
}));

vi.mock('../../../src/fantay/editors/file-editors', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/fantay/editors/file-editors')>();
  return {
    ...actual,
    renderFantayFileEditor: vi.fn((context: FantayFileEditorContext) =>
      context.file.name === 'movie-studio.json' ? (
        <div
          data-testid="motion-editor-stub"
          data-active={String(context.active)}
          data-run-in-flight={String(context.runInFlight)}
          data-viewer-only={String(context.viewerOnly)}
          data-project={context.projectId}
        />
      ) : null,
    ),
  };
});

vi.mock('../../../src/components/share/TokenToSeaSharePanel', () => ({
  TokenToSeaSharePanel: ({ fileName }: { fileName: string }) => <div data-testid="share-panel-stub">{fileName}</div>,
}));

vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  fetchProjectFileText: vi.fn().mockResolvedValue(''),
  uploadProjectFiles: vi.fn(),
  writeProjectBase64File: vi.fn(),
  writeProjectTextFile: vi.fn(),
  fetchProjectFolders: vi.fn().mockResolvedValue([]),
  fetchDesignSystem: vi.fn().mockResolvedValue(null),
}));

vi.mock('../../../src/components/workspace/TerminalViewer', () => ({
  TerminalViewer: ({ terminalId }: { terminalId: string }) => <div data-testid="terminal-viewer">{terminalId}</div>,
}));

function file(name: string, kind: ProjectFile['kind'], mime: string, mtime: number): ProjectFile {
  return { name, path: name, type: 'file', size: 64, mtime, kind, mime };
}

const FILES: ProjectFile[] = [
  file('index.html', 'html', 'text/html', 1),
  file('pricing.html', 'html', 'text/html', 5),
  file('notes.md', 'text', 'text/markdown', 2),
  file('hero.png', 'image', 'image/png', 3),
  file('movie-studio.json', 'text', 'application/json', 4),
];
/** `movie-studio.json` makes a project a motion project, whose third root is 动画风格 (motion styles). */
const STATIC_FILES = FILES.filter((entry) => entry.name !== 'movie-studio.json');

type HostProps = Partial<ComponentProps<typeof FileWorkspace>> & {
  initialTabs?: OpenTabsState;
  onTabs?: (next: OpenTabsState) => void;
};

const onRefreshFiles = vi.fn();

/** ProjectView-like owner: tab state round-trips through onTabsStateChange. */
function Host({ initialTabs, onTabs, ...props }: HostProps) {
  const [tabsState, setTabsState] = useState<OpenTabsState>(initialTabs ?? { tabs: [], active: null });
  return (
    <FileWorkspace
      projectId="project-1"
      projectKind="prototype"
      projectName="Landing"
      resolvedDir="/work/landing"
      files={FILES}
      liveArtifacts={[]}
      onRefreshFiles={onRefreshFiles}
      isDeck={false}
      tabsState={tabsState}
      onTabsStateChange={(next) => {
        onTabs?.(next);
        setTabsState(next);
      }}
      {...props}
    />
  );
}

function lastBoard(): FantayBoardHostProps {
  const props = board.renders[board.renders.length - 1];
  if (!props) throw new Error('the board never rendered');
  return props as FantayBoardHostProps;
}

function rootTab(name: 'Board' | 'Files' | 'Design system'): HTMLElement {
  return screen.getByRole('tab', { name });
}

function openTool(id: string) {
  fireEvent.click(screen.getByTestId('workspace-add-tab'));
  fireEvent.click(screen.getByTestId(`workspace-tool-${id}`));
}

function designFilesPanel(): Element | null {
  return document.querySelector('.ws-body .df-panel');
}

beforeEach(() => {
  window.localStorage.clear();
  vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
  flags.boardReady = true;
  board.renders.length = 0;
  resetWorkspaceBusForTests();
  resetEditorContextsForTests();
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  resetWorkspaceBusForTests();
  resetEditorContextsForTests();
});

describe('FileWorkspace — Fantay workspace', () => {
  it('opens the board from its tool card on a new tab without adding permanent tool icons', async () => {
    render(<Host files={STATIC_FILES} initialTabs={{ tabs: [], active: '__workspace_start__' }} />);
    expect(screen.getByTestId('workspace-start-tab')).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByRole('tab', { name: 'Board' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Design system' })).toBeNull();
    fireEvent.click(screen.getByTestId('workspace-tool-board'));
    expect(rootTab('Board')).toHaveAttribute('aria-selected', 'true');
    expect(await screen.findByTestId('board-stub')).toHaveAttribute('data-active', 'true');
    expect(designFilesPanel()).toBeNull();
    // R8: the body chain renders nothing next to the active board (no "open from Design Files" hint)
    expect(document.querySelector('.ws-body > .viewer-empty')).toBeNull();

    const shell = document.querySelector('.ws-tabs-shell') as HTMLElement;
    expect(shell).toHaveAttribute('data-workspace-root', 'board');
    expect(rootTab('Board').closest('.ws-tabs-bar')).not.toBeNull();
    expect(screen.getByTestId('fantay-board-header-slot').closest('.ws-board-toolbar')).not.toBeNull();
    const actions = shell.querySelector('.ws-tabs-actions') as HTMLElement;
    expect(actions.lastElementChild).toHaveAttribute('data-testid', 'fantay-board-header-actions');
    expect(within(actions).getByTestId('fantay-board-zoom')).toBeInTheDocument();
    expect(within(actions).getByTestId('fantay-board-share')).toHaveAttribute('data-share-target', 'index.html');

    // the board lives inside .ws-body next to the upstream panels
    expect(document.querySelector('.ws-body > [data-testid="fantay-board-layer"]')).not.toBeNull();
  });

  it('fills the board host contract from FileWorkspace (R8: deck, focus, materialization, files)', async () => {
    const initialTabs = { tabs: [], active: '__board__' };
    const view = render(<Host initialTabs={initialTabs} isDeck filesAuthoritative={false} materializationPending runInFlight />);
    await screen.findByTestId('board-stub');
    expect(lastBoard()).toMatchObject({
      projectId: 'project-1',
      projectName: 'Landing',
      resolvedDir: '/work/landing',
      viewerOnly: false,
      active: false,
      isDeckProject: true,
      focusRequest: null,
      openRequest: null,
      filesAuthoritative: false,
      initialMaterializationPending: true,
      runInFlight: true,
      activeConversationId: null,
    });
    expect(lastBoard().files.map((entry) => entry.name)).toEqual(FILES.map((entry) => entry.name));
    // while the first materialization is pending the upstream placeholder shows and the board hides
    expect(designFilesPanel()).not.toBeNull();
    expect(screen.getByTestId('fantay-board-layer')).toHaveStyle({ display: 'none' });

    view.rerender(<Host initialTabs={initialTabs} isDeck filesAuthoritative materializationPending={false} runInFlight />);
    await waitFor(() => expect(lastBoard()).toMatchObject({ active: true, initialMaterializationPending: false, filesAuthoritative: true }));
    expect(designFilesPanel()).toBeNull();
  });

  it('opens Files as its own tab and keeps the board mounted but hidden', async () => {
    const onTabs = vi.fn();
    render(<Host initialTabs={{ tabs: ['notes.md'], active: 'notes.md' }} onTabs={onTabs} />);
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
    expect(screen.queryByTestId('fantay-board-layer')).toBeNull();

    openTool('board');
    expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: expect.arrayContaining(['notes.md', '__board__']), active: '__board__' }));
    expect(await screen.findByTestId('board-stub')).toHaveAttribute('data-active', 'true');
    expect(rootTab('Board')).toHaveAttribute('aria-selected', 'true');

    openTool('files');
    expect(rootTab('Files')).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(screen.getByRole('tab', { name: 'notes.md' }));
    expect(screen.getByRole('tab', { name: 'notes.md' })).toHaveAttribute('aria-selected', 'true');
    const layer = screen.getByTestId('fantay-board-layer');
    expect(layer).toHaveStyle({ display: 'none' });
    expect(screen.getByTestId('board-stub')).toHaveAttribute('data-active', 'false');
    expect(screen.queryByTestId('fantay-board-zoom')).toBeNull();
  });

  it('opens the existing browser from the tools menu and keeps it in the board tab strip', async () => {
    render(<Host files={STATIC_FILES} />);
    openTool('board');
    const board = await screen.findByTestId('board-stub');

    openTool('browser');
    const browserTab = screen.getByRole('tab', { name: 'Browser' });
    expect(browserTab).toHaveAttribute('aria-selected', 'true');
    expect(browserTab.closest('[role=tablist]')).toBe(rootTab('Board').closest('[role=tablist]'));
    expect(await screen.findByRole('heading', { name: 'Reference Board' })).toBeInTheDocument();

    fireEvent.click(rootTab('Board'));
    expect(rootTab('Board')).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByTestId('board-stub')).toBe(board);
    expect(browserTab).toHaveAttribute('aria-selected', 'false');
    fireEvent.click(browserTab);
    expect(browserTab).toHaveAttribute('aria-selected', 'true');
    fireEvent.click(within(rootTab('Board')).getByRole('button', { name: 'Close tab' }));
    expect(screen.queryByRole('tab', { name: 'Board' })).toBeNull();
    expect(browserTab).toHaveAttribute('aria-selected', 'true');
    openTool('board');
    expect(screen.getByTestId('board-stub')).toBe(board);
  });

  it('sends open requests to the board while it is active, not to a new tab', async () => {
    const onTabs = vi.fn();
    const view = render(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');

    view.rerender(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} openRequest={{ name: 'hero.png', nonce: 1 }} />);
    await waitFor(() => expect(screen.getByTestId('board-stub')).toHaveAttribute('data-open-request', 'hero.png'));
    expect(onTabs).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-stub')).toHaveAttribute('data-active', 'true');

    view.rerender(
      <Host
        initialTabs={{ tabs: [], active: '__board__' }}
        onTabs={onTabs}
        openRequest={{ name: 'notes.md', nonce: 2, openBatch: ['hero.png', 'notes.md'] }}
      />,
    );
    await waitFor(() => expect(lastBoard().openRequest).toMatchObject({ name: 'notes.md', openBatch: ['hero.png', 'notes.md'] }));
    expect(onTabs).not.toHaveBeenCalled();
  });

  it('opens a tab for an explicit deep link even while the board is active', async () => {
    const onTabs = vi.fn();
    const view = render(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');

    view.rerender(
      <Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} routeFileName="hero.png" openRequest={{ name: 'hero.png', nonce: 1 }} />,
    );
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: ['hero.png'], active: 'hero.png' })));
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
    expect(screen.getByTestId('board-stub')).toHaveAttribute('data-active', 'false');
    expect(lastBoard().openRequest).toBeNull();
  });

  it('opens terminals and side chats as tabs while the board is active', async () => {
    const onTabs = vi.fn();
    const view = render(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');

    view.rerender(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} openRequest={{ name: 'terminal:t1', nonce: 1 }} />);
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'terminal:t1' })));
    expect(lastBoard().openRequest).toBeNull();

    view.rerender(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} openRequest={{ name: 'chat:c1', nonce: 2 }} />);
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'chat:c1' })));
    expect(lastBoard().openRequest).toBeNull();
  });

  it('selects 画板 for an open request that names the board root', async () => {
    const onTabs = vi.fn();
    const view = render(<Host initialTabs={{ tabs: ['notes.md'], active: 'notes.md' }} onTabs={onTabs} />);
    view.rerender(<Host initialTabs={{ tabs: ['notes.md'], active: 'notes.md' }} onTabs={onTabs} openRequest={{ name: '__board__', nonce: 1 }} />);
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: ['notes.md', '__board__'], active: '__board__' })));
    expect(await screen.findByTestId('board-stub')).toHaveAttribute('data-active', 'true');
  });

  it('opens workspace.openEditor files as 文件 tabs, never as a board focus', async () => {
    const onTabs = vi.fn();
    render(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');

    let handled = false;
    act(() => {
      // a design document the editor just created: not in the file list yet
      handled = sendWorkspaceCommand({ type: 'workspace.openEditor', projectId: 'project-1', fileName: 'designs/home.fig' });
    });
    expect(handled).toBe(true);
    expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: ['designs/home.fig'], active: 'designs/home.fig' }));
    expect(screen.queryByRole('tab', { name: 'Files' })).toBeNull();
    expect(lastBoard().openRequest).toBeNull();

    expect(sendWorkspaceCommand({ type: 'workspace.openEditor', projectId: 'project-2', fileName: 'other.fig' })).toBe(false);
  });

  it('renders the registry editor for its files through renderFileViewer (R10)', async () => {
    render(<Host initialTabs={{ tabs: ['movie-studio.json'], active: 'movie-studio.json' }} runInFlight viewerOnly />);
    const editor = await screen.findByTestId('motion-editor-stub');
    expect(editor).toHaveAttribute('data-active', 'true');
    expect(editor).toHaveAttribute('data-run-in-flight', 'true');
    expect(editor).toHaveAttribute('data-viewer-only', 'true');
    expect(editor).toHaveAttribute('data-project', 'project-1');
  });

  it('forwards the board selection and editor selections as the active chat context (C2)', async () => {
    const onActiveContextChange = vi.fn();
    render(<Host initialTabs={{ tabs: ['notes.md'], active: '__board__' }} onActiveContextChange={onActiveContextChange} />);
    await screen.findByTestId('board-stub');
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);

    const selection: WorkspaceContextItem = { id: 'board-selection:n1', kind: 'board-selection', label: 'Hero', tabId: '__board__' };
    act(() => lastBoard().onActiveContextChange(selection));
    expect(onActiveContextChange).toHaveBeenLastCalledWith(selection);

    // 文件 with no files-root tab visited yet lands on Design Files: FileWorkspace's own item again
    openTool('files');
    await waitFor(() =>
      expect(onActiveContextChange).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'design-files' })),
    );
    const tabStrip = document.querySelector('.ws-tabs-bar') as HTMLElement;
    fireEvent.click(within(tabStrip).getByText('notes.md').closest('[role="tab"]') as HTMLElement);
    await waitFor(() =>
      expect(onActiveContextChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'file:notes.md', kind: 'file' })),
    );

    const editorSelection: WorkspaceContextItem = {
      id: 'design-selection:frame-1',
      kind: 'file',
      label: 'Frame 1',
      tabId: 'notes.md',
      path: 'notes.md',
      title: 'Frame 1 · Hero',
    };
    act(() => setEditorContext('project-1', 'notes.md', editorSelection));
    expect(onActiveContextChange).toHaveBeenLastCalledWith(editorSelection);

    // another file's editor context never leaks into the active tab
    act(() => setEditorContext('project-1', 'designs/other.fig', { id: 'x', kind: 'file', label: 'X' }));
    expect(onActiveContextChange).toHaveBeenLastCalledWith(editorSelection);

    act(() => setEditorContext('project-1', 'notes.md', null));
    expect(onActiveContextChange).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'file:notes.md' }));
  });

  it('names the third root after motion styles in a motion project', () => {
    render(<Host initialTabs={{ tabs: [], active: '__workspace_start__' }} />);
    expect(screen.getByTestId('workspace-tool-design-system')).toHaveTextContent('Animation styles');
  });

  it('shows the project design-system tab on the 设计系统 root', async () => {
    const onTabs = vi.fn();
    render(<Host files={STATIC_FILES} initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');
    openTool('design-system');
    expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ active: '__project_design_system__' }));
    expect(screen.getByTestId('fantay-project-design-system-tab')).toBeInTheDocument();
    expect(designFilesPanel()).toBeNull();
    expect(screen.getByTestId('board-stub')).toHaveAttribute('data-active', 'false');
  });

  it('lets the board open a file it cannot place (persisted even before the list has it)', async () => {
    const onTabs = vi.fn();
    render(<Host initialTabs={{ tabs: [], active: '__board__' }} onTabs={onTabs} />);
    await screen.findByTestId('board-stub');
    act(() => lastBoard().onOpenFile('exports/late.png'));
    expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: ['exports/late.png'], active: 'exports/late.png' }));
  });

  it('disables Share with the read-only reason for viewer-only collaborators', async () => {
    render(<Host viewerOnly streaming initialTabs={{ tabs: [], active: '__board__' }} />);
    await screen.findByTestId('board-stub');
    const share = screen.getByTestId('fantay-board-share');
    expect(share).toHaveAttribute('aria-disabled', 'true');
    act(() => share.focus());
    expect((await screen.findByRole('tooltip')).textContent).toContain("Read-only projects can't be shared");
  });

  it('handles workspace.view bus commands and resets board state when projectId changes', async () => {
    const onActiveContextChange = vi.fn();
    const view = render(
      <Host
        initialTabs={{ tabs: ['notes.md'], active: '__board__' }}
        openRequest={{ name: 'hero.png', nonce: 1 }}
        onActiveContextChange={onActiveContextChange}
      />,
    );
    await screen.findByTestId('board-stub');
    expect(lastBoard().openRequest).toMatchObject({ name: 'hero.png' });

    act(() => {
      expect(sendWorkspaceCommand({ type: 'workspace.view', projectId: 'project-1', view: 'files' })).toBe(true);
    });
    expect(rootTab('Files')).toHaveAttribute('aria-selected', 'true');

    act(() => {
      expect(sendWorkspaceCommand({ type: 'workspace.view', projectId: 'project-1', view: 'board', focus: { kind: 'motion' } })).toBe(true);
    });
    expect(await screen.findByTestId('board-stub')).toHaveAttribute('data-active', 'true');
    expect(lastBoard().focusRequest).toMatchObject({ kind: 'motion' });

    act(() => lastBoard().onActiveContextChange({ id: 'board-selection:n1', kind: 'board-selection', label: 'Hero', tabId: '__board__' }));
    view.rerender(
      <Host
        projectId="project-2"
        openRequest={null}
        onActiveContextChange={onActiveContextChange}
      />,
    );
    await waitFor(() => expect(lastBoard().projectId).toBe('project-2'));
    expect(lastBoard().focusRequest).toBeNull();
    expect(lastBoard().openRequest).toBeNull();
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);
  });

  it('disables Share without HTML pages and closes the Share popover if pages disappear', async () => {
    const view = render(<Host files={STATIC_FILES} initialTabs={{ tabs: [], active: '__board__' }} />);
    await screen.findByTestId('board-stub');
    fireEvent.click(screen.getByTestId('fantay-board-share'));
    expect(await screen.findByTestId('share-panel-stub')).toBeInTheDocument();

    view.rerender(<Host files={[file('notes.md', 'text', 'text/markdown', 2)]} initialTabs={{ tabs: [], active: '__board__' }} />);
    await waitFor(() => expect(screen.queryByTestId('share-panel-stub')).toBeNull());
    expect(screen.getByTestId('fantay-board-share')).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('FileWorkspace — board not ready', () => {
  beforeEach(() => {
    flags.boardReady = false;
  });

  it('keeps Design Files as the default, hides 画板 and resets a persisted board tab', async () => {
    const onTabs = vi.fn();
    render(<Host initialTabs={{ tabs: ['notes.md'], active: '__board__' }} onTabs={onTabs} />);
    expect(screen.queryByRole('tab', { name: 'Board' })).toBeNull();
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'notes.md' })));
    expect(screen.queryByTestId('fantay-board-layer')).toBeNull();
  });
});

describe('FileWorkspace — shell off', () => {
  beforeEach(() => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '0');
  });

  it('renders the upstream workspace without root tabs, board or board header', () => {
    render(<Host />);
    expect(screen.queryByTestId('fantay-workspace-root-tabs')).toBeNull();
    expect(screen.queryByTestId('fantay-board-layer')).toBeNull();
    expect(screen.queryByTestId('fantay-board-zoom')).toBeNull();
    expect(screen.getByTestId('design-files-tab')).toHaveAttribute('aria-selected', 'true');
    expect(designFilesPanel()).not.toBeNull();
    const shell = document.querySelector('.ws-tabs-shell') as HTMLElement;
    expect(shell.firstElementChild).toHaveClass('ws-tabs-bar');
  });

  it('resets a persisted board tab and keeps upstream open-request handling', async () => {
    const onTabs = vi.fn();
    const view = render(<Host initialTabs={{ tabs: ['notes.md'], active: '__board__' }} onTabs={onTabs} />);
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ active: 'notes.md' })));

    view.rerender(<Host initialTabs={{ tabs: ['notes.md'], active: '__board__' }} onTabs={onTabs} openRequest={{ name: 'hero.png', nonce: 1 }} />);
    await waitFor(() => expect(onTabs).toHaveBeenLastCalledWith(expect.objectContaining({ tabs: ['notes.md', 'hero.png'], active: 'hero.png' })));
    expect(sendWorkspaceCommand({ type: 'workspace.openEditor', projectId: 'project-1', fileName: 'movie-studio.json' })).toBe(false);
  });
});
