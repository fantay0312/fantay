import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  BOARD_LIMITS,
  BOARD_SELECTION_CONTEXT_KIND,
  boardApiPath,
  boardCoverApiPath,
  type BoardActor,
  type BoardContent,
  type BoardNode,
  type BoardOp,
  type WorkspaceContextBoardNode,
} from '../src/api/board.js';
import type { WorkspaceContextItem, WorkspaceContextKind } from '../src/api/context.js';
import {
  BOARD_ID_PATTERN,
  applyBoardChangeSet,
  applyBoardOps,
  defaultBoardSettings,
  emptyBoardChangeSet,
  emptyBoardContent,
  emptyBoardDocument,
  emptyBoardSyncLedger,
  isEmptyBoardChangeSet,
  stableBoardId,
  type BoardApplyContext,
  type BoardApplyOutcome,
} from '../src/board/index.js';

const USER: BoardActor = { kind: 'user', clientId: 'tab-1' };
const SEED: BoardActor = { kind: 'user' };

function stamps(rev = 1) {
  return { createdAt: 100, updatedAt: 100, createdBy: SEED, updatedBy: SEED, rev };
}

function makeCtx(overrides: Partial<BoardApplyContext> = {}): BoardApplyContext {
  let counter = 0;
  return {
    baseRevision: 5,
    nextRevision: 6,
    actor: USER,
    now: 1_000,
    newId: (prefix) => `${prefix}_new${(counter += 1)}`,
    checkConflicts: true,
    ...overrides,
  };
}

function baseContent(): BoardContent {
  return {
    settings: defaultBoardSettings(),
    nodes: [
      { id: 'fr1', kind: 'frame', x: 0, y: 0, w: 400, h: 300, ref: { path: 'index.html' }, device: 'desktop', ...stamps() },
      { id: 'fr2', kind: 'frame', x: 500, y: 0, w: 400, h: 300, ref: { path: 'about.html' }, device: 'desktop', ...stamps() },
      { id: 'no1', kind: 'note', x: 0, y: 400, w: 280, h: 220, text: 'hi', color: 'yellow', ...stamps() },
      { id: 'gr1', kind: 'group', x: 1000, y: 0, w: 600, h: 400, role: 'section', layout: 'free', ...stamps() },
      { id: 'im1', kind: 'image', x: 1024, y: 52, w: 200, h: 200, parentId: 'gr1', ref: { path: 'a.png' }, ...stamps() },
      {
        id: 'gen1', kind: 'generator', x: 2000, y: 0, w: 320, h: 272, version: 1, surface: 'image', prompt: 'cat',
        model: null, params: { aspect: '1:1', count: 2 }, runs: [], ...stamps(),
      },
    ],
    edges: [
      { id: 'ed1', kind: 'reference', from: 'no1', to: 'gen1', createdAt: 100, createdBy: SEED, updatedBy: SEED, rev: 1 },
    ],
  };
}

/** A variants row group (auto layout) with two children laid out by the rules of spec 04 §4.4.4. */
function rowGroupContent(role: 'variants' | 'turn' = 'variants'): BoardContent {
  return {
    settings: defaultBoardSettings(),
    nodes: [
      { id: 'grow', kind: 'group', x: 0, y: 0, w: 896, h: 376, role, layout: 'row', ...stamps() },
      {
        id: 'va1', kind: 'frame', x: 24, y: 52, w: 400, h: 300, parentId: 'grow', variantLabel: 'a',
        ref: { path: 'x.variant-a.html' }, device: 'desktop', ...stamps(),
      },
      {
        id: 'vb1', kind: 'frame', x: role === 'variants' ? 472 : 504, y: 52, w: 400, h: 300, parentId: 'grow', variantLabel: 'b',
        ref: { path: 'x.variant-b.html' }, device: 'desktop', ...stamps(),
      },
    ],
    edges: [],
  };
}

function expectOk(outcome: BoardApplyOutcome): Extract<BoardApplyOutcome, { ok: true }> {
  if (!outcome.ok) throw new Error(`expected ok, got ${JSON.stringify(outcome)}`);
  return outcome;
}

function stripStamps(content: BoardContent): unknown {
  return {
    title: content.title,
    settings: content.settings,
    nodes: content.nodes.map(({ rev: _rev, updatedAt: _updatedAt, updatedBy: _updatedBy, ...rest }) => rest),
    edges: content.edges.map(({ rev: _rev, updatedBy: _updatedBy, ...rest }) => rest),
  };
}

function nodeById(content: BoardContent, id: string): BoardNode {
  const node = content.nodes.find((entry) => entry.id === id);
  if (!node) throw new Error(`node ${id} missing`);
  return node;
}

