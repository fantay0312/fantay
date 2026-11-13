import { describe, expect, it } from 'vitest';
import {
  applyBoardOps,
  emptyBoardContent,
  emptyBoardSyncLedger,
  stableBoardId,
  type BoardContent,
  type BoardGroupNode,
  type BoardNode,
  type BoardSyncLedger,
} from '@open-design/contracts';

import {
  BOARD_LEDGER_LIMITS,
  BOARD_SYNC_LOOKBACK_MS,
  applyBoardOpsInSlices,
  boardRefStatusKey,
  excerptBoardTurnPrompt,
  planBoardSync,
  trimBoardSyncLedger,
  type BoardPlannerInput,
  type BoardPlannerMediaTask,
  type BoardPlannerTurn,
  type BoardSyncPlan,
} from '../../../src/fantay/board/planner.js';

const NOW = 1_800_000_000_000;
const PROJECT = 'proj-planner';

function seededLedger(overrides: Partial<BoardSyncLedger> = {}): BoardSyncLedger {
  return { ...emptyBoardSyncLedger(), seededAt: NOW - 60_000, cursor: NOW - 120_000, ...overrides };
}

function plannerInput(overrides: Partial<BoardPlannerInput> = {}): BoardPlannerInput {
  return {
    projectId: PROJECT,
    now: NOW,
    content: emptyBoardContent(),
    ledger: seededLedger(),
    project: {},
    seedFiles: null,
    turns: [],
    mediaTasks: [],
    refStatuses: new Map(),
    identities: new Map(),
    snapshotCovers: new Map(),
    focus: null,
    ...overrides,
  };
}

function turn(messageId: string, paths: string[], overrides: Partial<BoardPlannerTurn> = {}): BoardPlannerTurn {
  return {
    messageId,
    conversationId: 'conv-1',
    runId: `run-${messageId}`,
    createdAt: NOW - 10_000,
    terminal: true,
    outputs: paths.map((path, index) => ({ path, mtime: NOW - 20_000 + index })),
    ...overrides,
  };
}

/** Applies a plan the way the service does (one atomic commit, sync actor, no conflict checks). */
function applyPlan(content: BoardContent, plan: BoardSyncPlan): BoardContent {
  expect(plan.rejected).toEqual([]);
  if (plan.ops.length === 0) return content;
  const outcome = applyBoardOpsInSlices(content, plan.ops, {
    baseRevision: 0,
    nextRevision: 1,
    actor: { kind: 'sync' },
    now: NOW,
    newId: () => {
      throw new Error('planner ops carry explicit ids');
    },
    checkConflicts: false,
  });
  if (!outcome.ok) throw new Error(`plan did not apply: ${JSON.stringify(outcome)}`);
  return outcome.content;
}

function plan(input: BoardPlannerInput): { plan: BoardSyncPlan; content: BoardContent } {
  const result = planBoardSync(input);
  return { plan: result, content: applyPlan(input.content, result) };
}

function byPath(content: BoardContent, path: string): BoardNode | undefined {
  return content.nodes.find((node) => {
    if ('ref' in node && node.ref && node.ref.path === path) return true;
    return node.kind === 'motion' && node.source.type === 'composition' && node.source.ref.path === path;
  });
}

function groups(content: BoardContent, role?: BoardGroupNode['role']): BoardGroupNode[] {
  return content.nodes.filter((node): node is BoardGroupNode => node.kind === 'group' && (role === undefined || node.role === role));
}

function childrenOf(content: BoardContent, groupId: string): BoardNode[] {
  return content.nodes.filter((node) => node.parentId === groupId);
}

