// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardDocument } from '@open-design/contracts';

import { I18nProvider } from '../../../src/i18n';
import { ProjectBoard } from '../../../src/fantay/board/ProjectBoard';
import type { FantayBoardHostProps } from '../../../src/fantay/workspace/board-host-contract';
import { resetWorkspaceBusForTests, sendWorkspaceCommand } from '../../../src/fantay/workspace/workspace-bus';
import { resetMaterialsDrawerForTests } from '../../../src/fantay/materials/materials-drawer-store';
import { resetMotionCreateForTests } from '../../../src/fantay/motion/motion-create-store';
import { resetFantayProjectBridgeForTests } from '../../../src/fantay/shell/project-bridge';
import { installStageSize } from './chrome-fixtures';
import { makeBoard } from './engine-fixtures';

let restoreStageSize: (() => void) | null = null;

function createBoardFetchMock(initialBoard: BoardDocument) {
  let current = initialBoard;
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.includes('/api/projects/p-1/board') && method === 'GET') {
      return new Response(JSON.stringify({ board: current }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.includes('/api/projects/p-1/board/sync') && method === 'POST') {
      return new Response(
        JSON.stringify({ revision: current.revision, changed: false, changes: null, placements: [], focus: null, unplaceable: [] }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (url.includes('/api/projects/p-1/board/viewport') && method === 'PUT') {
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (url.includes('/api/projects/p-1/board') && method === 'PATCH') {
      return new Response(
        JSON.stringify({
          revision: current.revision + 1,
          updatedAt: Date.now(),
          results: [],
          changes: {
            fromRevision: current.revision,
            toRevision: current.revision + 1,
            upsertNodes: [],
            removeNodeIds: [],
            upsertEdges: [],
            removeEdgeIds: [],
          },
          inverse: [],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(JSON.stringify({ tasks: [], files: [], models: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, setBoard: (next: BoardDocument) => { current = next; } };
}

function makeHostProps(overrides: Partial<FantayBoardHostProps> = {}): FantayBoardHostProps {
  return {
    projectId: 'p-1',
    projectName: 'Demo Project',
    resolvedDir: '/tmp/p-1',
    viewerOnly: false,
    active: true,
    files: [
      { name: 'index.html', size: 1200, mtime: 1000, kind: 'html', mime: 'text/html' },
      { name: 'designs/hero.fig', size: 2400, mtime: 2000, kind: 'binary', mime: 'application/octet-stream' },
    ],
    filesRefreshKey: 1,
    filesGeneration: 1,
    liveArtifacts: [],
    browserTabs: [],
    messages: [],
    conversations: [],
    activeConversationId: null,
    previewComments: [],
    streaming: false,
    runInFlight: false,
    runStartedAt: null,
    runSteps: [],
    openRequest: null,
    isDeckProject: false,
    focusRequest: null,
    filesAuthoritative: true,
    initialMaterializationPending: false,
    onOpenFile: vi.fn(),
    onOpenBrowserTab: vi.fn(),
    onRefreshFiles: vi.fn(),
    onUploadFiles: vi.fn(async () => {}),
    onActiveContextChange: vi.fn(),
    onShareTargetChange: vi.fn(),
    renderFileViewer: () => null,
    ...overrides,
  };
}

beforeEach(() => {
  restoreStageSize = installStageSize();
});

afterEach(() => {
  cleanup();
  restoreStageSize?.();
  restoreStageSize = null;
  resetWorkspaceBusForTests();
  resetMaterialsDrawerForTests();
  resetMotionCreateForTests();
  resetFantayProjectBridgeForTests();
  vi.unstubAllGlobals();
});

describe('ProjectBoard (W3-board-assembly)', () => {
  it('mounts BoardDataProvider, GenerationProvider and BoardView and handles board.insert commands', async () => {
    const board = makeBoard([
      { id: 'n_frame_home', kind: 'frame', x: 100, y: 100, w: 1440, h: 900, ref: { path: 'index.html' }, device: 'desktop' },
    ], [], 'p-1');
    createBoardFetchMock(board);
    const props = makeHostProps();

    render(
      <I18nProvider initial="zh-CN">
        <ProjectBoard {...props} />
      </I18nProvider>,
    );

    expect(screen.getByTestId('board-root')).toBeInTheDocument();

    await waitFor(() => {
      const handled = sendWorkspaceCommand({
        type: 'board.insert',
        projectId: 'p-1',
        drafts: [{ kind: 'note', text: 'Inserted from bus', title: 'Note 1' }],
      });
      expect(handled).toBe(true);
    });
  });

  it('acks fantay:open-design-editor events via the mounted DesignEditorEventBridge', async () => {
    createBoardFetchMock(makeBoard([], [], 'p-1'));
    const props = makeHostProps({ viewerOnly: true });

    render(
      <I18nProvider initial="zh-CN">
        <ProjectBoard {...props} />
      </I18nProvider>,
    );

    const ack = vi.fn();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('fantay:open-design-editor', {
          detail: {
            projectId: 'p-1',
            request: { kind: 'new-from-image', image: { path: 'assets/pic.png' } },
            ack,
          },
        }),
      );
    });

    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('prevents board inserts and design editor mutations while viewerOnly or initialMaterializationPending is active', async () => {
    const board = makeBoard(
      [
        { id: 'n_frame_home', kind: 'frame', x: 100, y: 100, w: 1440, h: 900, ref: { path: 'index.html' }, device: 'desktop' },
      ],
      [],
      'p-1',
    );
    const { fetchMock } = createBoardFetchMock(board);
    const props = makeHostProps({ initialMaterializationPending: true });

    render(
      <I18nProvider initial="zh-CN">
        <ProjectBoard {...props} />
      </I18nProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId('board-root')).toBeInTheDocument();
    });

    const handled = sendWorkspaceCommand({
      type: 'board.insert',
      projectId: 'p-1',
      drafts: [{ kind: 'note', text: 'Blocked during pending materialization', title: 'Blocked' }],
    });
    expect(handled).toBe(false);

    const ack = vi.fn();
    act(() => {
      window.dispatchEvent(
        new CustomEvent('fantay:open-design-editor', {
          detail: {
            projectId: 'p-1',
            request: { kind: 'new-from-image', image: { path: 'assets/pic.png' } },
            ack,
          },
        }),
      );
    });
    expect(ack).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));

    const patchCalls = fetchMock.mock.calls.filter(([, init]) => (init?.method ?? 'GET').toUpperCase() === 'PATCH');
    expect(patchCalls).toHaveLength(0);
  });
});