/** Forward apply → undo with the inverse → redo with the undo's inverse; checks the change set replays too. */
function roundTrip(base: BoardContent, ops: BoardOp[], ctx: BoardApplyContext = makeCtx()) {
  const before = JSON.stringify(base);
  const forward = expectOk(applyBoardOps(base, ops, ctx));
  expect(JSON.stringify(base)).toBe(before);
  expect(forward.inverse[0]?.op).toBe('restore');

  const undo = expectOk(applyBoardOps(
    forward.content,
    forward.inverse,
    makeCtx({ baseRevision: ctx.nextRevision, nextRevision: ctx.nextRevision + 1, now: ctx.now + 1 }),
  ));
  expect(undo.content.nodes.map((node) => node.id)).toEqual(base.nodes.map((node) => node.id));
  expect(stripStamps(undo.content)).toEqual(stripStamps(base));

  const redo = expectOk(applyBoardOps(
    undo.content,
    undo.inverse,
    makeCtx({ baseRevision: ctx.nextRevision + 1, nextRevision: ctx.nextRevision + 2, now: ctx.now + 2 }),
  ));
  expect(redo.content.nodes.map((node) => node.id)).toEqual(forward.content.nodes.map((node) => node.id));
  expect(stripStamps(redo.content)).toEqual(stripStamps(forward.content));

  const doc = { ...emptyBoardDocument('p1'), ...base, revision: ctx.nextRevision - 1 };
  const replayed = applyBoardChangeSet(doc, forward.changes);
  expect(replayed.nodes).toEqual(forward.content.nodes);
  expect(replayed.edges).toEqual(forward.content.edges);
  expect(replayed.title).toEqual(forward.content.title);
  expect(replayed.settings).toEqual(forward.content.settings);
  expect(replayed.revision).toBe(ctx.nextRevision);
  return forward;
}

describe('stableBoardId', () => {
  it('derives a deterministic prefixed id of 16 base36 chars', () => {
    const id = stableBoardId('n', 'path:index.html');
    expect(id).toMatch(/^n_[0-9a-z]{16}$/);
    expect(id).toMatch(BOARD_ID_PATTERN);
    expect(stableBoardId('n', 'path:index.html')).toBe(id);
    expect(stableBoardId('n', 'path:about.html')).not.toBe(id);
    expect(stableBoardId('e', 'lineage:n_a:n_b')).toMatch(/^e_[0-9a-z]{16}$/);
    expect(stableBoardId('n', '')).toMatch(/^n_[0-9a-z]{16}$/);
    // Stored boards depend on these exact values: changing the algorithm duplicates derived nodes.
    expect(id).toBe('n_j0qo9vrgcmpkunk7');
    expect(stableBoardId('e', 'lineage:a:b')).toBe('e_lm9abcbmjgeug9y8');
  });

  it('keeps the planner seeds collision-free on a realistic set', () => {
    const seeds = Array.from({ length: 3000 }, (_, index) => `path:pages/page-${index}.html`);
    expect(new Set(seeds.map((seed) => stableBoardId('n', seed))).size).toBe(seeds.length);
  });
});

describe('empty values', () => {
  it('matches the storage defaults of spec 04 §4.2', () => {
    expect(defaultBoardSettings()).toEqual({ background: 'dots', autoPlace: true });
    expect(emptyBoardContent()).toEqual({ settings: { background: 'dots', autoPlace: true }, nodes: [], edges: [] });
    expect(emptyBoardDocument('p1')).toEqual({
      schemaVersion: 1, projectId: 'p1', revision: 0, updatedAt: 0, updatedBy: null, viewport: null,
      settings: { background: 'dots', autoPlace: true }, nodes: [], edges: [],
    });
    expect(emptyBoardSyncLedger()).toEqual({ version: 1, seededAt: null, cursor: 0, turns: {}, mediaTasks: {}, dismissed: {} });
  });
});

