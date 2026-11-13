// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBoardOps,
  emptyBoardDocument,
  type BoardDocument,
  type BoardOp,
  type BoardSyncRequest,
  type BoardSyncResponse,
  type ChatMessage,
  type ProjectFile,
  type ProjectMediaTasksResponse,
} from '@open-design/contracts';

vi.mock('../../../src/providers/registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/providers/registry')>()),
  fetchProjectMediaTasks: vi.fn(),
}));

import { fetchProjectMediaTasks } from '../../../src/providers/registry';
import {
  BoardDataProvider,
  useBoardData,
  useBoardState,
} from '../../../src/fantay/board/data/BoardDataProvider';
import { publishBoardProjectEvent, resetBoardProjectEventsForTests } from '../../../src/fantay/board/data/board-events';
import type {
  BoardDataStore,
  BoardDataValue,
  BoardFocusIntent,
  BoardHostBindings,
  BoardStoreState,
} from '../../../src/fantay/board/data/types';
import { boardClientId, resetBoardClientIdForTests } from '../../../src/fantay/board/data/client-id';
import { classifyOpenRequestNames, resolveBoardNodesForNames } from '../../../src/fantay/board/sync/focus';
import { useBoardChatSync } from '../../../src/fantay/board/sync/use-board-chat-sync';
import { useBoardSelectionContextSync } from '../../../src/fantay/board/sync/use-board-selection-context';

const mediaTasks = vi.mocked(fetchProjectMediaTasks);

const EMPTY_SYNC: BoardSyncResponse = { revision: 1, changed: false, changes: null, placements: [], focus: null, unplaceable: [] };

function boardFrom(ops: BoardOp[]): BoardDocument {
  const outcome = applyBoardOps({ settings: { background: 'dots', autoPlace: true }, nodes: [], edges: [] }, ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'user' },
    now: 1,
    newId: (prefix) => `${prefix}_auto`,
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(JSON.stringify(outcome));
  return { ...emptyBoardDocument('p1'), ...outcome.content, revision: 1 };
}

const BOARD = boardFrom([
  { op: 'add', node: { id: 'n_index', kind: 'frame', ref: { path: 'index.html' } } },
  { op: 'add', node: { id: 'n_hero', kind: 'image', ref: { path: 'hero.png' }, x: 2000, y: 0 } },
]);

function fakeStore(initial: Partial<BoardStoreState> = {}) {
  let state: BoardStoreState = {
    status: 'idle',
    board: null,
    serverRevision: 0,
    initialViewport: null,
    pages: [{ id: 'page_1', title: 'Page 1' }],
    activePageId: 'page_1',
    pendingOps: 0,
    lastError: null,
    canUndo: false,
    canRedo: false,
    ...initial,
  };
  const listeners = new Set<() => void>();
  const responses: Array<BoardSyncResponse | null> = [];
  const store = {
    getState: () => state,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    load: vi.fn(async () => {}),
    apply: vi.fn(async () => ({ ok: true })),
    sync: vi.fn(async (_request: BoardSyncRequest) => (responses.length > 0 ? responses.shift()! : EMPTY_SYNC)),
    setViewport: vi.fn(),
    undo: vi.fn(async () => false),
    redo: vi.fn(async () => false),
    handleBusEvent: vi.fn(),
    pageViewport: () => null,
    setActivePage: vi.fn(),
    dispose: vi.fn(),
  } satisfies BoardDataStore;
  return {
    store,
    responses,
    setState(patch: Partial<BoardStoreState>) {
      state = { ...state, ...patch };
      for (const listener of [...listeners]) listener();
    },
  };
}

function hostOf(overrides: Partial<BoardHostBindings> = {}): BoardHostBindings {
  return {
    projectId: 'p1',
    projectDir: '/work/p1',
    active: true,
    readOnly: false,
    files: [],
    filesGeneration: 0,
    liveArtifacts: [],
    messages: [],
    activeConversationId: 'c1',
    runInFlight: false,
    openRequest: null,
    onActiveContextChange: vi.fn(),
    onUnplaceableOpenRequest: vi.fn(),
    ...overrides,
  };
}

