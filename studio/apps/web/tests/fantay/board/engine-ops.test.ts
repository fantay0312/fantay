// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { stableBoardId, validateBoardPatchRequest, type BoardNodeDraft } from '@open-design/contracts';

import { createBoardCommands } from '../../../src/fantay/board/commands/board-commands';
import { createCameraController } from '../../../src/fantay/board/camera/camera-controller';
import { toEngineDoc } from '../../../src/fantay/board/model/contract-adapter';
import type { BoardEnvironment } from '../../../src/fantay/board/model/types';
import { defaultBoardEnvironment } from '../../../src/fantay/board/store/board-engine';
import { createEngineStore } from '../../../src/fantay/board/store/board-store';
import { applyOptionsFor, nodePatchToContract, toContractOps } from '../../../src/fantay/board/store/ops';
import { buildRuntimeEnv, deriveNodeRuntime } from '../../../src/fantay/board/store/runtime-state';
import {
  createFakeDataStore,
  createFrameQueue,
  createManualTimers,
  frameDraft,
  groupDraft,
  makeBoard,
  noteDraft,
  PROJECT_ID,
} from './engine-fixtures';

function setup(drafts: BoardNodeDraft[] = [], env: Partial<BoardEnvironment> = {}) {
  const data = createFakeDataStore(makeBoard(drafts));
  const store = createEngineStore({ projectId: PROJECT_ID, data });
  store.connect();
  const frames = createFrameQueue();
  const timers = createManualTimers();
  const camera = createCameraController({
    requestFrame: frames.requestFrame,
    cancelFrame: frames.cancelFrame,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    now: timers.now,
    reducedMotion: () => true,
  });
  camera.setStageSize({ w: 1200, h: 800 });
  let counter = 0;
  const environment = { ...defaultBoardEnvironment(PROJECT_ID), ...env };
  const commands = createBoardCommands({
    store,
    camera,
    getEnv: () => environment,
    getExtensions: () => undefined,
    getServices: () => ({}),
    getTranslate: () => (key) => key,
    now: timers.now,
    newNodeId: () => {
      counter += 1;
      return `n_cmd${counter}`;
    },
  });
  return { data, store, camera, commands };
}