describe('planBoardSync — P2 seeding', () => {
  it('seeds placeable root, designs/ and motion entries into one section group per kind', () => {
    const seedFiles = [
      { path: 'index.html', mtime: 10 },
      { path: 'about.html', mtime: 9 },
      { path: 'designs/poster.fig', mtime: 8 },
      { path: 'movie-studio.json', mtime: 7 },
      { path: 'motion-source/intro/index.html', mtime: 6 },
      { path: 'hero.png', mtime: 5 },
      { path: 'theme.mp3', mtime: 4 },
      { path: 'logo.svg', mtime: 99 },
      { path: 'pages/team.html', mtime: 99 },
      { path: 'motion-source/intro/frame.png', mtime: 99 },
      { path: 'README.md', mtime: 99 },
      { path: 'sketch-1.png', mtime: 99 },
    ];
    const { plan: result, content } = plan(plannerInput({ ledger: emptyBoardSyncLedger(), seedFiles }));
    const sections = groups(content, 'section');
    expect(sections.map((group) => group.sectionKind)).toEqual(['frame', 'design', 'motion', 'image', 'audio']);
    expect(sections.every((group) => group.layout === 'row')).toBe(true);
    const frameSection = sections.find((group) => group.sectionKind === 'frame')!;
    expect(frameSection.id).toBe(stableBoardId('n', 'section:frame'));
    expect(childrenOf(content, frameSection.id).map((node) => 'ref' in node && node.ref?.path)).toEqual(['index.html', 'about.html']);
    const motion = childrenOf(content, sections.find((group) => group.sectionKind === 'motion')!.id);
    expect(motion.map((node) => node.id)).toContain(stableBoardId('n', `movie:${PROJECT}`));
    expect(motion.some((node) => node.kind === 'motion' && node.source.type === 'composition')).toBe(true);
    for (const excluded of ['logo.svg', 'pages/team.html', 'motion-source/intro/frame.png', 'README.md', 'sketch-1.png']) {
      expect(byPath(content, excluded)).toBeUndefined();
    }
    expect(byPath(content, 'index.html')!.origin).toEqual({ source: 'seed' });
    expect(result.ledger.seededAt).toBe(NOW);
    expect(result.ledger.cursor).toBe(NOW - BOARD_SYNC_LOOKBACK_MS);
    expect(result.placements.filter((entry) => entry.status === 'created')).toHaveLength(7);
    // Children of a row section are laid out left to right inside the group.
    const [first, second] = childrenOf(content, frameSection.id);
    expect(first!.x).toBe(frameSection.x + 24);
    expect(second!.x).toBe(first!.x + first!.w + 80);
  });

  it('caps the seed at the 48 newest files and skips dismissed paths', () => {
    const seedFiles = Array.from({ length: 60 }, (_, index) => ({ path: `page-${String(index).padStart(2, '0')}.html`, mtime: index }));
    const { content } = plan(plannerInput({
      ledger: { ...emptyBoardSyncLedger(), dismissed: { 'page-59.html': NOW - 1 } },
      seedFiles,
    }));
    const frames = content.nodes.filter((node) => node.kind === 'frame');
    expect(frames).toHaveLength(48);
    expect(byPath(content, 'page-59.html')).toBeUndefined();
    expect(byPath(content, 'page-58.html')).toBeDefined();
    expect(byPath(content, 'page-11.html')).toBeDefined();
    expect(byPath(content, 'page-10.html')).toBeUndefined();
  });

  it('with autoPlace off it skips seeding and turns but still marks the board seeded and resolves focus', () => {
    const content: BoardContent = { ...emptyBoardContent(), settings: { background: 'dots', autoPlace: false } };
    const result = planBoardSync(plannerInput({
      content,
      ledger: emptyBoardSyncLedger(),
      seedFiles: [{ path: 'index.html', mtime: 1 }],
      turns: [turn('m1', ['landing.html'])],
      focus: { names: ['notes.html'], primary: 'notes.html', turnMessageId: null, near: null },
      focusTargets: new Map([['notes.html', { kind: 'file', path: 'notes.html' }]]),
    }));
    const next = applyPlan(content, result);
    expect(byPath(next, 'index.html')).toBeUndefined();
    expect(byPath(next, 'landing.html')).toBeUndefined();
    expect(byPath(next, 'notes.html')).toBeDefined();
    expect(result.ledger.seededAt).toBe(NOW);
    expect(result.ledger.cursor).toBe(NOW - 10_000);
    expect(result.focus).toEqual({ nodeIds: [byPath(next, 'notes.html')!.id], primaryNodeId: byPath(next, 'notes.html')!.id });
  });
});