function assistant(id: string, files: string[] = [], runId = `run-${id}`): ChatMessage {
  return {
    id,
    role: 'assistant',
    content: '',
    runId,
    producedFiles: files.map((name) => ({ name, size: 1, mtime: 1, kind: 'html', mime: 'text/html' }) as unknown as ProjectFile),
  } as ChatMessage;
}

function Harness(props: {
  store: BoardDataStore;
  host: BoardHostBindings;
  idleMs?: number;
  emitFocus: (intent: Omit<BoardFocusIntent, 'nonce'>) => void;
}) {
  useBoardChatSync({
    store: props.store,
    host: props.host,
    cameraIdleMs: () => props.idleMs ?? Number.POSITIVE_INFINITY,
    emitFocus: props.emitFocus,
  });
  return null;
}

async function flush(ms = 0): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mediaTasks.mockReset();
  mediaTasks.mockResolvedValue({ tasks: [] } satisfies ProjectMediaTasksResponse);
});

afterEach(() => {
  cleanup();
  resetBoardProjectEventsForTests();
  vi.useRealTimers();
});

describe('open-request classification and node lookup', () => {
  it('classifies live artifacts and board kinds as placeable; folders, docs and hidden paths open as tabs', () => {
    const files = [{ name: 'assets', type: 'dir' } as unknown as ProjectFile];
    expect(classifyOpenRequestNames(
      ['index.html', 'live:abc', 'README.md', 'assets', 'movie-studio.json', '.od/x.html', 'designs/a.fig', 'index.html', ''],
      files,
      [],
    )).toEqual({
      placeable: ['index.html', 'live:abc', 'movie-studio.json', 'designs/a.fig'],
      unplaceable: ['README.md', 'assets', '.od/x.html'],
    });
  });

  it('resolves names to visible nodes, including live frames and the project movie', () => {
    const board = boardFrom([
      { op: 'add', node: { id: 'n_a', kind: 'frame', ref: { path: 'a.html' } } },
      { op: 'add', node: { id: 'n_live', kind: 'frame', ref: null, liveArtifactId: 'abc', x: 2000, y: 0 } },
      { op: 'add', node: { id: 'n_movie', kind: 'motion', source: { type: 'movie', projectId: 'p1' }, x: 4000, y: 0 } },
      { op: 'add', node: { id: 'n_hidden', kind: 'image', ref: { path: 'b.png' }, hidden: true, x: 6000, y: 0 } },
    ]);
    expect(resolveBoardNodesForNames(board, ['movie-studio.json', 'live:abc', 'a.html', 'b.png', 'missing.html']))
      .toEqual(['n_movie', 'n_live', 'n_a']);
  });
});

describe('boardClientId', () => {
  afterEach(() => {
    window.sessionStorage.clear();
    resetBoardClientIdForTests();
  });

  it('keeps one id per tab in sessionStorage and falls back to a per-page id', () => {
    const id = boardClientId();
    expect(id).toMatch(/^bc_[0-9a-f]{24}$/);
    expect(window.sessionStorage.getItem('fantay.board.clientId')).toBe(id);
    expect(boardClientId()).toBe(id);
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(boardClientId()).toBe(id);
    getItem.mockRestore();
  });
});