describe('applyBoardOps: every op round-trips through its inverse', () => {
  it('add (auto placement below the content, kind defaults, stamps)', () => {
    const out = roundTrip(baseContent(), [{ op: 'add', node: { kind: 'note', text: 'new' } }]);
    expect(out.results).toEqual([{ index: 0, status: 'applied', ids: ['n_new1'] }]);
    expect(out.content.nodes.at(-1)).toEqual({
      id: 'n_new1', kind: 'note', x: 0, y: 780, w: 280, h: 220, text: 'new', color: 'yellow',
      createdAt: 1_000, updatedAt: 1_000, createdBy: USER, updatedBy: USER, rev: 6,
    });
    expect(out.changes).toMatchObject({ fromRevision: 5, toRevision: 6, removeNodeIds: [], upsertEdges: [], removeEdgeIds: [] });
    expect(out.changes.upsertNodes.map((node) => node.id)).toEqual(['n_new1']);
    expect(out.changes.order).toBeUndefined();
    expect(out.inverse).toEqual([{ op: 'restore', nodes: [], edges: [], removeNodeIds: ['n_new1'], removeEdgeIds: [], expectRev: { n_new1: 6 } }]);
    expect(out.touchedNodeIds).toEqual(['n_new1']);
  });

  it('add with explicit position, size and placement modes', () => {
    const out = roundTrip(baseContent(), [
      { op: 'add', node: { kind: 'frame', ref: { path: 'm.html' }, device: 'mobile', id: 'frm' } , placement: { mode: 'near', nodeId: 'fr2' } },
      { op: 'add', node: { kind: 'shape', shape: 'rect', id: 'sh1', x: -500, y: -500, w: 50, h: 60 } },
    ]);
    // Right of fr2 collides with gr1 (1000..1600 × 0..400), so the walk moves below it: y = 400 + 80.
    expect(nodeById(out.content, 'frm')).toMatchObject({ x: 980, y: 480, w: 390, h: 844, device: 'mobile' });
    expect(nodeById(out.content, 'sh1')).toMatchObject({ x: -500, y: -500, w: 50, h: 60 });
  });

  it('update (set, clear with null, nullable refs keep null)', () => {
    const out = roundTrip(baseContent(), [
      { op: 'update', id: 'fr1', patch: { title: 'Hero', x: 10, scrollY: 120 } },
      { op: 'update', id: 'im1', patch: { ref: null, pending: { mediaTaskId: 't1', status: 'running' } } },
    ]);
    expect(nodeById(out.content, 'fr1')).toMatchObject({ title: 'Hero', x: 10, scrollY: 120, rev: 6, updatedBy: USER, createdBy: SEED });
    expect(nodeById(out.content, 'im1')).toMatchObject({ ref: null, pending: { mediaTaskId: 't1', status: 'running' } });

    const cleared = expectOk(applyBoardOps(out.content, [{ op: 'update', id: 'fr1', patch: { title: null, scrollY: null } }], makeCtx({ baseRevision: 6, nextRevision: 7 })));
    expect(nodeById(cleared.content, 'fr1')).not.toHaveProperty('title');
    expect(nodeById(cleared.content, 'fr1')).not.toHaveProperty('scrollY');
  });

  it('move (groups carry their descendants unless they are moved explicitly)', () => {
    const out = roundTrip(baseContent(), [{ op: 'move', moves: [{ id: 'gr1', x: 1100, y: 50 }] }]);
    expect(nodeById(out.content, 'gr1')).toMatchObject({ x: 1100, y: 50 });
    expect(nodeById(out.content, 'im1')).toMatchObject({ x: 1124, y: 102 });

    const explicit = roundTrip(baseContent(), [{ op: 'move', moves: [{ id: 'gr1', x: 1100, y: 50 }, { id: 'im1', x: 5, y: 5 }] }]);
    expect(nodeById(explicit.content, 'im1')).toMatchObject({ x: 5, y: 5 });
  });

  it('remove (edges go too, removed file paths are reported, z-order is restored)', () => {
    const out = roundTrip(baseContent(), [{ op: 'remove', ids: ['fr1', 'no1'] }]);
    expect(out.content.nodes.map((node) => node.id)).toEqual(['fr2', 'gr1', 'im1', 'gen1']);
    expect(out.content.edges).toEqual([]);
    expect(out.removedPaths).toEqual(['index.html']);
    expect(out.changes.removeNodeIds).toEqual(['fr1', 'no1']);
    expect(out.changes.removeEdgeIds).toEqual(['ed1']);
    const restore = out.inverse[0] as Extract<BoardOp, { op: 'restore' }>;
    expect(restore.order).toEqual(['fr1', 'fr2', 'no1', 'gr1', 'im1', 'gen1']);
    expect(restore.edges.map((edge) => edge.id)).toEqual(['ed1']);
  });

  it('remove of a group re-parents children, or removes them with cascade', () => {
    const reparented = roundTrip(baseContent(), [{ op: 'remove', ids: ['gr1'] }]);
    expect(nodeById(reparented.content, 'im1')).not.toHaveProperty('parentId');
    expect(nodeById(reparented.content, 'im1')).toMatchObject({ x: 1024, y: 52 });
    expect(reparented.removedPaths).toEqual([]);

    const cascaded = roundTrip(baseContent(), [{ op: 'remove', ids: ['gr1'], cascade: true }]);
    expect(cascaded.content.nodes.map((node) => node.id)).toEqual(['fr1', 'fr2', 'no1', 'gen1']);
    expect(cascaded.removedPaths).toEqual(['a.png']);
    expect(cascaded.results[0]).toEqual({ index: 0, status: 'applied', ids: ['gr1', 'im1'] });
  });

  it('remove drops non-section groups that lose their last child, keeps sections', () => {
    const content = baseContent();
    content.nodes.push(
      { id: 'gv1', kind: 'group', x: 0, y: 2000, w: 448, h: 376, role: 'variants', layout: 'free', ...stamps() },
      { id: 'vv1', kind: 'frame', x: 24, y: 2052, w: 400, h: 300, parentId: 'gv1', ref: { path: 'v.variant-a.html' }, ...stamps() },
    );
    const out = roundTrip(content, [{ op: 'remove', ids: ['vv1'] }]);
    expect(out.results[0]).toEqual({ index: 0, status: 'applied', ids: ['vv1', 'gv1'] });
    expect(out.content.nodes.some((node) => node.id === 'gv1')).toBe(false);

    const section = roundTrip(baseContent(), [{ op: 'remove', ids: ['im1'] }]);
    expect(nodeById(section.content, 'gr1').kind).toBe('group');
  });

  it('connect and disconnect', () => {
    const out = roundTrip(baseContent(), [
      { op: 'connect', edge: { kind: 'reference', from: 'fr1', to: 'gen1' } },
      { op: 'connect', edge: { kind: 'lineage', from: 'fr1', to: 'fr2', label: 'v2' } },
    ]);
    expect(out.content.edges.map((edge) => edge.id)).toEqual(['ed1', 'e_new1', 'e_new2']);
    expect(out.content.edges[1]).toEqual({
      id: 'e_new1', kind: 'reference', from: 'fr1', to: 'gen1', createdAt: 1_000, createdBy: USER, updatedBy: USER, rev: 6,
    });
    const gone = roundTrip(baseContent(), [{ op: 'disconnect', ids: ['ed1'] }]);
    expect(gone.content.edges).toEqual([]);
  });

  it('reorder (front, back, index) changes z-order only', () => {
    const front = roundTrip(baseContent(), [{ op: 'reorder', id: 'fr1', to: 'front' }]);
    expect(front.content.nodes.map((node) => node.id)).toEqual(['fr2', 'no1', 'gr1', 'im1', 'gen1', 'fr1']);
    expect(front.changes.order).toEqual(['fr2', 'no1', 'gr1', 'im1', 'gen1', 'fr1']);
    expect(nodeById(front.content, 'fr1').rev).toBe(6);
    const back = roundTrip(baseContent(), [{ op: 'reorder', id: 'gen1', to: 'back' }]);
    expect(back.content.nodes[0]!.id).toBe('gen1');
    const middle = roundTrip(baseContent(), [{ op: 'reorder', id: 'fr1', to: 2 }]);
    expect(middle.content.nodes.map((node) => node.id)).toEqual(['fr2', 'no1', 'fr1', 'gr1', 'im1', 'gen1']);
  });

  it('group (wrap rect, inserted before the first member, members re-parented)', () => {
    const out = roundTrip(baseContent(), [{ op: 'group', ids: ['fr2', 'fr1'], group: { role: 'turn', title: 'Turn 1' } }]);
    expect(out.content.nodes.map((node) => node.id)).toEqual(['n_new1', 'fr1', 'fr2', 'no1', 'gr1', 'im1', 'gen1']);
    expect(nodeById(out.content, 'n_new1')).toMatchObject({ kind: 'group', role: 'turn', title: 'Turn 1', layout: 'free', x: -24, y: -52, w: 948, h: 376 });
    expect(nodeById(out.content, 'fr1').parentId).toBe('n_new1');
    expect(nodeById(out.content, 'fr2').parentId).toBe('n_new1');
    expect(out.changes.order).toEqual(['n_new1', 'fr1', 'fr2', 'no1', 'gr1', 'im1', 'gen1']);
  });

  it('ungroup (children take the group parent, positions unchanged)', () => {
    const out = roundTrip(baseContent(), [{ op: 'ungroup', id: 'gr1' }]);
    expect(out.content.nodes.map((node) => node.id)).toEqual(['fr1', 'fr2', 'no1', 'im1', 'gen1']);
    expect(nodeById(out.content, 'im1')).not.toHaveProperty('parentId');
    expect(nodeById(out.content, 'im1')).toMatchObject({ x: 1024, y: 52 });
  });

  it('layout (row of explicit ids, tidy of everything, group refit)', () => {
    const row = roundTrip(baseContent(), [{ op: 'layout', target: { ids: ['fr1', 'fr2', 'no1'] }, mode: 'row' }]);
    expect(nodeById(row.content, 'fr1')).toMatchObject({ x: 0, y: 0 });
    expect(nodeById(row.content, 'fr2')).toMatchObject({ x: 480, y: 0 });
    expect(nodeById(row.content, 'no1')).toMatchObject({ x: 960, y: 0 });

    const tidy = roundTrip(baseContent(), [{ op: 'layout', target: { all: true }, mode: 'tidy' }]);
    expect(nodeById(tidy.content, 'fr1')).toMatchObject({ x: 0, y: 0 });
    expect(nodeById(tidy.content, 'fr2')).toMatchObject({ x: 0, y: 460 });
    expect(nodeById(tidy.content, 'gr1')).toMatchObject({ x: 0, y: 920 });
    expect(nodeById(tidy.content, 'im1')).toMatchObject({ x: 24, y: 972 });

    const grouped = roundTrip(baseContent(), [{ op: 'layout', target: { groupId: 'gr1' }, mode: 'row' }]);
    expect(nodeById(grouped.content, 'gr1')).toMatchObject({ x: 1000, y: 0, w: 248, h: 276 });
  });

  it('set-meta (title and settings; the inverse adds a set-meta after the restore)', () => {
    const out = roundTrip(baseContent(), [{ op: 'set-meta', title: 'Launch', settings: { background: 'lines' } }]);
    expect(out.content.title).toBe('Launch');
    expect(out.changes.meta).toEqual({ title: 'Launch', settings: { background: 'lines', autoPlace: true } });
    expect(out.inverse[1]).toEqual({ op: 'set-meta', title: null, settings: { background: 'dots', autoPlace: true } });
  });

  it('restore (snapshots upserted, ids removed, order applied)', () => {
    const base = baseContent();
    const out = roundTrip(base, [{
      op: 'restore',
      nodes: [{ ...base.nodes[0]!, title: 'Restored' }],
      edges: [],
      removeNodeIds: ['no1'],
      removeEdgeIds: [],
      order: ['gen1', 'fr1'],
    }]);
    expect(out.content.nodes.map((node) => node.id)).toEqual(['gen1', 'fr1', 'fr2', 'gr1', 'im1']);
    expect(nodeById(out.content, 'fr1')).toMatchObject({ title: 'Restored', rev: 6, createdAt: 100 });
  });
});