describe('planBoardSync — P4 turns', () => {
  it('uses deterministic ids and is idempotent (a second plan over its own result has no ops)', () => {
    const identities = new Map([['index.html', 'wa-index']]);
    const input = plannerInput({ turns: [turn('m1', ['index.html', 'pricing.html'])], identities });
    const first = plan(input);
    const again = planBoardSync(input);
    expect(again.ops).toEqual(first.plan.ops);
    expect(byPath(first.content, 'index.html')!.id).toBe(stableBoardId('n', 'path:wa-index'));
    expect(byPath(first.content, 'pricing.html')!.id).toBe(stableBoardId('n', 'path:pricing.html'));
    const second = planBoardSync({ ...input, content: first.content, ledger: first.plan.ledger });
    expect(second.ops).toEqual([]);
    expect(second.placements.every((entry) => entry.status === 'existing')).toBe(true);
  });

  it('keeps only frames, designs and motion when a turn has them (an index.html turn plus hero.png places only the frame)', () => {
    const { content } = plan(plannerInput({ turns: [turn('m1', ['index.html', 'hero.png'])] }));
    expect(byPath(content, 'index.html')?.kind).toBe('frame');
    expect(byPath(content, 'hero.png')).toBeUndefined();
    const media = plan(plannerInput({ turns: [turn('m2', ['a.png', 'b.mp4'])] })).content;
    expect(byPath(media, 'a.png')?.kind).toBe('image');
    expect(byPath(media, 'b.mp4')?.kind).toBe('video');
  });

  it('keeps the shallowest index.html of a web-clone turn', () => {
    const { content } = plan(plannerInput({
      project: { kind: 'prototype', intent: 'web-clone' },
      turns: [turn('m1', ['site/index.html', 'site/about.html', 'index.html', 'deep/x/index.html'])],
    }));
    expect(content.nodes.filter((node) => node.kind === 'frame').map((node) => 'ref' in node && node.ref?.path)).toEqual(['index.html']);
  });

  it('caps a turn at 12 outputs (shallowest, then by path) and groups them in one turn group', () => {
    const paths = Array.from({ length: 15 }, (_, index) => `screen-${String(index).padStart(2, '0')}.html`);
    const { content } = plan(plannerInput({
      turns: [turn('m1', ['nested/zzz.html', ...paths], { prompt: 'Build the onboarding screens' })],
    }));
    const frames = content.nodes.filter((node) => node.kind === 'frame');
    expect(frames).toHaveLength(12);
    expect(byPath(content, 'nested/zzz.html')).toBeUndefined();
    const [turnGroup] = groups(content, 'turn');
    expect(turnGroup!.id).toBe(stableBoardId('n', 'turn:m1'));
    expect(turnGroup!.title).toBe('Build the onboarding screens');
    expect(childrenOf(content, turnGroup!.id)).toHaveLength(12);
  });

  it('sizes frames by device and project kind', () => {
    const { content } = plan(plannerInput({ turns: [turn('m1', ['index.html', 'mobile-home.html', 'tablet.html'])] }));
    expect(byPath(content, 'index.html')).toMatchObject({ device: 'desktop', w: 1440, h: 900 });
    expect(byPath(content, 'mobile-home.html')).toMatchObject({ device: 'mobile', w: 390, h: 844 });
    expect(byPath(content, 'tablet.html')).toMatchObject({ device: 'tablet', w: 834, h: 1112 });
    const deck = plan(plannerInput({ project: { kind: 'deck' }, turns: [turn('m2', ['slides.html'])] })).content;
    expect(byPath(deck, 'slides.html')).toMatchObject({ device: 'custom', w: 1280, h: 720 });
  });

  it('turns explicit variant files into one variants row inside a turn group', () => {
    const { content } = plan(plannerInput({
      turns: [turn('m1', ['landing.variant-c.html', 'landing.variant-a.html', 'landing.variant-b.html'])],
    }));
    const [row] = groups(content, 'variants');
    expect(row).toMatchObject({ id: stableBoardId('n', 'variants:landing#frame'), variantKey: 'landing#frame', layout: 'row' });
    const [turnGroup] = groups(content, 'turn');
    expect(row!.parentId).toBe(turnGroup!.id);
    const members = childrenOf(content, row!.id);
    expect(members).toHaveLength(3);
    const ordered = [...members].sort((a, b) => a.x - b.x).map((node) => node.variantLabel);
    expect(ordered).toEqual(['a', 'b', 'c']);
    expect(members.every((node) => node.y === row!.y + 52)).toBe(true);
  });

  it('anchors a new variants row next to an existing base and links it with lineage edges', () => {
    const base = plan(plannerInput({ turns: [turn('m1', ['landing.html'])] }));
    const baseNode = byPath(base.content, 'landing.html')!;
    const { content } = plan(plannerInput({
      content: base.content,
      ledger: base.plan.ledger,
      turns: [turn('m2', ['landing.variant-a.html', 'landing.variant-b.html'], { createdAt: NOW - 5_000 })],
    }));
    const [row] = groups(content, 'variants');
    expect(row!.parentId).toBeUndefined();
    expect(row!.baseNodeId).toBe(baseNode.id);
    expect(row!.x).toBe(baseNode.x + baseNode.w + 80);
    expect(row!.y).toBe(baseNode.y);
    const variantIds = childrenOf(content, row!.id).map((node) => node.id);
    expect(content.edges.map((edge) => [edge.kind, edge.from, edge.to])).toEqual(
      expect.arrayContaining(variantIds.map((id) => ['lineage', baseNode.id, id])),
    );
    expect(content.edges[0]!.id).toBe(stableBoardId('e', `lineage:${baseNode.id}:${content.edges[0]!.to}`));
  });

  it('uses tolerated variant names only when two files of the turn share the key', () => {
    const single = plan(plannerInput({ turns: [turn('m1', ['hero-v2.png'])] })).content;
    expect(groups(single, 'variants')).toHaveLength(0);
    const pair = plan(plannerInput({ turns: [turn('m1', ['hero-v1.png', 'hero-v2.png'])] })).content;
    expect(groups(pair, 'variants')).toHaveLength(1);
  });

  it('attaches the newest movie render to the movie node instead of placing it', () => {
    const { content } = plan(plannerInput({
      turns: [turn('m1', ['movie-studio.json'], { outputs: [
        { path: 'movie-studio.json', mtime: 1 },
        { path: 'movie-aaa.mp4', mtime: 5 },
        { path: 'movie-bbb.mp4', mtime: 9 },
      ] })],
    }));
    const movie = content.nodes.find((node) => node.kind === 'motion')!;
    expect(movie.id).toBe(stableBoardId('n', `movie:${PROJECT}`));
    expect(movie).toMatchObject({ source: { type: 'movie', projectId: PROJECT }, render: { path: 'movie-bbb.mp4' }, w: 960, h: 540 });
    expect(content.nodes.filter((node) => node.kind === 'video')).toHaveLength(0);
    // A later render only updates the existing movie node.
    const next = plan(plannerInput({
      content,
      turns: [turn('m2', [], { createdAt: NOW - 5_000, outputs: [{ path: 'movie-ccc.mp4', mtime: 20 }] })],
    })).content;
    expect(next.nodes.filter((node) => node.kind === 'motion')).toHaveLength(1);
    expect(next.nodes.find((node) => node.kind === 'motion')).toMatchObject({ render: { path: 'movie-ccc.mp4' } });
    expect(next.nodes.filter((node) => node.kind === 'video')).toHaveLength(0);
  });

  it('does not bring back a movie node the user removed while its turn is still re-read, but a newer turn does', () => {
    const movieTurn = turn('m1', [], { outputs: [{ path: 'movie-studio.json', mtime: 1 }, { path: 'movie-aaa.mp4', mtime: 2 }] });
    const first = plan(plannerInput({ turns: [movieTurn] }));
    const movieId = stableBoardId('n', `movie:${PROJECT}`);
    const removed = applyBoardOps(first.content, [{ op: 'remove', ids: [movieId] }], {
      baseRevision: 1, nextRevision: 2, actor: { kind: 'user' }, now: NOW, newId: () => 'n_unused', checkConflicts: true,
    });
    if (!removed.ok) throw new Error('remove failed');
    // The movie node has no file ref, so its removal leaves no dismissal behind.
    expect(removed.removedPaths).toEqual([]);
    const again = planBoardSync(plannerInput({ content: removed.content, ledger: first.plan.ledger, turns: [movieTurn] }));
    expect(again.ops).toEqual([]);
    const newer = plan(plannerInput({
      content: removed.content,
      ledger: again.ledger,
      turns: [movieTurn, turn('m2', [], { createdAt: NOW - 5_000, outputs: [{ path: 'movie-studio.json', mtime: 3 }] })],
    }));
    expect(newer.content.nodes.map((node) => node.id)).toContain(movieId);
  });

  it('gives a single composition the turn\'s newest video as its render', () => {
    const { content } = plan(plannerInput({
      turns: [turn('m1', [], { outputs: [
        { path: 'motion-source/intro/index.html', mtime: 1 },
        { path: 'renders/intro-1.mp4', mtime: 2 },
        { path: 'renders/intro-2.mp4', mtime: 3 },
      ] })],
    }));
    const composition = content.nodes.find((node) => node.kind === 'motion')!;
    expect(composition).toMatchObject({
      source: { type: 'composition', ref: { path: 'motion-source/intro/index.html' } },
      render: { path: 'renders/intro-2.mp4' },
    });
    expect(content.nodes.filter((node) => node.kind === 'video')).toHaveLength(0);
  });

  it('grows a running turn into a turn group that keeps the first node where it was', () => {
    const first = plan(plannerInput({ turns: [turn('m1', ['a.html'], { terminal: false })] }));
    const nodeA = byPath(first.content, 'a.html')!;
    expect(nodeA.parentId).toBeUndefined();
    expect(first.plan.ledger.cursor).toBe(NOW - 120_000);
    const second = plan(plannerInput({
      content: first.content,
      ledger: first.plan.ledger,
      turns: [turn('m1', ['a.html', 'b.html'], { terminal: true })],
    }));
    const [turnGroup] = groups(second.content, 'turn');
    expect(turnGroup).toBeDefined();
    const movedA = byPath(second.content, 'a.html')!;
    expect(movedA.parentId).toBe(turnGroup!.id);
    expect([movedA.x, movedA.y]).toEqual([nodeA.x, nodeA.y]);
    expect(byPath(second.content, 'b.html')!.parentId).toBe(turnGroup!.id);
    expect(second.plan.ledger.turns.m1).toMatchObject({ status: 'terminal', groupId: turnGroup!.id });
    expect(second.plan.ledger.cursor).toBe(NOW - 10_000);
  });

  it('does not regroup a turn whose group the user dissolved', () => {
    const first = plan(plannerInput({ turns: [turn('m1', ['a.html', 'b.html'], { terminal: false })] }));
    const [turnGroup] = groups(first.content, 'turn');
    const ungrouped = applyBoardOps(first.content, [{ op: 'ungroup', id: turnGroup!.id }], {
      baseRevision: 1, nextRevision: 2, actor: { kind: 'user' }, now: NOW, newId: () => 'n_unused', checkConflicts: true,
    });
    if (!ungrouped.ok) throw new Error('ungroup failed');
    const second = plan(plannerInput({
      content: ungrouped.content,
      ledger: first.plan.ledger,
      turns: [turn('m1', ['a.html', 'b.html', 'c.html'])],
    }));
    expect(groups(second.content, 'turn')).toHaveLength(0);
    expect(byPath(second.content, 'c.html')!.parentId).toBeUndefined();
  });

  it('never re-adds a path removed after the turn, but a newer turn does (and clears the dismissal)', () => {
    const removedAt = NOW - 5_000;
    const ledger = seededLedger({ dismissed: { 'index.html': removedAt } });
    const older = planBoardSync(plannerInput({ ledger, turns: [turn('m1', ['index.html'], { createdAt: removedAt - 1 })] }));
    expect(older.ops).toEqual([]);
    expect(older.ledger.dismissed['index.html']).toBe(removedAt);
    const newer = plan(plannerInput({ ledger, turns: [turn('m2', ['index.html'], { createdAt: removedAt + 1 })] }));
    expect(byPath(newer.content, 'index.html')).toBeDefined();
    expect(newer.plan.ledger.dismissed['index.html']).toBeUndefined();
  });

  it('adds the snapshot cover of a frame placed by a turn', () => {
    const { content } = plan(plannerInput({
      turns: [turn('m1', ['index.html'])],
      snapshotCovers: new Map([['index.html', { snapshotId: 'snap-1', sourceMtime: 42 }]]),
    }));
    expect(byPath(content, 'index.html')).toMatchObject({
      cover: { source: 'chat-artifact-snapshot', snapshotId: 'snap-1', sourceMtime: 42 },
      origin: { source: 'chat-turn', conversationId: 'conv-1', messageId: 'm1', runId: 'run-m1' },
    });
  });
});