describe('engine ops → contract ops', () => {
  const doc = toEngineDoc(makeBoard([noteDraft('n_a', 10, 20, 'one'), frameDraft('n_f', 400, 0, 'index.html'), { kind: 'generator', id: 'n_gen', x: 0, y: 600, w: 320, h: 272, version: 1, surface: 'image', prompt: '', model: null, params: { aspect: '1:1', count: 1 }, runs: [] } as unknown as BoardNodeDraft]), PROJECT_ID);

  it('rounds moves and drops unchanged or unknown ones', () => {
    const ops = toContractOps([{ type: 'move', moves: [{ id: 'n_a', x: 10.4, y: 20.4 }, { id: 'n_f', x: 401.6, y: -0.2 }, { id: 'n_nope', x: 1, y: 1 }] }], { doc });
    expect(ops).toEqual([{ op: 'move', moves: [{ id: 'n_f', x: 402, y: 0 }] }]);
    expect(toContractOps([{ type: 'move', moves: [{ id: 'n_a', x: 10, y: 20 }] }], { doc })).toEqual([]);
  });

  it('normalizes patches: kind-allowed keys only, empty titles clear, unchanged values dropped', () => {
    const note = doc.nodes.get('n_a')!;
    expect(nodePatchToContract(note, { title: '', data: { text: 'one', color: 'violet', url: 'https://x.dev' } as never })).toEqual({ color: 'violet' });
    expect(nodePatchToContract(note, { w: 3.6, h: 99_999 })).toEqual({ w: 8, h: 20_000 });
    expect(nodePatchToContract(note, { data: { size: null } })).toBeNull(); // nothing to clear
    const frame = doc.nodes.get('n_f')!;
    expect(nodePatchToContract(frame, { w: 800.4, data: { device: 'custom' } })).toEqual({ w: 800, device: 'custom' });
  });

  it('builds add drafts with the given id and without server-managed keys', () => {
    const ops = toContractOps([{ type: 'add', node: { kind: 'note', id: 'n_new', x: 1.2, y: 2.7, w: 280, h: 220, data: { text: '', color: 'yellow', rev: 9, createdAt: 1 } } }], { doc });
    expect(ops).toEqual([{ op: 'add', node: { kind: 'note', id: 'n_new', x: 1, y: 3, w: 280, h: 220, text: '', color: 'yellow' } }]);
  });

  it('keeps only valid, new connections (reference → generator)', () => {
    expect(toContractOps([{ type: 'connect', edge: { id: 'e_1', kind: 'reference', from: 'n_a', to: 'n_gen' } }], { doc })).toEqual([
      { op: 'connect', edge: { id: 'e_1', kind: 'reference', from: 'n_a', to: 'n_gen' } },
    ]);
    expect(toContractOps([{ type: 'connect', edge: { kind: 'reference', from: 'n_a', to: 'n_f' } }], { doc })).toEqual([]);
    expect(toContractOps([{ type: 'connect', edge: { kind: 'reference', from: 'n_a', to: 'n_a' } }], { doc })).toEqual([]);
  });

  it('produces requests the contract validator accepts', () => {
    const ops = toContractOps(
      [
        { type: 'add', node: { kind: 'note', id: 'n_x', x: 0, y: 0, w: 280, h: 220, data: { text: 'x', color: 'yellow' } } },
        { type: 'patch', id: 'n_a', patch: { title: 'Idea', locked: true, data: { text: 'two', size: 'lg' } } },
        { type: 'move', moves: [{ id: 'n_f', x: 1000, y: 10 }] },
        { type: 'remove', ids: ['n_x', 'n_missing'] },
        { type: 'reorder', id: 'n_a', to: 'front' },
      ],
      { doc },
    );
    const result = validateBoardPatchRequest({ baseRevision: 1, ops });
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('apply options: only local edits are undoable; others resolve conflicts silently', () => {
    expect(applyOptionsFor({ origin: 'local', label: 'move', ops: [], coalesceKey: 'nudge:a' })).toEqual({
      undoable: true,
      silentConflict: false,
      label: 'move',
      coalesceKey: 'nudge:a',
    });
    expect(applyOptionsFor({ origin: 'system', label: 'autosize', ops: [] })).toEqual({ undoable: false, silentConflict: true, label: 'autosize' });
  });
});

describe('engine store over the 04 data store', () => {
  it('commit → data.apply with contract ops and options; the optimistic view updates the document', async () => {
    const { data, store } = setup([noteDraft('n_a', 0, 0)]);
    const result = await store.commit({ origin: 'local', label: 'move', ops: [{ type: 'move', moves: [{ id: 'n_a', x: 50, y: 60 }] }] });
    expect(result.ok).toBe(true);
    expect(data.apply).toHaveBeenCalledTimes(1);
    expect(data.applyCalls[0]!.ops).toEqual([{ op: 'move', moves: [{ id: 'n_a', x: 50, y: 60 }] }]);
    expect(data.applyCalls[0]!.options).toEqual({ undoable: true, silentConflict: false, label: 'move' });
    expect(store.getState().doc.nodes.get('n_a')).toMatchObject({ x: 50, y: 60 });
  });

  it('a transaction that changes nothing never reaches the 04 store', async () => {
    const { data, store } = setup([noteDraft('n_a', 0, 0)]);
    await store.commit({ origin: 'local', label: 'move', ops: [{ type: 'move', moves: [{ id: 'n_a', x: 0, y: 0 }] }] });
    expect(data.apply).not.toHaveBeenCalled();
  });

  it('read-only refuses local edits; undo/redo go to the 04 store', async () => {
    const { data, store } = setup([noteDraft('n_a', 0, 0)]);
    store.setReadOnly(true);
    expect(await store.commit({ origin: 'local', label: 'delete', ops: [{ type: 'remove', ids: ['n_a'] }] })).toEqual({ ok: false });
    expect(await store.undo()).toBe(false);
    expect(data.apply).not.toHaveBeenCalled();
    store.setReadOnly(false);
    await store.commit({ origin: 'local', label: 'delete', ops: [{ type: 'remove', ids: ['n_a'] }] });
    expect(store.getState().doc.nodes.has('n_a')).toBe(false);
    expect(await store.undo()).toBe(true);
    expect(data.undo).toHaveBeenCalledTimes(1);
    expect(store.getState().doc.nodes.has('n_a')).toBe(true);
    expect(await store.redo()).toBe(true);
    expect(store.getState().doc.nodes.has('n_a')).toBe(false);
  });

  it('prunes selection, mode and editing ids of nodes that left the document', () => {
    const { data, store } = setup([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]);
    store.setUi({ selection: ['n_a', 'n_b'], editingTextId: 'n_b', hoverId: 'n_b', hoverSince: 1 });
    data.setBoard(makeBoard([noteDraft('n_a', 0, 0)]));
    const { ui } = store.getState();
    expect(ui.selection).toEqual(['n_a']);
    expect(ui.editingTextId).toBeNull();
    expect(ui.hoverId).toBeNull();
  });

  it('mirrors history and save state from the 04 store', () => {
    const { data, store } = setup();
    data.setBoard(data.getState().board, { canUndo: true, pendingOps: 2 });
    expect(store.getState().history.canUndo).toBe(true);
    expect(store.getState().save.pendingOps).toBe(2);
  });
});

describe('board commands', () => {
  it('ensureFileNodes reuses the node of a path (I1) and adds the others once, in one transaction', () => {
    const { data, commands, store } = setup([frameDraft('n_existing', 0, 0, 'index.html')]);
    const ids = commands.ensureFileNodes(['index.html', 'about.html', 'hero.png', 'about.html', 'notes.txt']);
    expect(ids).toEqual(['n_existing', stableBoardId('n', 'path:about.html'), stableBoardId('n', 'path:hero.png')]);
    expect(data.apply).toHaveBeenCalledTimes(1);
    const ops = data.applyCalls[0]!.ops;
    expect(ops).toHaveLength(2);
    expect(ops.every((op) => op.op === 'add' && op.ifAbsent === true)).toBe(true);
    expect(store.getState().ui.selection).toEqual(ids);
    // a second call is a no-op
    commands.ensureFileNodes(['about.html']);
    expect(data.apply).toHaveBeenCalledTimes(1);
  });

  it('ensureFileNodes places the movie document as the one movie node of the project (R5)', () => {
    const { data, commands } = setup();
    const [id] = commands.ensureFileNodes(['movie-studio.json']);
    expect(id).toBe(stableBoardId('n', `movie:${PROJECT_ID}`));
    const add = data.applyCalls[0]!.ops[0]!;
    expect(add.op === 'add' && add.node).toMatchObject({ kind: 'motion', source: { type: 'movie', projectId: PROJECT_ID } });
  });

  it('removeNodes only removes nodes from the board (I4)', () => {
    const { data, commands } = setup([frameDraft('n_f', 0, 0, 'index.html')]);
    commands.removeNodes(['n_f']);
    expect(data.applyCalls[0]!.ops).toEqual([{ op: 'remove', ids: ['n_f'] }]);
  });

  it('nudges carry a coalesce key per selection', () => {
    const { data, commands } = setup([noteDraft('n_b', 0, 0), noteDraft('n_a', 400, 0)]);
    commands.nudge(['n_b', 'n_a'], 10, 0);
    expect(data.applyCalls[0]!.options).toMatchObject({ undoable: true, label: 'nudge', coalesceKey: 'nudge:n_a,n_b' });
  });

  it('groups siblings into a section and ungroups back', () => {
    const { data, commands, store } = setup([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]);
    const groupId = commands.group(['n_a', 'n_b']);
    expect(groupId).toBe('n_cmd1');
    expect(data.applyCalls[0]!.ops).toEqual([{ op: 'group', ids: ['n_a', 'n_b'], group: { id: 'n_cmd1', role: 'section', layout: 'free' } }]);
    expect(store.getState().doc.nodes.get('n_a')?.parentId).toBe('n_cmd1');
    commands.ungroup(['n_cmd1']);
    expect(data.applyCalls[1]!.ops).toEqual([{ op: 'ungroup', id: 'n_cmd1' }]);
    expect([...store.getState().ui.selection].sort()).toEqual(['n_a', 'n_b']);
  });

  it('reorders forward/backward one step within the same layer, front/back to the ends', () => {
    const { data, commands } = setup([noteDraft('n_1', 0, 0), groupDraft('n_g', 0, 600, 300, 300), noteDraft('n_2', 400, 0), noteDraft('n_3', 800, 0)]);
    commands.reorder(['n_1'], 'forward');
    expect(data.applyCalls[0]!.ops).toEqual([{ op: 'reorder', id: 'n_1', to: 2 }]);
    commands.reorder(['n_3'], 'back');
    expect(data.applyCalls[1]!.ops).toEqual([{ op: 'reorder', id: 'n_3', to: 'back' }]);
  });

  it('placeNode("note") creates a note centred on the point and starts editing it', () => {
    const { data, commands, store } = setup();
    const id = commands.placeNode('note', { x: 500, y: 300 });
    expect(id).toBe('n_cmd1');
    const add = data.applyCalls[0]!.ops[0]!;
    expect(add).toEqual({ op: 'add', node: { kind: 'note', id: 'n_cmd1', x: 360, y: 190, w: 280, h: 220, text: '', color: 'yellow' } });
    expect(store.getState().ui).toMatchObject({ editingTextId: 'n_cmd1', selection: ['n_cmd1'], tool: 'select' });
  });

  it('placeNode("generate") needs the generation extension', () => {
    const { data, commands } = setup();
    expect(commands.placeNode('generate', { x: 0, y: 0 })).toBeNull();
    expect(data.apply).not.toHaveBeenCalled();
  });

  it('focusNodes flies to the nodes; ifIdleMs respects recent camera input', () => {
    const { commands, camera } = setup([frameDraft('n_f', 2000, 1000, 'index.html')]);
    expect(commands.focusNodes(['n_f'])).toBe(true);
    const cam = camera.get();
    const centerX = (2000 + 720) * cam.zoom + cam.x;
    expect(centerX).toBeCloseTo(600, 3);
    camera.panBy(1, 1, 'user');
    const spy = vi.spyOn(camera, 'flyTo');
    expect(commands.focusNodes(['n_f'], { ifIdleMs: 60_000 })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('runtime state', () => {
  const doc = toEngineDoc(
    makeBoard([
      frameDraft('n_page', 0, 0, 'index.html'),
      frameDraft('n_gone', 2000, 0, 'gone.html'),
      frameDraft('n_building', 4000, 0, 'new.html'),
    ]),
    PROJECT_ID,
  );
  const file = { name: 'index.html', size: 1200, mtime: 77, kind: 'html', mime: 'text/html' } as const;

  it('derives missing, building and file stats', () => {
    const env = buildRuntimeEnv({ files: [file] as never, filesAuthoritative: true, buildingPaths: new Set(['new.html']), buildingAgentName: 'Claude' });
    expect(deriveNodeRuntime(doc.nodes.get('n_page')!, env)).toMatchObject({ phase: 'idle', fileMtime: 77, fileSize: 1200 });
    expect(deriveNodeRuntime(doc.nodes.get('n_gone')!, env).phase).toBe('missing');
    expect(deriveNodeRuntime(doc.nodes.get('n_building')!, env)).toMatchObject({ phase: 'building', agentName: 'Claude' });
  });

  it('never marks files missing while the list is not authoritative; ephemeral phases merge in', () => {
    const env = buildRuntimeEnv({ files: [], filesAuthoritative: false });
    expect(deriveNodeRuntime(doc.nodes.get('n_gone')!, env).phase).toBe('idle');
    expect(deriveNodeRuntime(doc.nodes.get('n_gone')!, env, { phase: 'ready', playing: true })).toMatchObject({ phase: 'ready', playing: true });
  });
});