describe('useBoardChatSync triggers (spec 04 §7.4)', () => {
  it('syncs once with reason open when the store becomes ready', async () => {
    const fake = fakeStore();
    const emitFocus = vi.fn();
    const view = render(<Harness store={fake.store} host={hostOf()} emitFocus={emitFocus} />);
    await flush();
    expect(fake.store.sync).not.toHaveBeenCalled();
    act(() => fake.setState({ status: 'ready', board: BOARD }));
    await flush();
    expect(fake.store.sync).toHaveBeenCalledTimes(1);
    expect(fake.store.sync).toHaveBeenLastCalledWith({ conversationId: 'c1', reason: 'open' });
    act(() => fake.setState({ status: 'ready', serverRevision: 5 }));
    view.rerender(<Harness store={fake.store} host={hostOf()} emitFocus={emitFocus} />);
    await flush();
    expect(fake.store.sync).toHaveBeenCalledTimes(1);
  });

  it('sends run-started and run-finished with the turn hint and focuses created placements', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const emitFocus = vi.fn();
    const messages = [assistant('m1')];
    const view = render(<Harness store={fake.store} host={hostOf({ messages })} emitFocus={emitFocus} />);
    await flush();
    fake.store.sync.mockClear();

    view.rerender(<Harness store={fake.store} host={hostOf({ messages, runInFlight: true })} emitFocus={emitFocus} />);
    await flush();
    expect(fake.store.sync).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      reason: 'run-started',
      turn: { conversationId: 'c1', messageId: 'm1', runId: 'run-m1', status: 'running' },
    });

    fake.responses.push({
      ...EMPTY_SYNC,
      changed: true,
      placements: [
        { nodeId: 'n_new1', status: 'created', path: 'a.html' },
        { nodeId: 'n_old', status: 'existing', path: 'b.html' },
        { nodeId: 'n_new2', status: 'created', path: 'c.png' },
      ],
    });
    const done = [assistant('m1', ['a.html', 'c.png'])];
    view.rerender(<Harness store={fake.store} host={hostOf({ messages: done, runInFlight: false })} emitFocus={emitFocus} idleMs={5000} />);
    await flush();
    expect(fake.store.sync).toHaveBeenLastCalledWith({
      conversationId: 'c1',
      reason: 'run-finished',
      turn: { conversationId: 'c1', messageId: 'm1', runId: 'run-m1', status: 'terminal', paths: ['a.html', 'c.png'] },
    });
    expect(emitFocus).toHaveBeenCalledWith({
      nodeIds: ['n_new1', 'n_new2'],
      primaryNodeId: 'n_new1',
      behavior: 'fly-to',
      source: 'run-finished',
    });
    expect(fake.store.sync).toHaveBeenCalledTimes(2);
  });

  it('treats a produced-files change while idle as run-finished and reveals instead of flying while the user moves', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const emitFocus = vi.fn();
    const view = render(<Harness store={fake.store} host={hostOf({ messages: [assistant('m1', ['a.html'])] })} emitFocus={emitFocus} />);
    await flush();
    fake.store.sync.mockClear();
    fake.responses.push({ ...EMPTY_SYNC, placements: [{ nodeId: 'n_x', status: 'created' }] });
    view.rerender(
      <Harness store={fake.store} host={hostOf({ messages: [assistant('m1', ['a.html', 'b.html'])] })} emitFocus={emitFocus} idleMs={500} />,
    );
    await flush();
    expect(fake.store.sync).toHaveBeenCalledTimes(1);
    expect(fake.store.sync.mock.calls[0]![0]).toMatchObject({ reason: 'run-finished', turn: { paths: ['a.html', 'b.html'] } });
    expect(emitFocus).toHaveBeenCalledWith(expect.objectContaining({ behavior: 'reveal-pill', nodeIds: ['n_x'] }));
  });

  it('records a new baseline instead of triggering when the project changes', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const view = render(
      <Harness store={fake.store} host={hostOf({ runInFlight: true, filesGeneration: 4, messages: [assistant('m1', ['a.html'])] })} emitFocus={vi.fn()} />,
    );
    await flush();
    fake.store.sync.mockClear();
    view.rerender(<Harness store={fake.store} host={hostOf({ projectId: 'p2', runInFlight: false, filesGeneration: 9 })} emitFocus={vi.fn()} />);
    await flush(2000);
    expect(fake.store.sync.mock.calls.map(([request]) => request.reason)).not.toContain('run-finished');
    expect(fake.store.sync.mock.calls.map(([request]) => request.reason)).not.toContain('files-changed');
  });

  it('routes open requests: unplaceable → tabs, placeable → focus sync, queued until ready, once per nonce', async () => {
    const fake = fakeStore();
    const emitFocus = vi.fn();
    const onUnplaceable = vi.fn();
    const host = (overrides: Partial<BoardHostBindings>) => hostOf({ onUnplaceableOpenRequest: onUnplaceable, ...overrides });
    const view = render(
      <Harness store={fake.store} host={host({ openRequest: { name: 'README.md', nonce: 1 } })} emitFocus={emitFocus} />,
    );
    await flush();
    expect(onUnplaceable).not.toHaveBeenCalled();
    act(() => fake.setState({ status: 'ready', board: BOARD }));
    await flush();
    expect(onUnplaceable).toHaveBeenCalledWith('README.md');

    fake.store.sync.mockClear();
    // The run-started sync of the same render goes first, then the focus sync.
    fake.responses.push(EMPTY_SYNC, { ...EMPTY_SYNC, focus: { nodeIds: ['n_index', 'n_hero'], primaryNodeId: 'n_hero' } });
    view.rerender(
      <Harness
        store={fake.store}
        host={host({ openRequest: { name: 'hero.png', nonce: 2, openBatch: ['index.html', 'notes.md', 'hero.png'] }, runInFlight: true, messages: [assistant('m2')] })}
        emitFocus={emitFocus}
      />,
    );
    await flush();
    const focusCall = fake.store.sync.mock.calls.find(([request]) => request.reason === 'focus');
    expect(focusCall?.[0]).toEqual({
      conversationId: 'c1',
      reason: 'focus',
      turn: { conversationId: 'c1', messageId: 'm2', runId: 'run-m2', status: 'running' },
      focus: { names: ['index.html', 'hero.png'], primary: 'hero.png' },
    });
    expect(emitFocus).toHaveBeenCalledWith({
      nodeIds: ['n_index', 'n_hero'],
      primaryNodeId: 'n_hero',
      behavior: 'fly-to',
      source: 'open-request',
    });
    const focusSyncs = () => fake.store.sync.mock.calls.filter(([request]) => request.reason === 'focus').length;
    view.rerender(
      <Harness
        store={fake.store}
        host={host({ openRequest: { name: 'hero.png', nonce: 2, openBatch: ['index.html', 'notes.md', 'hero.png'] } })}
        emitFocus={emitFocus}
      />,
    );
    await flush();
    expect(focusSyncs()).toBe(1);
  });

  it('opens a tab when the daemon reports the primary name unplaceable', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const onUnplaceable = vi.fn();
    fake.responses.push(EMPTY_SYNC);
    fake.responses.push({ ...EMPTY_SYNC, unplaceable: ['gone.html'] });
    render(
      <Harness
        store={fake.store}
        host={hostOf({ onUnplaceableOpenRequest: onUnplaceable, openRequest: { name: 'gone.html', nonce: 7 } })}
        emitFocus={vi.fn()}
      />,
    );
    await flush();
    expect(onUnplaceable).toHaveBeenCalledWith('gone.html');
  });

  it('ignores open requests while the board is inactive and never replays them', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const onUnplaceable = vi.fn();
    const view = render(
      <Harness store={fake.store} host={hostOf({ active: false, onUnplaceableOpenRequest: onUnplaceable, openRequest: { name: 'README.md', nonce: 3 } })} emitFocus={vi.fn()} />,
    );
    await flush();
    view.rerender(
      <Harness store={fake.store} host={hostOf({ active: true, onUnplaceableOpenRequest: onUnplaceable, openRequest: { name: 'README.md', nonce: 3 } })} emitFocus={vi.fn()} />,
    );
    await flush();
    expect(onUnplaceable).not.toHaveBeenCalled();
  });

  it('read-only boards focus existing nodes without any sync', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const emitFocus = vi.fn();
    const view = render(<Harness store={fake.store} host={hostOf({ readOnly: true })} emitFocus={emitFocus} idleMs={10} />);
    await flush();
    view.rerender(
      <Harness store={fake.store} host={hostOf({ readOnly: true, runInFlight: true, filesGeneration: 2, openRequest: { name: 'hero.png', nonce: 1 } })} emitFocus={emitFocus} idleMs={10} />,
    );
    await flush(2000);
    view.rerender(<Harness store={fake.store} host={hostOf({ readOnly: true, runInFlight: false, filesGeneration: 3 })} emitFocus={emitFocus} />);
    await flush(2000);
    expect(fake.store.sync).not.toHaveBeenCalled();
    expect(mediaTasks).not.toHaveBeenCalled();
    expect(emitFocus).toHaveBeenCalledWith({ nodeIds: ['n_hero'], primaryNodeId: 'n_hero', behavior: 'reveal-pill', source: 'open-request' });
  });

  it('debounces file list changes into one files-changed sync, skipped while a run is in flight', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const view = render(<Harness store={fake.store} host={hostOf({ filesGeneration: 1 })} emitFocus={vi.fn()} />);
    await flush();
    fake.store.sync.mockClear();
    view.rerender(<Harness store={fake.store} host={hostOf({ filesGeneration: 2 })} emitFocus={vi.fn()} />);
    await flush(100);
    view.rerender(<Harness store={fake.store} host={hostOf({ filesGeneration: 3 })} emitFocus={vi.fn()} />);
    await flush(249);
    expect(fake.store.sync).not.toHaveBeenCalled();
    await flush(1);
    expect(fake.store.sync).toHaveBeenCalledTimes(1);
    expect(fake.store.sync).toHaveBeenLastCalledWith({ conversationId: 'c1', reason: 'files-changed' });

    view.rerender(<Harness store={fake.store} host={hostOf({ filesGeneration: 4, runInFlight: true })} emitFocus={vi.fn()} />);
    await flush(1500);
    expect(fake.store.sync.mock.calls.filter(([request]) => request.reason === 'files-changed')).toHaveLength(1);
  });

  it('polls media tasks while a run is in flight and syncs on signature changes', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    mediaTasks
      .mockResolvedValueOnce({ tasks: [{ taskId: 't1', runId: 'r1', status: 'running', startedAt: 1, endedAt: null, elapsed: 0, progress: [], progressCount: 0 }] })
      .mockResolvedValueOnce({ tasks: [{ taskId: 't1', runId: 'r1', status: 'running', startedAt: 1, endedAt: null, elapsed: 0, progress: [], progressCount: 0 }] })
      .mockResolvedValue({
        tasks: [
          { taskId: 't1', runId: 'r1', status: 'done', startedAt: 1, endedAt: 2, elapsed: 1, progress: [], progressCount: 0, file: { name: 'x.png' } as never },
          { taskId: 'gen-1', status: 'running', startedAt: 1, endedAt: null, elapsed: 0, progress: [], progressCount: 0 },
        ],
      });
    const view = render(<Harness store={fake.store} host={hostOf()} emitFocus={vi.fn()} />);
    await flush();
    expect(mediaTasks).not.toHaveBeenCalled();
    fake.store.sync.mockClear();
    view.rerender(<Harness store={fake.store} host={hostOf({ runInFlight: true })} emitFocus={vi.fn()} />);
    await flush();
    expect(mediaTasks).toHaveBeenCalledTimes(1);
    const mediaSyncs = () => fake.store.sync.mock.calls.filter(([request]) => request.reason === 'media').length;
    expect(mediaSyncs()).toBe(1);
    await flush(1500);
    expect(mediaTasks).toHaveBeenCalledTimes(2);
    expect(mediaSyncs()).toBe(1);
    await flush(1500);
    expect(mediaSyncs()).toBe(2);
  });

  it('keeps polling after the run while the board shows queued or running media', async () => {
    const pendingBoard = boardFrom([{ op: 'add', node: { id: 'n_p', kind: 'image', ref: null, pending: { mediaTaskId: 't9', status: 'queued' } } }]);
    const fake = fakeStore({ status: 'ready', board: pendingBoard });
    render(<Harness store={fake.store} host={hostOf()} emitFocus={vi.fn()} />);
    await flush();
    expect(mediaTasks).toHaveBeenCalledTimes(1);
    act(() => fake.setState({ board: BOARD }));
    await flush(3000);
    expect(mediaTasks).toHaveBeenCalledTimes(1);
  });
});