describe('planBoardSync — P3 media tasks', () => {
  function task(taskId: string, overrides: Partial<BoardPlannerMediaTask> = {}): BoardPlannerMediaTask {
    return {
      taskId,
      runId: 'run-media',
      messageId: 'm-media',
      conversationId: 'conv-1',
      surface: 'image',
      status: 'running',
      batchId: 'batch-1',
      batchIndex: 1,
      batchSize: 2,
      sequence: 1,
      ...overrides,
    };
  }

  it('places batch placeholders in a variants row, then turns done tasks into file refs', () => {
    const tasks = [task('t1', { progress: 'step 1/4' }), task('t2', { batchIndex: 2, sequence: 2, status: 'queued' })];
    const first = plan(plannerInput({ mediaTasks: tasks }));
    const [row] = groups(first.content, 'variants');
    expect(row).toMatchObject({ id: stableBoardId('n', 'batch:batch-1'), variantKey: 'batch:batch-1' });
    const placeholder = first.content.nodes.find((node) => node.id === stableBoardId('n', 'media:t1'))!;
    expect(placeholder).toMatchObject({
      kind: 'image',
      ref: null,
      parentId: row!.id,
      variantLabel: '1',
      autoSize: true,
      pending: { mediaTaskId: 't1', status: 'running', progress: 'step 1/4' },
      origin: { source: 'media-task', mediaTaskId: 't1', runId: 'run-media', batchId: 'batch-1', batchIndex: 1 },
    });
    expect(first.plan.ledger.mediaTasks).toEqual({ t1: placeholder.id, t2: stableBoardId('n', 'media:t2') });

    const done = plan(plannerInput({
      content: first.content,
      ledger: first.plan.ledger,
      mediaTasks: [
        task('t1', { status: 'done', filePath: 'gen-1.png' }),
        task('t2', { batchIndex: 2, sequence: 2, status: 'failed', error: { message: 'quota', nextStep: 'retry-later' } }),
      ],
    }));
    expect(done.content.nodes.find((node) => node.id === placeholder.id)).toMatchObject({ ref: { path: 'gen-1.png' } });
    expect(done.content.nodes.find((node) => node.id === placeholder.id)).not.toHaveProperty('pending');
    expect(done.content.nodes.find((node) => node.id === stableBoardId('n', 'media:t2'))).toMatchObject({
      pending: { mediaTaskId: 't2', status: 'failed', error: { message: 'quota', nextStep: 'retry-later' } },
    });
    // An unknown next step is dropped instead of invalidating the batch.
    const unknown = planBoardSync(plannerInput({
      content: first.content,
      ledger: first.plan.ledger,
      mediaTasks: [task('t2', { batchIndex: 2, sequence: 2, status: 'interrupted', error: { message: 'gone', nextStep: 'reboot' as never } })],
    }));
    expect(unknown.rejected).toEqual([]);
    expect(applyPlan(first.content, unknown).nodes.find((node) => node.id === stableBoardId('n', 'media:t2'))).toMatchObject({
      pending: { status: 'interrupted', error: { message: 'gone' } },
    });
  });

  it('ignores single tasks outside media projects and never recreates a removed placeholder', () => {
    expect(planBoardSync(plannerInput({ mediaTasks: [task('t1', { batchSize: 1 })] })).ops).toEqual([]);
    const media = plan(plannerInput({ project: { kind: 'image' }, mediaTasks: [task('t1', { batchSize: 1 })] }));
    expect(media.content.nodes.map((node) => node.id)).toEqual([stableBoardId('n', 'media:t1')]);
    const removed = applyBoardOps(media.content, [{ op: 'remove', ids: [stableBoardId('n', 'media:t1')] }], {
      baseRevision: 1, nextRevision: 2, actor: { kind: 'user' }, now: NOW, newId: () => 'n_unused', checkConflicts: true,
    });
    if (!removed.ok) throw new Error('remove failed');
    const again = planBoardSync(plannerInput({
      project: { kind: 'image' },
      content: removed.content,
      ledger: media.plan.ledger,
      mediaTasks: [task('t1', { batchSize: 1, status: 'done', filePath: 'gen-1.png' })],
    }));
    expect(again.ops).toEqual([]);
  });
});

