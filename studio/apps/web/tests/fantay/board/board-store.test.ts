import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyBoardOps,
  emptyBoardDocument,
  type BoardActor,
  type BoardContent,
  type BoardDocument,
  type BoardNode,
  type BoardOp,
  type BoardPatchRequest,
  type BoardPatchResponse,
  type BoardSyncRequest,
  type BoardSyncResponse,
  type BoardViewport,
} from '@open-design/contracts';

import { BoardRequestError } from '../../../src/fantay/board/data/board-api';
import { createBoardStore, mergeBoardSyncRequests } from '../../../src/fantay/board/data/board-store';
import type { BoardDataStore } from '../../../src/fantay/board/data/types';

const PROJECT = 'p1';
const ME = 'client-me-0001';
const OTHER = 'client-other-01';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function contentOf(doc: BoardDocument): BoardContent {
  return { ...(doc.title !== undefined ? { title: doc.title } : {}), settings: doc.settings, nodes: doc.nodes, edges: doc.edges };
}

function withContent(doc: BoardDocument, content: BoardContent, revision: number, at: number, actor: BoardActor): BoardDocument {
  const { title: _title, ...rest } = doc;
  return {
    ...rest,
    ...(content.title !== undefined ? { title: content.title } : {}),
    settings: content.settings,
    nodes: content.nodes,
    edges: content.edges,
    revision,
    updatedAt: at,
    updatedBy: actor,
  };
}

type Failure = 'conflict' | 'offline' | 'forbidden' | 'invalid';

/** In-memory daemon: the same contracts engine as the real one (`checkConflicts: true`). */
class FakeDaemon {
  doc: BoardDocument;
  clock = 500_000;
  idSeq = 0;
  gets = 0;
  patches: BoardPatchRequest[] = [];
  patchOptions: Array<{ keepalive?: boolean } | undefined> = [];
  syncs: BoardSyncRequest[] = [];
  viewports: Array<{ viewport: BoardViewport; keepalive: boolean }> = [];
  failures: Failure[] = [];
  syncResponses: Array<BoardSyncResponse | ((request: BoardSyncRequest) => BoardSyncResponse)> = [];
  paused = false;
  /** PATCHes commit at once but their responses wait for `release()` (another response may overtake them). */
  holdResponses = false;
  private held: Array<() => void> = [];
  private heldSyncs: Array<() => void> = [];
  pauseSyncs = false;

  constructor(doc?: BoardDocument) {
    this.doc = doc ?? emptyBoardDocument(PROJECT);
  }

  commit(body: BoardPatchRequest, checkConflicts = true): BoardPatchResponse {
    const actor = body.actor ?? { kind: 'user' };
    this.clock += 1000;
    const outcome = applyBoardOps(contentOf(this.doc), body.ops, {
      baseRevision: body.baseRevision,
      nextRevision: this.doc.revision + 1,
      actor,
      now: this.clock,
      newId: (prefix) => `${prefix}_srv${(this.idSeq += 1)}`,
      checkConflicts,
    });
    if (!outcome.ok) {
      if (outcome.reason === 'conflict') {
        throw new BoardRequestError('board changed since it was read', {
          code: 'CONFLICT',
          status: 409,
          details: { kind: 'board-conflict', revision: this.doc.revision, conflicts: outcome.conflicts },
        });
      }
      throw new BoardRequestError('invalid board request', { code: 'VALIDATION_FAILED', status: 400 });
    }
    if (outcome.inverse.length === 0) {
      return { revision: this.doc.revision, updatedAt: this.clock, results: outcome.results, changes: outcome.changes, inverse: [] };
    }
    this.doc = withContent(this.doc, outcome.content, this.doc.revision + 1, this.clock, actor);
    return { revision: this.doc.revision, updatedAt: this.clock, results: outcome.results, changes: outcome.changes, inverse: outcome.inverse };
  }

  /** Another client (or an agent) writes. */
  remote(ops: BoardOp[], clientId = OTHER): BoardPatchResponse {
    return this.commit({ baseRevision: this.doc.revision, ops, actor: { kind: 'user', clientId } }, false);
  }

  pause(): void {
    this.paused = true;
  }

  release(): void {
    this.paused = false;
    const held = this.held;
    this.held = [];
    for (const go of held) go();
  }

  releaseSyncs(): void {
    this.pauseSyncs = false;
    const held = this.heldSyncs;
    this.heldSyncs = [];
    for (const go of held) go();
  }