describe('applyBoardOps: results, identity and purity', () => {
  it('keeps unchanged nodes by identity and does not mutate the input', () => {
    const base = baseContent();
    const before = JSON.stringify(base);
    const out = expectOk(applyBoardOps(base, [{ op: 'update', id: 'fr1', patch: { title: 'x' } }], makeCtx()));
    expect(JSON.stringify(base)).toBe(before);
    expect(out.content.nodes[1]).toBe(base.nodes[1]);
    expect(out.content.edges[0]).toBe(base.edges[0]);
    expect(out.content.nodes[0]).not.toBe(base.nodes[0]);
  });

  it('reports noop and net-empty batches without a change set or inverse', () => {
    const base = baseContent();
    const noop = expectOk(applyBoardOps(base, [{ op: 'update', id: 'fr1', patch: { x: 0 } }], makeCtx()));
    expect(noop.results).toEqual([{ index: 0, status: 'skipped', reason: 'noop', ids: ['fr1'] }]);
    expect(noop.content).toBe(base);
    expect(noop.inverse).toEqual([]);
    expect(noop.changes).toEqual(emptyBoardChangeSet(5, 5));

    const net = expectOk(applyBoardOps(base, [
      { op: 'update', id: 'fr1', patch: { title: 'Hero' } },
      { op: 'update', id: 'fr1', patch: { title: null } },
    ], makeCtx()));
    expect(net.results.map((result) => result.status)).toEqual(['applied', 'applied']);
    expect(isEmptyBoardChangeSet(net.changes)).toBe(true);
    expect(net.inverse).toEqual([]);

    const exists = expectOk(applyBoardOps(base, [{ op: 'add', node: { id: 'no1', kind: 'note', text: 'x' }, ifAbsent: true }], makeCtx()));
    expect(exists.results).toEqual([{ index: 0, status: 'skipped', reason: 'exists', ids: ['no1'] }]);
  });
});