describe('BoardDataProvider', () => {
  function Probe({ onValue }: { onValue: (value: BoardDataValue) => void }) {
    const value = useBoardData();
    const status = useBoardState((state) => state.status);
    onValue(value);
    return <span data-testid="status">{status}</span>;
  }

  it('creates, loads and feeds one store per project, and disposes it after unmount', async () => {
    const first = fakeStore({ status: 'ready', board: BOARD });
    const second = fakeStore();
    const createStore = vi.fn()
      .mockReturnValueOnce(first.store)
      .mockReturnValueOnce(second.store);
    let latest: BoardDataValue | null = null;
    const view = render(
      <BoardDataProvider {...hostOf()} createStore={createStore}>
        <Probe onValue={(value) => { latest = value; }} />
      </BoardDataProvider>,
    );
    await flush();
    expect(createStore).toHaveBeenCalledWith(expect.objectContaining({ projectId: 'p1', readOnly: false, workspaceContext: null }));
    expect(typeof createStore.mock.calls[0]![0].clientId).toBe('string');
    expect(first.store.load).toHaveBeenCalled();
    expect(view.getByTestId('status').textContent).toBe('ready');
    expect(latest!.store).toBe(first.store);

    publishBoardProjectEvent('p1', JSON.stringify({ type: 'board-changed', projectId: 'p1', revision: 3, reason: 'patch', actor: { kind: 'user' }, at: 1 }));
    expect(first.store.handleBusEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'board-changed' }));

    view.rerender(
      <BoardDataProvider {...hostOf({ projectId: 'p2' })} createStore={createStore}>
        <Probe onValue={(value) => { latest = value; }} />
      </BoardDataProvider>,
    );
    await flush();
    expect(latest!.store).toBe(second.store);
    expect(first.store.dispose).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(second.store.dispose).not.toHaveBeenCalled();
    await flush();
    expect(second.store.dispose).toHaveBeenCalledTimes(1);
  });

  it('emits focus intents only while active, acks them and answers willHandleOpenRequest', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    fake.responses.push(EMPTY_SYNC, { ...EMPTY_SYNC, focus: { nodeIds: ['n_hero'], primaryNodeId: 'n_hero' } });
    let latest: BoardDataValue | null = null;
    const props = (overrides: Partial<BoardHostBindings>) => ({ ...hostOf(overrides), createStore: () => fake.store });
    const view = render(
      <BoardDataProvider {...props({ openRequest: { name: 'hero.png', nonce: 1 } })}>
        <Probe onValue={(value) => { latest = value; }} />
      </BoardDataProvider>,
    );
    await flush();
    expect(latest!.focusIntent).toMatchObject({ nodeIds: ['n_hero'], primaryNodeId: 'n_hero', behavior: 'fly-to', source: 'open-request', nonce: 1 });
    act(() => latest!.noteCameraInteraction());
    act(() => latest!.ackFocusIntent(1));
    expect(latest!.focusIntent).toBeNull();
    expect(latest!.willHandleOpenRequest({ name: 'README.md' })).toBe(false);
    expect(latest!.willHandleOpenRequest({ name: 'README.md', openBatch: ['README.md', 'live:abc'] })).toBe(true);

    view.rerender(
      <BoardDataProvider {...props({ active: false, openRequest: { name: 'hero.png', nonce: 2 } })}>
        <Probe onValue={(value) => { latest = value; }} />
      </BoardDataProvider>,
    );
    await flush();
    expect(latest!.focusIntent).toBeNull();
    expect(latest!.willHandleOpenRequest({ name: 'hero.png' })).toBe(false);
  });

  it('reports the selection as one context item while active, debounced and deduplicated', async () => {
    const fake = fakeStore({ status: 'ready', board: BOARD });
    const onActiveContextChange = vi.fn();
    function Selection({ ids }: { ids: string[] }) {
      useBoardSelectionContextSync({ selectedIds: ids });
      return null;
    }
    const tree = (ids: string[], active = true) => (
      <BoardDataProvider {...hostOf({ active, onActiveContextChange })} createStore={() => fake.store}>
        <Selection ids={ids} />
      </BoardDataProvider>
    );
    const view = render(tree(['n_hero']));
    await flush(119);
    expect(onActiveContextChange).not.toHaveBeenCalled();
    await flush(1);
    expect(onActiveContextChange).toHaveBeenCalledTimes(1);
    expect(onActiveContextChange.mock.calls[0]![0]).toMatchObject({
      id: 'board-selection:n_hero',
      kind: 'board-selection',
      path: 'hero.png',
      absolutePath: '/work/p1/hero.png',
    });
    view.rerender(tree(['n_hero']));
    act(() => fake.setState({ serverRevision: 2 }));
    await flush(500);
    expect(onActiveContextChange).toHaveBeenCalledTimes(1);
    view.rerender(tree([]));
    await flush(120);
    expect(onActiveContextChange).toHaveBeenLastCalledWith(null);
    view.rerender(tree(['n_index', 'n_hero'], false));
    await flush(500);
    expect(onActiveContextChange).toHaveBeenCalledTimes(2);
    view.rerender(tree(['n_index', 'n_hero'], true));
    await flush(120);
    expect(onActiveContextChange).toHaveBeenCalledTimes(3);
    expect(onActiveContextChange.mock.calls[2]![0]).toMatchObject({ id: 'board-selection:n_hero,n_index', nodes: [{ id: 'n_index' }, { id: 'n_hero' }] });
  });
});