  api() {
    return {
      fetchBoard: vi.fn(async () => {
        this.gets += 1;
        return { board: clone(this.doc) };
      }),
      patchBoard: vi.fn((_projectId: string, body: BoardPatchRequest, opts?: { keepalive?: boolean }) => {
        this.patches.push(clone(body));
        this.patchOptions.push(opts ? { ...(opts.keepalive ? { keepalive: true } : {}) } : undefined);
        const run = (): BoardPatchResponse => {
          const failure = this.failures.shift();
          if (failure === 'conflict') throw new BoardRequestError('board changed', { code: 'CONFLICT', status: 409 });
          if (failure === 'offline') throw new BoardRequestError('unreachable', { code: 'NETWORK_ERROR', status: null });
          if (failure === 'forbidden') throw new BoardRequestError('forbidden', { code: 'FORBIDDEN', status: 403 });
          if (failure === 'invalid') throw new BoardRequestError('bad ref', { code: 'FILE_NOT_FOUND', status: 404 });
          return clone(this.commit(clone(body)));
        };
        return new Promise<BoardPatchResponse>((resolve, reject) => {
          const go = () => {
            try {
              resolve(run());
            } catch (error) {
              reject(error);
            }
          };
          if (this.paused) {
            this.held.push(go);
          } else if (this.holdResponses) {
            let answer: () => void;
            try {
              const response = run();
              answer = () => resolve(response);
            } catch (error) {
              answer = () => reject(error);
            }
            this.held.push(answer);
          } else {
            go();
          }
        });
      }),
      syncBoard: vi.fn((_projectId: string, body: BoardSyncRequest) => {
        this.syncs.push(clone(body));
        const next = this.syncResponses.shift();
        const response: BoardSyncResponse = typeof next === 'function'
          ? next(body)
          : next ?? { revision: this.doc.revision, changed: false, changes: null, placements: [], focus: null, unplaceable: [] };
        return new Promise<BoardSyncResponse>((resolve) => {
          if (this.pauseSyncs) this.heldSyncs.push(() => resolve(clone(response)));
          else resolve(clone(response));
        });
      }),
      putBoardViewport: vi.fn(async (_projectId: string, viewport: BoardViewport, opts?: { keepalive?: boolean }) => {
        this.viewports.push({ viewport: clone(viewport), keepalive: opts?.keepalive === true });
      }),
    };
  }
}

function seededDaemon(ops: BoardOp[]): FakeDaemon {
  const daemon = new FakeDaemon();
  daemon.commit({ baseRevision: 0, ops, actor: { kind: 'user', clientId: 'seed-client' } }, false);
  return daemon;
}

const note = (id: string, x = 0, y = 0, text = id): BoardOp => ({ op: 'add', node: { id, kind: 'note', text, x, y } });

async function settle(rounds = 40): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await Promise.resolve();
}

async function tick(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await settle();
}

let idSeq = 0;
let stores: BoardDataStore[] = [];

function makeStore(daemon: FakeDaemon, overrides: { readOnly?: boolean } = {}) {
  const api = daemon.api();
  const store = createBoardStore({
    projectId: PROJECT,
    clientId: ME,
    workspaceContext: null,
    readOnly: overrides.readOnly ?? false,
    api,
    newId: (prefix) => `${prefix}_loc${(idSeq += 1)}`,
  });
  stores.push(store);
  return { store, api };
}

async function loaded(daemon: FakeDaemon, overrides: { readOnly?: boolean } = {}) {
  const made = makeStore(daemon, overrides);
  await made.store.load();
  await settle();
  return made;
}

function nodeOf(store: BoardDataStore, id: string): BoardNode | undefined {
  return store.getState().board?.nodes.find((node) => node.id === id);
}