describe('applyBoardOps: conflict rule (spec 04 §4.4.2)', () => {
  it('expectRev mismatch → stale-entity', () => {
    expect(applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: { title: 'x' }, expectRev: 0 }], makeCtx())).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'fr1', reason: 'stale-entity', currentRev: 1 }],
    });
    expectOk(applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: { title: 'x' }, expectRev: 1 }], makeCtx()));
  });

  it('rev > baseRevision without expectRev → stale-entity; expectRev overrides', () => {
    const content = baseContent();
    content.nodes[1] = { ...content.nodes[1]!, rev: 7 };
    const ctx = () => makeCtx({ baseRevision: 5, nextRevision: 8 });
    expect(applyBoardOps(content, [{ op: 'move', moves: [{ id: 'fr2', x: 1, y: 1 }] }], ctx())).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'fr2', reason: 'stale-entity', currentRev: 7 }],
    });
    expectOk(applyBoardOps(content, [{ op: 'move', moves: [{ id: 'fr2', x: 1, y: 1 }], expectRev: { fr2: 7 } }], ctx()));
  });

  it('missing targets: update/move/reorder/ungroup conflict, remove/disconnect skip', () => {
    for (const op of [
      { op: 'update', id: 'nope1', patch: { title: 'x' } },
      { op: 'move', moves: [{ id: 'nope1', x: 0, y: 0 }] },
      { op: 'reorder', id: 'nope1', to: 'front' },
      { op: 'ungroup', id: 'nope1' },
    ] satisfies BoardOp[]) {
      expect(applyBoardOps(baseContent(), [op], makeCtx())).toEqual({
        ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'nope1', reason: 'missing-entity' }],
      });
    }
    const skipped = expectOk(applyBoardOps(baseContent(), [{ op: 'remove', ids: ['nope1'] }, { op: 'disconnect', ids: ['nope2'] }], makeCtx()));
    expect(skipped.results).toEqual([
      { index: 0, status: 'skipped', reason: 'missing', ids: [] },
      { index: 1, status: 'skipped', reason: 'missing', ids: [] },
    ]);
  });

  it('add/connect with an existing id: conflict exists, skipped with ifAbsent', () => {
    expect(applyBoardOps(baseContent(), [{ op: 'add', node: { id: 'fr1', kind: 'note', text: 'x' } }], makeCtx())).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'fr1', reason: 'exists' }],
    });
    expect(applyBoardOps(baseContent(), [{ op: 'connect', edge: { id: 'ed1', kind: 'lineage', from: 'fr1', to: 'fr2' } }], makeCtx())).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'ed1', reason: 'exists' }],
    });
    // Same (from, to, kind) as an existing edge counts as existing too.
    expect(applyBoardOps(baseContent(), [{ op: 'connect', edge: { kind: 'reference', from: 'no1', to: 'gen1' } }], makeCtx())).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: 0, id: 'ed1', reason: 'exists' }],
    });
    const skipped = expectOk(applyBoardOps(baseContent(), [
      { op: 'connect', edge: { kind: 'reference', from: 'no1', to: 'gen1' }, ifAbsent: true },
      { op: 'add', node: { id: 'fr1', kind: 'note', text: 'x' }, ifAbsent: true },
    ], makeCtx()));
    expect(skipped.results.map((result) => [result.reason, result.ids])).toEqual([['exists', ['ed1']], ['exists', ['fr1']]]);
  });

  it('entities created earlier in the same batch are exempt', () => {
    const out = expectOk(applyBoardOps(baseContent(), [
      { op: 'add', node: { id: 'nn1', kind: 'note', text: 'a', x: 0, y: 0 } },
      { op: 'update', id: 'nn1', patch: { text: 'b' }, expectRev: 0 },
      { op: 'move', moves: [{ id: 'nn1', x: 10, y: 10 }] },
      { op: 'connect', edge: { id: 'en1', kind: 'reference', from: 'nn1', to: 'gen1' } },
      { op: 'disconnect', ids: ['en1'] },
    ], makeCtx()));
    expect(nodeById(out.content, 'nn1')).toMatchObject({ text: 'b', x: 10, y: 10 });
    expect(out.content.edges.map((edge) => edge.id)).toEqual(['ed1']);
  });

  it('baseRevision ahead of the board → stale-board for the whole request', () => {
    expect(applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: { title: 'x' } }], makeCtx({ baseRevision: 9 }))).toEqual({
      ok: false, reason: 'conflict', conflicts: [{ opIndex: -1, id: '*', reason: 'stale-board', currentRev: 5 }],
    });
  });

  it('is atomic: one conflict rejects the whole batch and collects every conflict', () => {
    const out = applyBoardOps(baseContent(), [
      { op: 'update', id: 'fr1', patch: { title: 'ok' } },
      { op: 'update', id: 'fr2', patch: { title: 'x' }, expectRev: 3 },
      { op: 'remove', ids: ['no1'], expectRev: { no1: 4 } },
    ], makeCtx());
    expect(out).toEqual({
      ok: false,
      reason: 'conflict',
      conflicts: [
        { opIndex: 1, id: 'fr2', reason: 'stale-entity', currentRev: 1 },
        { opIndex: 2, id: 'no1', reason: 'stale-entity', currentRev: 1 },
      ],
    });
  });

  it('optimistic/sync applies (checkConflicts:false) skip instead of conflicting', () => {
    const out = expectOk(applyBoardOps(baseContent(), [
      { op: 'update', id: 'fr1', patch: { title: 'x' }, expectRev: 0 },
      { op: 'update', id: 'nope1', patch: { title: 'x' } },
      { op: 'add', node: { id: 'fr2', kind: 'note', text: 'x' } },
    ], makeCtx({ checkConflicts: false, baseRevision: 99 })));
    expect(out.results.map((result) => [result.status, result.reason])).toEqual([
      ['applied', undefined],
      ['skipped', 'missing'],
      ['skipped', 'exists'],
    ]);
  });
});