describe('planBoardSync — P1 reconcile', () => {
  it('follows renames, removes deleted files and flags missing ones', () => {
    const seeded = plan(plannerInput({
      turns: [turn('m1', ['a.html', 'b.html', 'c.html', 'd.html'])],
      identities: new Map([['a.html', 'wa-a'], ['b.html', 'wa-b']]),
    }));
    const a = byPath(seeded.content, 'a.html')!;
    const b = byPath(seeded.content, 'b.html')!;
    const c = byPath(seeded.content, 'c.html')!;
    const d = byPath(seeded.content, 'd.html')!;
    const missing = plan(plannerInput({
      content: seeded.content,
      ledger: seeded.plan.ledger,
      refStatuses: new Map([
        [boardRefStatusKey(a.id, 'ref'), { nodeId: a.id, field: 'ref', status: 'renamed', path: 'home.html', workspaceArtifactId: 'wa-a' }],
        [boardRefStatusKey(b.id, 'ref'), { nodeId: b.id, field: 'ref', status: 'deleted', workspaceArtifactId: 'wa-b' }],
        [boardRefStatusKey(c.id, 'ref'), { nodeId: c.id, field: 'ref', status: 'missing' }],
        [boardRefStatusKey(d.id, 'ref'), { nodeId: d.id, field: 'ref', status: 'present' }],
      ]),
    }));
    expect(missing.content.nodes.find((node) => node.id === a.id)).toMatchObject({ ref: { path: 'home.html', workspaceArtifactId: 'wa-a' } });
    expect(missing.content.nodes.find((node) => node.id === b.id)).toBeUndefined();
    expect(missing.content.nodes.find((node) => node.id === c.id)).toMatchObject({ missing: { since: NOW } });
    expect(missing.plan.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ nodeId: a.id, status: 'updated', path: 'home.html' }),
      expect.objectContaining({ nodeId: b.id, status: 'removed', path: 'b.html' }),
    ]));
    const back = plan(plannerInput({
      content: missing.content,
      ledger: missing.plan.ledger,
      refStatuses: new Map([[boardRefStatusKey(c.id, 'ref'), { nodeId: c.id, field: 'ref', status: 'present' }]]),
    }));
    expect(back.content.nodes.find((node) => node.id === c.id)).not.toHaveProperty('missing');
  });

  it('flags more missing files than one op batch may carry (maxOpsPerPatch)', () => {
    let content = emptyBoardContent();
    for (const batch of [0, 1]) {
      const ops = Array.from({ length: 120 }, (_, index) => ({
        op: 'add' as const,
        node: { id: `n_page${batch}_${String(index).padStart(3, '0')}`, kind: 'frame' as const, ref: { path: `p${batch}-${index}.html` } },
      }));
      const added = applyBoardOps(content, ops, {
        baseRevision: batch, nextRevision: batch + 1, actor: { kind: 'user' }, now: NOW, newId: () => 'n_unused', checkConflicts: true,
      });
      if (!added.ok) throw new Error('setup failed');
      content = added.content;
    }
    const refStatuses = new Map(content.nodes.map((node) => [
      boardRefStatusKey(node.id, 'ref'),
      { nodeId: node.id, field: 'ref' as const, status: 'missing' as const },
    ]));
    const { plan: result, content: next } = plan(plannerInput({ content, refStatuses }));
    expect(result.ops).toHaveLength(240);
    expect(next.nodes.every((node) => node.missing?.since === NOW)).toBe(true);
  });
});