function changedEvent(revision: number, clientId?: string) {
  return {
    type: 'board-changed' as const,
    payload: {
      type: 'board-changed' as const,
      projectId: PROJECT,
      revision,
      reason: 'patch' as const,
      actor: { kind: 'user' as const, ...(clientId ? { clientId } : {}) },
      at: Date.now(),
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-29T08:00:00Z'));
  idSeq = 0;
  stores = [];
});

afterEach(() => {
  for (const store of stores) store.dispose();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('board store · load', () => {
  it('loads the board and keeps initialViewport from the first GET only', async () => {
    const daemon = seededDaemon([note('n_a')]);
    daemon.doc = { ...daemon.doc, viewport: { centerX: 10, centerY: 20, zoom: 1.5 } };
    const { store } = makeStore(daemon);
    expect(store.getState().status).toBe('idle');
    const loading = store.load();
    expect(store.getState().status).toBe('loading');
    await loading;
    await settle();
    const state = store.getState();
    expect(state.status).toBe('ready');
    expect(state.serverRevision).toBe(1);
    expect(state.board?.nodes.map((node) => node.id)).toEqual(['n_a']);
    expect(state.initialViewport).toEqual({ centerX: 10, centerY: 20, zoom: 1.5 });

    daemon.doc = { ...daemon.doc, viewport: { centerX: 99, centerY: 99, zoom: 3 } };
    store.handleBusEvent({ type: 'stream-ready' });
    await tick(100);
    expect(daemon.gets).toBe(2);
    expect(store.getState().initialViewport).toEqual({ centerX: 10, centerY: 20, zoom: 1.5 });
  });

  it('keeps node identity when a refetch returns the same revisions', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store } = await loaded(daemon);
    const before = store.getState().board;
    store.handleBusEvent({ type: 'stream-ready' });
    await tick(100);
    expect(daemon.gets).toBe(2);
    expect(store.getState().board).toBe(before);
  });

  it('marks a failed first GET offline and retries with backoff', async () => {
    const daemon = new FakeDaemon();
    const { store, api } = makeStore(daemon);
    api.fetchBoard.mockRejectedValueOnce(new BoardRequestError('down', { code: 'NETWORK_ERROR', status: null }));
    await store.load();
    await settle();
    expect(store.getState().status).toBe('error');
    expect(store.getState().lastError?.code).toBe('offline');
    await tick(999);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    expect(store.getState().status).toBe('ready');
    expect(store.getState().lastError).toBeNull();
  });
});

describe('board store · optimistic apply and batching', () => {
  it('applies locally at once, then PATCHes with filled ids, baseRevision and the client actor', async () => {
    const daemon = new FakeDaemon();
    const { store, api } = await loaded(daemon);
    const pending = store.apply([{ op: 'add', node: { kind: 'note', text: 'hello', x: 10, y: 20 } }]);
    const optimistic = store.getState();
    expect(optimistic.board?.nodes).toHaveLength(1);
    const localNode = optimistic.board!.nodes[0]!;
    expect(localNode.id).toBe('n_loc1');
    expect(optimistic.pendingOps).toBe(1);
    expect(api.patchBoard).not.toHaveBeenCalled();

    const result = await pending;
    expect(result.ok).toBe(true);
    expect(result.results?.[0]).toMatchObject({ index: 0, status: 'applied', ids: ['n_loc1'] });
    expect(daemon.patches).toHaveLength(1);
    const body = daemon.patches[0]!;
    expect(body.baseRevision).toBe(0);
    expect(body.actor).toEqual({ kind: 'user', clientId: ME });
    expect(body.ops[0]).toMatchObject({ op: 'add', node: { id: 'n_loc1', kind: 'note', text: 'hello' } });
    const state = store.getState();
    expect(state.pendingOps).toBe(0);
    expect(state.serverRevision).toBe(1);
    // B13: the daemon's createdAt wins on commit.
    expect(nodeOf(store, 'n_loc1')?.createdAt).toBe(daemon.doc.nodes[0]!.createdAt);
    expect(nodeOf(store, 'n_loc1')?.createdAt).not.toBe(localNode.createdAt);
  });

  it('flushes applies of one tick in one PATCH and queues the rest behind the in-flight PATCH', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400), note('n_c', 800)]);
    const { store } = await loaded(daemon);
    const options = { undoable: false };
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'a1' } }], options);
    void store.apply([{ op: 'update', id: 'n_b', patch: { text: 'b1' } }], options);
    daemon.pause();
    await settle();
    expect(daemon.patches).toHaveLength(1);
    expect(daemon.patches[0]!.ops).toHaveLength(2);
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'a2' } }], options);
    void store.apply([{ op: 'update', id: 'n_b', patch: { text: 'b2' } }], options);
    void store.apply([{ op: 'update', id: 'n_c', patch: { text: 'c2' } }], options);
    await settle();
    expect(daemon.patches).toHaveLength(1);
    expect(store.getState().pendingOps).toBe(5);
    daemon.release();
    await settle();
    expect(daemon.patches).toHaveLength(2);
    expect(daemon.patches[1]!.ops).toHaveLength(3);
    expect(store.getState().pendingOps).toBe(0);
    expect(store.getState().board?.nodes.map((node) => (node as { text?: string }).text)).toEqual(['a2', 'b2', 'c2']);
  });

  it('never mixes undoable applies into one PATCH unless they share a coalesceKey', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store } = await loaded(daemon);
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'x' } }]);
    void store.apply([{ op: 'update', id: 'n_b', patch: { text: 'y' } }]);
    await settle();
    expect(daemon.patches.map((patch) => patch.ops.length)).toEqual([1, 1]);

    daemon.pause();
    void store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 1, y: 0 }] }], { coalesceKey: 'nudge:n_a' });
    await settle();
    void store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 2, y: 0 }] }], { coalesceKey: 'nudge:n_a' });
    void store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 3, y: 0 }] }], { coalesceKey: 'nudge:n_a' });
    daemon.release();
    await settle();
    daemon.release();
    await settle();
    expect(daemon.patches.map((patch) => patch.ops.length)).toEqual([1, 1, 1, 2]);
  });

  it('resolves a no-op apply without a PATCH and rejects an invalid one locally', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    const noop = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'n_a' } }]);
    expect(noop.ok).toBe(true);
    const invalid = await store.apply([{ op: 'update', id: 'n_a', patch: { url: 'https://example.com' } }]);
    expect(invalid.ok).toBe(false);
    expect(store.getState().lastError?.code).toBe('save-failed');
    await settle();
    expect(daemon.patches).toHaveLength(0);
  });

  it('does not send ops that were skipped locally (missing target)', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    const result = await store.apply([
      { op: 'update', id: 'n_gone', patch: { text: 'x' } },
      { op: 'update', id: 'n_a', patch: { text: 'kept' } },
    ]);
    expect(result.ok).toBe(true);
    expect(daemon.patches).toHaveLength(1);
    expect(daemon.patches[0]!.ops).toHaveLength(1);
    expect(daemon.patches[0]!.ops[0]).toMatchObject({ op: 'update', id: 'n_a' });
    expect(result.results?.map((entry) => entry.status)).toEqual(['skipped', 'applied']);
  });

  it('sends an apply above 200 ops in slices with one undo entry', async () => {
    const daemon = new FakeDaemon();
    const { store } = await loaded(daemon);
    const ops = Array.from({ length: 250 }, (_, index) => note(`n_bulk${index}`, index * 300, 0));
    const result = await store.apply(ops);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(250);
    expect(daemon.patches.map((patch) => patch.ops.length)).toEqual([200, 50]);
    expect(store.getState().board?.nodes).toHaveLength(250);
    expect(store.getState().canUndo).toBe(true);
    expect(await store.undo()).toBe(true);
    expect(store.getState().board?.nodes).toHaveLength(0);
    expect(store.getState().canUndo).toBe(false);
  });
});