describe('applyBoardOps: server-managed fields and validation', () => {
  it('rejects a missing patch from user actors, accepts it from sync', () => {
    const rejected = applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: { missing: { since: 5 } } }], makeCtx());
    expect(rejected.ok).toBe(false);
    if (!rejected.ok && rejected.reason === 'invalid') {
      expect(rejected.issues).toEqual([expect.objectContaining({ path: 'ops[0].patch.missing', code: 'forbidden-field' })]);
    } else {
      throw new Error('expected invalid');
    }
    const synced = expectOk(applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: { missing: { since: 5 } } }], makeCtx({ actor: { kind: 'sync' }, checkConflicts: false })));
    expect(nodeById(synced.content, 'fr1').missing).toEqual({ since: 5 });
  });

  it('rejects patch keys outside the kind and invalid values', () => {
    for (const patch of [{ url: 'https://x.dev' }, { text: 'x' }, { migratedFrom: undefined, version: 2 }] as const) {
      const out = applyBoardOps(baseContent(), [{ op: 'update', id: 'fr1', patch: patch as never }], makeCtx());
      expect(out).toMatchObject({ ok: false, reason: 'invalid' });
    }
    const tooLong = applyBoardOps(baseContent(), [{ op: 'update', id: 'no1', patch: { text: 'x'.repeat(BOARD_LIMITS.maxNoteTextLength + 1) } }], makeCtx());
    expect(tooLong).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'too-long' })] });
  });

  it('checks parent changes: groups only, no cycles, depth ≤ 2', () => {
    const content = baseContent();
    content.nodes.push(
      { id: 'gin', kind: 'group', x: 1050, y: 300, w: 200, h: 90, parentId: 'gr1', role: 'turn', layout: 'free', ...stamps() },
      { id: 'gtp', kind: 'group', x: 3000, y: 0, w: 200, h: 200, role: 'turn', layout: 'free', ...stamps() },
    );
    const notGroup = applyBoardOps(content, [{ op: 'update', id: 'no1', patch: { parentId: 'fr1' } }], makeCtx());
    expect(notGroup).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'parent-not-group' })] });
    const cycle = applyBoardOps(content, [{ op: 'update', id: 'gr1', patch: { parentId: 'gin' } }], makeCtx());
    expect(cycle).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'parent-cycle' })] });
    const tooDeep = applyBoardOps(content, [{ op: 'update', id: 'gtp', patch: { parentId: 'gin' } }], makeCtx());
    expect(tooDeep).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'group-depth' })] });
    const nested = expectOk(applyBoardOps(content, [{ op: 'update', id: 'no1', patch: { parentId: 'gin' } }], makeCtx()));
    expect(nodeById(nested.content, 'no1').parentId).toBe('gin');
    const groupMixed = applyBoardOps(content, [{ op: 'group', ids: ['im1', 'no1'], group: { role: 'turn' } }], makeCtx());
    expect(groupMixed).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'group-mixed-parents' })] });
    const groupTooDeep = applyBoardOps(content, [{ op: 'group', ids: ['gr1', 'fr1'], group: { role: 'turn' } }], makeCtx());
    expect(groupTooDeep).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'group-depth' })] });
  });

  it('rejects edges that break the endpoint rules', () => {
    const out = applyBoardOps(baseContent(), [{ op: 'connect', edge: { kind: 'reference', from: 'gen1', to: 'fr1' } }], makeCtx());
    expect(out).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'reference-target-not-generator' })] });
    const group = applyBoardOps(baseContent(), [{ op: 'connect', edge: { kind: 'lineage', from: 'gr1', to: 'fr1' } }], makeCtx());
    expect(group).toMatchObject({ ok: false, reason: 'invalid', issues: [expect.objectContaining({ code: 'group-endpoint' })] });
  });
});