describe('planBoardSync — P5 focus', () => {
  it('places a live artifact frame, reports unplaceable names and resolves the primary node', () => {
    const { plan: result, content } = plan(plannerInput({
      focus: { names: ['live:la-1', 'README.md', 'index.html'], primary: 'index.html', turnMessageId: null, near: { x: 5000, y: 5000 } },
      focusTargets: new Map([
        ['live:la-1', { kind: 'live', liveArtifactId: 'la-1' }],
        ['README.md', null],
        ['index.html', { kind: 'file', path: 'index.html' }],
      ]),
    }));
    const live = content.nodes.find((node) => node.id === stableBoardId('n', 'live:la-1'))!;
    expect(live).toMatchObject({ kind: 'frame', ref: null, liveArtifactId: 'la-1', origin: { source: 'user' } });
    const index = byPath(content, 'index.html')!;
    expect(result.unplaceable).toEqual(['README.md']);
    expect(result.focus).toEqual({ nodeIds: [live.id, index.id], primaryNodeId: index.id });
    // `viewport` placement around the hinted point.
    expect(live.x).toBeGreaterThan(3000);
  });

  it('puts a focused file into the hinted turn group and clears its dismissal', () => {
    const first = plan(plannerInput({ turns: [turn('m1', ['a.html', 'b.html'], { terminal: false })] }));
    const [turnGroup] = groups(first.content, 'turn');
    const ledger = { ...first.plan.ledger, dismissed: { 'notes.html': NOW - 1 } };
    const { plan: result, content } = plan(plannerInput({
      content: first.content,
      ledger,
      turns: [turn('m1', ['a.html', 'b.html'], { terminal: false })],
      focus: { names: ['notes.html'], primary: null, turnMessageId: 'm1', near: null },
      focusTargets: new Map([['notes.html', { kind: 'file', path: 'notes.html' }]]),
    }));
    expect(byPath(content, 'notes.html')!.parentId).toBe(turnGroup!.id);
    expect(result.ledger.dismissed['notes.html']).toBeUndefined();
    expect(result.placements).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'created', path: 'notes.html', groupId: turnGroup!.id }),
    ]));
  });
});