describe('board store · expectRev capture', () => {
  it('captures the acked rev of existing targets', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'x' } }]);
    expect(daemon.patches[0]!.ops[0]).toMatchObject({ op: 'update', id: 'n_a', expectRev: 1 });
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 5, y: 5 }] }]);
    expect(daemon.patches[1]!.ops[0]).toMatchObject({ op: 'move', expectRev: { n_a: 2 } });
  });

  it('owns expectRev: a caller value (e.g. a rev read from the optimistic view) is replaced', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    const result = await store.apply([
      { op: 'update', id: 'n_a', patch: { text: 'x' }, expectRev: 99 },
      { op: 'move', moves: [{ id: 'n_a', x: 3, y: 3 }], expectRev: { n_a: 42 } },
    ]);
    expect(result.ok).toBe(true);
    expect(daemon.patches[0]!.ops).toEqual([
      { op: 'update', id: 'n_a', patch: { text: 'x' }, expectRev: 1 },
      { op: 'move', moves: [{ id: 'n_a', x: 3, y: 3 }], expectRev: { n_a: 1 } },
    ]);
  });

  it('fills expectRev at send time for targets created by an earlier unacked batch', async () => {
    const daemon = new FakeDaemon();
    const { store } = await loaded(daemon);
    daemon.pause();
    const created = store.apply([{ op: 'add', node: { kind: 'note', text: 'new', x: 0, y: 0 } }]);
    await settle();
    const updated = store.apply([{ op: 'update', id: 'n_loc1', patch: { text: 'renamed' } }]);
    daemon.release();
    expect((await created).ok).toBe(true);
    expect((await updated).ok).toBe(true);
    expect(daemon.patches[1]!.ops[0]).toMatchObject({ op: 'update', id: 'n_loc1', expectRev: 1 });
    expect(store.getState().lastError).toBeNull();
  });

  it('advances captures of queued ops when our own in-flight batch changes the same node', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.pause();
    const moved = store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 40, y: 0 }] }]);
    await settle();
    const renamed = store.apply([{ op: 'update', id: 'n_a', patch: { text: 'after-move' } }]);
    daemon.release();
    expect((await moved).ok).toBe(true);
    expect((await renamed).ok).toBe(true);
    expect(daemon.patches[1]!.ops[0]).toMatchObject({ op: 'update', expectRev: 2 });
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 40, text: 'after-move' });
  });
});

describe('board store · 409 rebase', () => {
  it('drops ops whose target changed remotely, re-sends the rest and reports a conflict', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store, api } = await loaded(daemon);
    const mine = store.apply([{ op: 'update', id: 'n_a', patch: { text: 'mine' } }], { undoable: false });
    const other = store.apply([{ op: 'update', id: 'n_b', patch: { text: 'mine-b' } }], { undoable: false });
    daemon.remote([{ op: 'update', id: 'n_a', patch: { text: 'theirs' } }]);
    expect((await mine).ok).toBe(false);
    expect((await other).ok).toBe(true);
    expect(daemon.patches).toHaveLength(2);
    expect(daemon.patches[1]!.ops).toHaveLength(1);
    expect(daemon.patches[1]!.ops[0]).toMatchObject({ op: 'update', id: 'n_b' });
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'theirs' });
    expect(nodeOf(store, 'n_b')).toMatchObject({ text: 'mine-b' });
    expect(store.getState().lastError?.code).toBe('conflict');
  });

  it('drops silently when every dropped op was silentConflict', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    const autosize = store.apply([{ op: 'update', id: 'n_a', patch: { w: 300, h: 240 } }], { undoable: false, silentConflict: true });
    daemon.remote([{ op: 'update', id: 'n_a', patch: { text: 'theirs' } }]);
    expect((await autosize).ok).toBe(false);
    expect(store.getState().lastError).toBeNull();
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'theirs' });
  });

  it('drops the queue after more than 3 rebase rounds', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.failures.push('conflict', 'conflict', 'conflict', 'conflict');
    const result = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'never' } }]);
    await settle();
    expect(result.ok).toBe(false);
    expect(daemon.patches).toHaveLength(4);
    expect(store.getState().lastError?.code).toBe('conflict');
    expect(store.getState().pendingOps).toBe(0);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'n_a' });
  });

  it('counts rebase rounds per queue: earlier conflicts that emptied the queue do not use up later rounds', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store } = await loaded(daemon);
    for (let round = 0; round < 3; round += 1) {
      const pending = store.apply([{ op: 'update', id: 'n_a', patch: { text: `mine${round}` } }], { undoable: false });
      // No SSE frame: the PATCH meets a real 409 and the rebase drops the op.
      daemon.remote([{ op: 'update', id: 'n_a', patch: { text: `theirs${round}` } }]);
      expect((await pending).ok).toBe(false);
    }
    const patchesBefore = daemon.patches.length;
    daemon.failures.push('conflict');
    const later = await store.apply([{ op: 'update', id: 'n_b', patch: { text: 'kept' } }], { undoable: false });
    expect(later.ok).toBe(true);
    expect(daemon.patches.length - patchesBefore).toBe(2);
    expect(nodeOf(store, 'n_b')).toMatchObject({ text: 'kept' });
  });
});