describe('applyBoardOps: auto-layout groups (row/grid)', () => {
  it('re-lays out a row group when a child is resized', () => {
    const out = roundTrip(rowGroupContent(), [{ op: 'update', id: 'va1', patch: { w: 600 } }]);
    expect(nodeById(out.content, 'va1')).toMatchObject({ x: 24, y: 52, w: 600 });
    expect(nodeById(out.content, 'vb1')).toMatchObject({ x: 672, y: 52 });
    expect(nodeById(out.content, 'grow')).toMatchObject({ x: 0, y: 0, w: 1096, h: 376 });
  });

  it('appends added children, sorted by variant label in variants rows', () => {
    const out = roundTrip(rowGroupContent(), [
      { op: 'add', node: { id: 'vc1', kind: 'frame', ref: { path: 'x.variant-c.html' }, parentId: 'grow', variantLabel: 'c', w: 400, h: 300 } },
    ]);
    expect(nodeById(out.content, 'vc1')).toMatchObject({ x: 920, y: 52 });
    expect(nodeById(out.content, 'grow')).toMatchObject({ w: 1344, h: 376 });

    const turn = roundTrip(rowGroupContent('turn'), [
      { op: 'add', node: { id: 'nt1', kind: 'note', text: 'later', parentId: 'grow' } },
    ]);
    expect(nodeById(turn.content, 'nt1')).toMatchObject({ x: 984, y: 52 });
    expect(nodeById(turn.content, 'grow')).toMatchObject({ w: 1288, h: 376 });
  });

  it('snaps a dragged child back unless the batch switches the group to free (any op order)', () => {
    const snapped = expectOk(applyBoardOps(rowGroupContent(), [{ op: 'move', moves: [{ id: 'va1', x: 5, y: 5 }] }], makeCtx()));
    expect(nodeById(snapped.content, 'va1')).toMatchObject({ x: 24, y: 52 });
    expect(isEmptyBoardChangeSet(snapped.changes)).toBe(true);

    for (const ops of [
      [{ op: 'move', moves: [{ id: 'va1', x: 5, y: 5 }] }, { op: 'update', id: 'grow', patch: { layout: 'free' } }],
      [{ op: 'update', id: 'grow', patch: { layout: 'free' } }, { op: 'move', moves: [{ id: 'va1', x: 5, y: 5 }] }],
    ] satisfies BoardOp[][]) {
      const out = roundTrip(rowGroupContent(), ops);
      expect(nodeById(out.content, 'va1')).toMatchObject({ x: 5, y: 5 });
      expect(nodeById(out.content, 'grow')).toMatchObject({ layout: 'free', w: 896 });
    }
  });

  it('closes the gap when a child is removed and refits', () => {
    const out = roundTrip(rowGroupContent(), [{ op: 'remove', ids: ['va1'] }]);
    expect(nodeById(out.content, 'vb1')).toMatchObject({ x: 24, y: 52 });
    expect(nodeById(out.content, 'grow')).toMatchObject({ w: 448, h: 376 });
  });

  it('lays out grid groups in reading order', () => {
    const content = rowGroupContent('turn');
    content.nodes[0] = { ...content.nodes[0]!, layout: 'grid' } as BoardNode;
    const out = roundTrip(content, [
      { op: 'add', node: { id: 'gc1', kind: 'note', text: 'c', parentId: 'grow', w: 400, h: 300 } },
      { op: 'add', node: { id: 'gd1', kind: 'note', text: 'd', parentId: 'grow', w: 400, h: 300 } },
    ]);
    expect(nodeById(out.content, 'va1')).toMatchObject({ x: 24, y: 52 });
    expect(nodeById(out.content, 'vb1')).toMatchObject({ x: 504, y: 52 });
    expect(nodeById(out.content, 'gc1')).toMatchObject({ x: 24, y: 432 });
    expect(nodeById(out.content, 'gd1')).toMatchObject({ x: 504, y: 432 });
  });
});