describe('planner helpers', () => {
  it('trims the ledger: turns by oldest updatedAt, media tasks by age, dismissals by oldest', () => {
    const turns = Object.fromEntries(Array.from({ length: BOARD_LEDGER_LIMITS.turns + 5 }, (_, index) => [
      `m${index}`,
      { conversationId: 'c', status: 'terminal' as const, placed: {}, updatedAt: index },
    ]));
    const mediaTasks = Object.fromEntries(Array.from({ length: BOARD_LEDGER_LIMITS.mediaTasks + 3 }, (_, index) => [`t${index}`, `n_${index}`]));
    const dismissed = Object.fromEntries(Array.from({ length: BOARD_LEDGER_LIMITS.dismissed + 2 }, (_, index) => [`f${index}.html`, index]));
    const trimmed = trimBoardSyncLedger({ ...emptyBoardSyncLedger(), turns, mediaTasks, dismissed });
    expect(Object.keys(trimmed.turns)).toHaveLength(BOARD_LEDGER_LIMITS.turns);
    expect(trimmed.turns.m0).toBeUndefined();
    expect(trimmed.turns[`m${BOARD_LEDGER_LIMITS.turns + 4}`]).toBeDefined();
    expect(Object.keys(trimmed.mediaTasks)).toHaveLength(BOARD_LEDGER_LIMITS.mediaTasks);
    expect(trimmed.mediaTasks.t0).toBeUndefined();
    expect(Object.keys(trimmed.dismissed)).toHaveLength(BOARD_LEDGER_LIMITS.dismissed);
    expect(trimmed.dismissed['f0.html']).toBeUndefined();
  });

  it('excerpts the turn prompt for group titles', () => {
    expect(excerptBoardTurnPrompt('<attached-files path="a.png"/>\n\n## **Make** a `landing`   page\nmore')).toBe('Make a landing page');
    expect(excerptBoardTurnPrompt(`${'a'.repeat(70)}`)).toBe(`${'a'.repeat(60)}…`);
    expect(excerptBoardTurnPrompt('<only-markup/>')).toBeUndefined();
    expect(excerptBoardTurnPrompt(null)).toBeUndefined();
  });
});