describe('board store · offline, read-only, errors', () => {
  it('keeps the queue offline and retries with backoff 1 s → 2 s, clearing the error on success', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.failures.push('offline', 'offline');
    const pending = store.apply([{ op: 'update', id: 'n_a', patch: { text: 'eventually' } }]);
    await settle();
    expect(daemon.patches).toHaveLength(1);
    expect(store.getState().lastError?.code).toBe('offline');
    expect(store.getState().pendingOps).toBe(1);
    await tick(999);
    expect(daemon.patches).toHaveLength(1);
    await tick(1);
    expect(daemon.patches).toHaveLength(2);
    await tick(1999);
    expect(daemon.patches).toHaveLength(2);
    await tick(1);
    expect(daemon.patches).toHaveLength(3);
    expect((await pending).ok).toBe(true);
    expect(store.getState().lastError).toBeNull();
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'eventually' });
  });

  it('drops a stale queued op as soon as a GET brings the remote change, even while offline', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.failures.push('offline');
    const pending = store.apply([{ op: 'update', id: 'n_a', patch: { text: 'mine' } }]);
    await settle();
    expect(store.getState().lastError?.code).toBe('offline');
    daemon.remote([{ op: 'update', id: 'n_a', patch: { text: 'theirs' } }]);
    store.handleBusEvent(changedEvent(daemon.doc.revision, OTHER));
    await tick(100);
    expect(daemon.patches).toHaveLength(1);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'theirs' });
    expect(store.getState().pendingOps).toBe(0);
    expect((await pending).ok).toBe(false);
    expect(store.getState().lastError?.code).toBe('conflict');
    await tick(1000);
    expect(daemon.patches).toHaveLength(1);
  });

  it('read-only stores change only the local view until the next GET', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon, { readOnly: true });
    const result = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'local' } }]);
    expect(result.ok).toBe(false);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'local' });
    expect(store.getState().lastError?.code).toBe('read-only');
    expect(store.getState().pendingOps).toBe(0);
    expect(await store.sync({ reason: 'manual' })).toBeNull();
    store.setViewport({ centerX: 1, centerY: 1, zoom: 1 });
    expect(await store.undo()).toBe(false);
    await tick(1000);
    expect(api.patchBoard).not.toHaveBeenCalled();
    expect(api.syncBoard).not.toHaveBeenCalled();
    expect(api.putBoardViewport).not.toHaveBeenCalled();
    store.handleBusEvent({ type: 'stream-ready' });
    await tick(100);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'n_a' });
  });

  it('403 drops the queue, reports read-only and keeps later edits local', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.failures.push('forbidden');
    const first = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'denied' } }]);
    expect(first.ok).toBe(false);
    expect(store.getState().lastError?.code).toBe('read-only');
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'n_a' });
    await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'local only' } }]);
    await settle();
    expect(daemon.patches).toHaveLength(1);
  });

  it('other 4xx answers drop the batch with save-failed and the daemon message', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.failures.push('invalid');
    const result = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'x' } }]);
    expect(result.ok).toBe(false);
    expect(store.getState().lastError).toMatchObject({ code: 'save-failed', message: 'bad ref' });
    const next = await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'y' } }]);
    expect(next.ok).toBe(true);
    expect(store.getState().lastError).toBeNull();
  });
});