describe('applyBoardOps: limits → reason limit', () => {
  it('maxOpsPerPatch', () => {
    const ops: BoardOp[] = Array.from({ length: BOARD_LIMITS.maxOpsPerPatch + 1 }, () => ({ op: 'set-meta', title: 'x' }));
    expect(applyBoardOps(baseContent(), ops, makeCtx())).toEqual({
      ok: false, reason: 'limit', details: { kind: 'board-limit', limit: 'maxOpsPerPatch', max: 200, actual: 201 },
    });
  });

  it('maxNodes', () => {
    const content: BoardContent = {
      settings: defaultBoardSettings(),
      nodes: Array.from({ length: BOARD_LIMITS.maxNodes }, (_, index) => ({
        id: `nt${index}`, kind: 'note' as const, x: (index % 50) * 300, y: Math.floor(index / 50) * 300, w: 280, h: 220, text: '', ...stamps(),
      })),
      edges: [],
    };
    expect(applyBoardOps(content, [{ op: 'add', node: { kind: 'note', text: 'one more' } }], makeCtx())).toEqual({
      ok: false, reason: 'limit', details: { kind: 'board-limit', limit: 'maxNodes', max: 2000, actual: 2001 },
    });
  });

  it('maxDocumentBytes', () => {
    const text = 'x'.repeat(BOARD_LIMITS.maxNoteTextLength);
    const content: BoardContent = {
      settings: defaultBoardSettings(),
      nodes: Array.from({ length: 150 }, (_, index) => ({
        id: `nt${index}`, kind: 'note' as const, x: index * 300, y: 0, w: 280, h: 220, text, ...stamps(),
      })),
      edges: [],
    };
    const ops: BoardOp[] = Array.from({ length: 10 }, () => ({ op: 'add', node: { kind: 'note', text } }));
    const out = applyBoardOps(content, ops, makeCtx());
    expect(out).toMatchObject({ ok: false, reason: 'limit', details: { kind: 'board-limit', limit: 'maxDocumentBytes', max: BOARD_LIMITS.maxDocumentBytes } });
  });
});

describe('applyBoardChangeSet', () => {
  it('removes, replaces in place, appends, reorders and applies meta', () => {
    const doc = { ...emptyBoardDocument('p1'), ...baseContent(), title: 'Old', revision: 5 };
    const replaced = { ...doc.nodes[1]!, title: 'About' } as BoardNode;
    const added = { id: 'nn9', kind: 'note', x: 0, y: 0, w: 10, h: 10, text: '', ...stamps(6) } as BoardNode;
    const next = applyBoardChangeSet(doc, {
      fromRevision: 5,
      toRevision: 6,
      upsertNodes: [replaced, added],
      removeNodeIds: ['fr1'],
      upsertEdges: [],
      removeEdgeIds: ['ed1'],
      order: ['nn9'],
      meta: { title: null, settings: { background: 'blank', autoPlace: false } },
    });
    expect(next.nodes.map((node) => node.id)).toEqual(['nn9', 'fr2', 'no1', 'gr1', 'im1', 'gen1']);
    expect(next.nodes[1]).toBe(replaced);
    expect(next.nodes[2]).toBe(doc.nodes[2]);
    expect(next.edges).toEqual([]);
    expect(next).not.toHaveProperty('title');
    expect(next.settings).toEqual({ background: 'blank', autoPlace: false });
    expect(next.revision).toBe(6);
    expect(next.projectId).toBe('p1');
  });

  it('treats an empty change set at the same revision as a no-op', () => {
    const doc = { ...emptyBoardDocument('p1'), revision: 3 };
    expect(isEmptyBoardChangeSet(emptyBoardChangeSet(3, 3))).toBe(true);
    expect(applyBoardChangeSet(doc, emptyBoardChangeSet(3, 3))).toBe(doc);
    expect(isEmptyBoardChangeSet({ ...emptyBoardChangeSet(3, 4), order: [] })).toBe(false);
  });
});

describe('board API paths and workspace context types', () => {
  it('encodes board API paths and types board-selection workspace context items', () => {
    expect(boardApiPath('p 1', '/sync')).toBe('/api/projects/p%201/board/sync');
    expect(boardCoverApiPath('p1', 'ab')).toBe('/api/projects/p1/board/covers/ab');
    expectTypeOf(BOARD_SELECTION_CONTEXT_KIND).toMatchTypeOf<WorkspaceContextKind>();
    expectTypeOf<WorkspaceContextItem['nodes']>().toEqualTypeOf<WorkspaceContextBoardNode[] | undefined>();
    expectTypeOf<'live-artifact'>().toMatchTypeOf<WorkspaceContextKind>();
  });
});