describe('board store · undo / redo', () => {
  it('replays the daemon inverse with fresh expectRev, then redoes with the undo response inverse', async () => {
    const daemon = seededDaemon([note('n_a', 0, 0)]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 100, y: 50 }] }], { label: 'move' });
    expect(store.getState().canUndo).toBe(true);
    const undone = store.undo();
    expect(await undone).toBe(true);
    const undoBody = daemon.patches[1]!;
    expect(undoBody.ops[0]).toMatchObject({ op: 'restore', expectRev: { n_a: 2 } });
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 0, y: 0 });
    expect(store.getState()).toMatchObject({ canUndo: false, canRedo: true });
    expect(await store.redo()).toBe(true);
    expect(daemon.patches[2]!.ops[0]).toMatchObject({ op: 'restore', expectRev: { n_a: 3 } });
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 100, y: 50 });
    expect(store.getState()).toMatchObject({ canUndo: true, canRedo: false });
  });

  it('blocks undo once another client changed a touched node', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 100, y: 0 }] }]);
    daemon.remote([{ op: 'update', id: 'n_a', patch: { text: 'theirs' } }]);
    store.handleBusEvent(changedEvent(daemon.doc.revision, OTHER));
    await tick(100);
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'theirs' });
    expect(await store.undo()).toBe(false);
    expect(store.getState().lastError?.code).toBe('undo-blocked');
    expect(daemon.patches).toHaveLength(1);
    expect(store.getState().canUndo).toBe(false);
  });

  it('blocks undo when another client deleted a node this entry changed', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 90, y: 0 }] }]);
    daemon.remote([{ op: 'remove', ids: ['n_a'] }]);
    store.handleBusEvent(changedEvent(daemon.doc.revision, OTHER));
    await tick(100);
    expect(await store.undo()).toBe(false);
    expect(store.getState().lastError?.code).toBe('undo-blocked');
  });

  it('reports undo-blocked when the daemon rejects a replay that raced a remote change', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 90, y: 0 }] }]);
    // The remote write lands without an SSE frame reaching this store first.
    daemon.remote([{ op: 'update', id: 'n_a', patch: { text: 'theirs' } }]);
    expect(await store.undo()).toBe(false);
    expect(daemon.patches).toHaveLength(2);
    expect(store.getState().lastError?.code).toBe('undo-blocked');
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 90, text: 'theirs' });
  });

  it('allows undo of a removal (entities deleted by this client count as allowed)', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400)]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'remove', ids: ['n_a'] }]);
    expect(nodeOf(store, 'n_a')).toBeUndefined();
    expect(await store.undo()).toBe(true);
    expect(nodeOf(store, 'n_a')).toBeDefined();
    expect(store.getState().board?.nodes.map((node) => node.id)).toEqual(['n_a', 'n_b']);
  });

  it('waits for pending applies so undo reverts the latest action', async () => {
    const daemon = seededDaemon([note('n_a', 0, 0)]);
    const { store } = await loaded(daemon);
    daemon.pause();
    void store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 70, y: 0 }] }]);
    await settle();
    const undone = store.undo();
    await settle();
    expect(daemon.patches).toHaveLength(1);
    daemon.release();
    expect(await undone).toBe(true);
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 0 });
  });

  it('coalesces same-key applies within 1500 ms into one entry that restores the first state', async () => {
    const daemon = seededDaemon([note('n_a', 0, 0), note('n_b', 400, 0)]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 10, y: 0 }] }], { coalesceKey: 'nudge' });
    await tick(500);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 20, y: 0 }] }], { coalesceKey: 'nudge' });
    await tick(500);
    // A later apply touching another node joins the same entry too.
    await store.apply([{ op: 'move', moves: [{ id: 'n_b', x: 430, y: 0 }] }], { coalesceKey: 'nudge' });
    expect(await store.undo()).toBe(true);
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 0 });
    expect(nodeOf(store, 'n_b')).toMatchObject({ x: 400 });
    expect(store.getState().canUndo).toBe(false);
  });

  it('starts a new entry after the 1500 ms window', async () => {
    const daemon = seededDaemon([note('n_a', 0, 0)]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 10, y: 0 }] }], { coalesceKey: 'nudge' });
    await tick(2000);
    await store.apply([{ op: 'move', moves: [{ id: 'n_a', x: 20, y: 0 }] }], { coalesceKey: 'nudge' });
    expect(await store.undo()).toBe(true);
    expect(nodeOf(store, 'n_a')).toMatchObject({ x: 10 });
    expect(store.getState().canUndo).toBe(true);
  });

  it('a new undoable commit clears the redo stack', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'one' } }]);
    await store.undo();
    expect(store.getState().canRedo).toBe(true);
    await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'two' } }]);
    expect(store.getState().canRedo).toBe(false);
  });
});

describe('board store · project bus', () => {
  it('ignores its own echo and revisions it already has', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    store.handleBusEvent(changedEvent(9, ME));
    store.handleBusEvent(changedEvent(1, OTHER));
    store.handleBusEvent({ ...changedEvent(9, OTHER), payload: { ...changedEvent(9, OTHER).payload, projectId: 'p2' } });
    await tick(500);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
  });

  it('coalesces remote revisions into one GET after 100 ms', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    daemon.remote([note('n_remote', 900)]);
    store.handleBusEvent(changedEvent(2, OTHER));
    await tick(50);
    daemon.remote([{ op: 'update', id: 'n_remote', patch: { text: 'v2' } }]);
    store.handleBusEvent(changedEvent(3, OTHER));
    await tick(49);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
    await tick(1);
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    expect(nodeOf(store, 'n_remote')).toMatchObject({ text: 'v2' });
  });

  it('defers the GET while a PATCH is in flight', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    daemon.pause();
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'mine' } }]);
    await settle();
    daemon.remote([note('n_remote', 900)]);
    store.handleBusEvent(changedEvent(2, OTHER));
    await tick(300);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
    daemon.release();
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    expect(nodeOf(store, 'n_remote')).toBeDefined();
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'mine' });
  });

  it('refetches when a PATCH response reveals commits it has not seen', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    daemon.pause();
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'mine' } }]);
    await settle();
    daemon.remote([note('n_silent', 900)]);
    daemon.release();
    await settle();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
    expect(nodeOf(store, 'n_silent')).toBeDefined();
    expect(store.getState().serverRevision).toBe(daemon.doc.revision);
  });

  it('re-reads the board before sending queued ops when a sync response overtakes our committed PATCH', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    daemon.holdResponses = true;
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'a1' } }], { undoable: false });
    await settle();
    // The planner commits on top of our PATCH, and its response arrives first.
    daemon.syncResponses.push(() => {
      const response = daemon.commit({ baseRevision: daemon.doc.revision, ops: [note('n_synced', 900)], actor: { kind: 'sync' } }, false);
      return { revision: response.revision, changed: true, changes: response.changes, placements: [], focus: null, unplaceable: [] };
    });
    const queued = store.apply([{ op: 'update', id: 'n_a', patch: { text: 'a2' } }], { undoable: false });
    void store.sync({ reason: 'media' });
    await tick(150);
    daemon.holdResponses = false;
    daemon.release();
    expect((await queued).ok).toBe(true);
    expect(store.getState().lastError).toBeNull();
    expect(daemon.doc.nodes.find((node) => node.id === 'n_a')).toMatchObject({ text: 'a2' });
    expect(nodeOf(store, 'n_a')).toMatchObject({ text: 'a2' });
    expect(nodeOf(store, 'n_synced')).toBeDefined();
    expect(api.fetchBoard).toHaveBeenCalledTimes(2);
  });
});

describe('board store · viewport, B13, identities, sync, dispose', () => {
  it('debounces viewport saves by 800 ms and flushes with keepalive on pagehide', async () => {
    const target = new EventTarget();
    vi.stubGlobal('window', target);
    const daemon = new FakeDaemon();
    const { store } = await loaded(daemon);
    store.setViewport({ centerX: 1, centerY: 1, zoom: 1 });
    await tick(400);
    store.setViewport({ centerX: 2, centerY: 2, zoom: 1 });
    await tick(400);
    store.setViewport({ centerX: 3, centerY: 3, zoom: 2 });
    await tick(799);
    expect(daemon.viewports).toHaveLength(0);
    await tick(1);
    expect(daemon.viewports).toEqual([{ viewport: { centerX: 3, centerY: 3, zoom: 2 }, keepalive: false }]);
    store.setViewport({ centerX: 4, centerY: 4, zoom: 2 });
    target.dispatchEvent(new Event('pagehide'));
    await settle();
    expect(daemon.viewports[1]).toEqual({ viewport: { centerX: 4, centerY: 4, zoom: 2 }, keepalive: true });
  });

  it('does not re-save the viewport it restored from the first GET', async () => {
    const daemon = new FakeDaemon();
    daemon.doc = { ...daemon.doc, viewport: { centerX: 5, centerY: 6, zoom: 1.25 } };
    const { store } = await loaded(daemon);
    store.setViewport({ centerX: 5, centerY: 6, zoom: 1.25 });
    await tick(1000);
    expect(daemon.viewports).toHaveLength(0);
    store.setViewport({ centerX: 5, centerY: 7, zoom: 1.25 });
    await tick(800);
    expect(daemon.viewports).toHaveLength(1);
  });

  it('stamps optimistic createdAt monotonically per session (B13)', async () => {
    const daemon = seededDaemon([note('n_a'), note('n_b', 400), note('n_c', 800)]);
    const { store } = await loaded(daemon);
    daemon.pause();
    void store.apply([
      { op: 'connect', edge: { kind: 'lineage', from: 'n_a', to: 'n_b' } },
      { op: 'connect', edge: { kind: 'lineage', from: 'n_a', to: 'n_c' } },
    ]);
    void store.apply([note('n_d', 1200)]);
    const edges = store.getState().board!.edges;
    expect(edges.map((edge) => edge.id)).toEqual(['e_loc1', 'e_loc2']);
    const [first, second] = edges;
    expect(second!.createdAt).toBe(first!.createdAt + 1);
    expect(first!.createdAt).toBeGreaterThan(Math.max(...daemon.doc.nodes.map((node) => node.createdAt)));
    expect(nodeOf(store, 'n_d')!.createdAt).toBeGreaterThan(second!.createdAt);
    daemon.release();
    await settle();
    daemon.release();
    await settle();
    expect(store.getState().board!.edges.map((edge) => edge.createdAt))
      .toEqual(daemon.doc.edges.map((edge) => edge.createdAt));
  });

  it('strips a copied workspaceArtifactId when an update re-points a ref', async () => {
    const daemon = seededDaemon([
      { op: 'add', node: { id: 'n_frame', kind: 'frame', ref: { path: 'a.html', workspaceArtifactId: 'wa_1' } } },
    ]);
    const { store } = await loaded(daemon);
    await store.apply([{ op: 'update', id: 'n_frame', patch: { ref: { path: 'b.html', workspaceArtifactId: 'wa_1' } } }]);
    expect(daemon.patches[0]!.ops[0]).toEqual({ op: 'update', id: 'n_frame', patch: { ref: { path: 'b.html' } }, expectRev: 1 });
    await store.apply([{ op: 'update', id: 'n_frame', patch: { ref: { path: 'b.html', workspaceArtifactId: 'wa_2' } } }]);
    expect(daemon.patches[1]!.ops[0]).toMatchObject({ patch: { ref: { path: 'b.html', workspaceArtifactId: 'wa_2' } } });
  });

  it('coalesces sync requests within 150 ms (priority, union, latest turn) and applies changes without undo', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store } = await loaded(daemon);
    daemon.syncResponses.push(() => {
      const response = daemon.commit({ baseRevision: daemon.doc.revision, ops: [note('n_synced', 900)], actor: { kind: 'sync' } }, false);
      return {
        revision: response.revision,
        changed: true,
        changes: response.changes,
        placements: [{ nodeId: 'n_synced', status: 'created', path: 'x.png' }],
        focus: { nodeIds: ['n_a'], primaryNodeId: 'n_a' },
        unplaceable: [],
      };
    });
    const turnA = { conversationId: 'c1', messageId: 'm1', status: 'running' as const };
    const turnB = { conversationId: 'c1', messageId: 'm2', status: 'terminal' as const };
    const one = store.sync({ reason: 'files-changed' });
    const two = store.sync({ reason: 'focus', focus: { names: ['a.html'], primary: 'a.html' }, turn: turnA });
    await tick(100);
    const three = store.sync({ reason: 'run-finished', focus: { names: ['b.png', 'a.html'] }, turn: turnB });
    await tick(49);
    expect(daemon.syncs).toHaveLength(0);
    await tick(1);
    expect(daemon.syncs).toHaveLength(1);
    expect(daemon.syncs[0]).toEqual({
      reason: 'focus',
      turn: turnB,
      focus: { names: ['a.html', 'b.png'], primary: 'a.html' },
      actor: { kind: 'user', clientId: ME },
    });
    const responses = await Promise.all([one, two, three]);
    expect(responses.every((response) => response?.revision === 2)).toBe(true);
    expect(nodeOf(store, 'n_synced')).toBeDefined();
    expect(store.getState().canUndo).toBe(false);
  });

  it('serializes syncs: a request during an in-flight sync waits for it', async () => {
    const daemon = new FakeDaemon();
    const { store } = await loaded(daemon);
    daemon.pauseSyncs = true;
    void store.sync({ reason: 'open' });
    await tick(150);
    expect(daemon.syncs).toHaveLength(1);
    const later = store.sync({ reason: 'media' });
    await tick(500);
    expect(daemon.syncs).toHaveLength(1);
    daemon.releaseSyncs();
    await tick(150);
    expect(daemon.syncs).toHaveLength(2);
    daemon.releaseSyncs();
    expect(await later).not.toBeNull();
  });

  it('merges sync requests by priority', () => {
    expect(mergeBoardSyncRequests({ reason: 'focus', focus: { names: ['a'] } }, { reason: 'media' }))
      .toEqual({ reason: 'focus', focus: { names: ['a'] } });
    expect(mergeBoardSyncRequests({ reason: 'open', conversationId: 'c1' }, { reason: 'run-started', conversationId: 'c2' }))
      .toEqual({ reason: 'run-started', conversationId: 'c2' });
    expect(mergeBoardSyncRequests({ reason: 'manual' }, { reason: 'open' }).reason).toBe('open');
  });

  it('dispose sends queued edits once with keepalive and stops listening', async () => {
    const daemon = seededDaemon([note('n_a')]);
    const { store, api } = await loaded(daemon);
    daemon.pause();
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'first' } }], { undoable: false });
    await settle();
    void store.apply([{ op: 'update', id: 'n_a', patch: { text: 'second' } }], { undoable: false });
    const listener = vi.fn();
    store.subscribe(listener);
    store.dispose();
    daemon.release();
    await settle();
    expect(daemon.patches).toHaveLength(2);
    expect(daemon.patchOptions[1]).toEqual({ keepalive: true });
    expect(daemon.doc.nodes[0]).toMatchObject({ text: 'second' });
    store.handleBusEvent(changedEvent(99, OTHER));
    await tick(500);
    expect(api.fetchBoard).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();
    expect(await store.apply([{ op: 'update', id: 'n_a', patch: { text: 'late' } }])).toEqual({ ok: false });
  });
});
