// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BoardNodeDraft, BoardOp } from '@open-design/contracts';

import {
  BOARD_CLIP_PREFIX,
  clipNodePath,
  clipNodesFor,
  copyBoardSelection,
  lastBoardClip,
  parseClip,
  pasteBoardClip,
  pastedFileName,
  planPaste,
  remapClip,
  resetBoardClipboardForTests,
  serializeClip,
} from '../../../src/fantay/board/interaction/clipboard';
import { createBoardEngine } from '../../../src/fantay/board/store/board-engine';
import { createFakeDataStore, frameDraft, groupDraft, makeBoard, noteDraft, PROJECT_ID } from './engine-fixtures';

afterEach(() => resetBoardClipboardForTests());

const lineage = (id: string, from: string, to: string): BoardOp => ({ op: 'connect', edge: { id, kind: 'lineage', from, to } });
const coverRef = { source: 'board-cover', digest: 'b'.repeat(64), mime: 'image/webp', width: 10, height: 10, capturedAt: 1 } as const;

function setup(drafts: BoardNodeDraft[], extra: BoardOp[] = []) {
  const data = createFakeDataStore(makeBoard(drafts, extra));
  let counter = 0;
  const engine = createBoardEngine({ projectId: PROJECT_ID, data, publishViewport: () => {}, newNodeId: () => `n_new${(counter += 1)}` });
  engine.store.syncFromData();
  return { engine, data };
}

describe('board clip format (03 §3.12)', () => {
  it('serializes the selection with positions relative to its union and only the edges between selected nodes', () => {
    const { engine } = setup([noteDraft('n_a', 100, 200), noteDraft('n_b', 500, 260), noteDraft('n_c', 900, 900)], [lineage('e_ab', 'n_a', 'n_b'), lineage('e_bc', 'n_b', 'n_c')]);
    const doc = engine.store.getState().doc;
    const text = serializeClip(clipNodesFor(doc, ['n_a', 'n_b']), doc.edges.values(), PROJECT_ID);
    expect(text.startsWith(BOARD_CLIP_PREFIX)).toBe(true);
    const clip = parseClip(text)!;
    expect(clip.projectId).toBe(PROJECT_ID);
    expect(clip.origin).toEqual({ x: 100, y: 200 });
    expect(clip.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ['n_a', 0, 0],
      ['n_b', 400, 60],
    ]);
    expect(clip.nodes[0]!.data).toMatchObject({ text: 'hello' });
    expect(clip.nodes[0]!.data).not.toHaveProperty('rev');
    expect(clip.edges).toEqual([{ kind: 'lineage', from: 'n_a', to: 'n_b' }]);
  });

  it('copies group descendants after their group and refuses foreign or broken text', () => {
    const { engine } = setup([groupDraft('n_g', 0, 0, 800, 600), noteDraft('n_in', 40, 40), noteDraft('n_out', 2000, 0)]);
    act(engine, () => engine.commands.updateNode('n_in', { parentId: 'n_g' }));
    const doc = engine.store.getState().doc;
    expect(clipNodesFor(doc, ['n_g']).map((node) => node.id)).toEqual(['n_g', 'n_in']);
    expect(parseClip('hello')).toBeNull();
    expect(parseClip(`${BOARD_CLIP_PREFIX}{not json`)).toBeNull();
    expect(parseClip(`${BOARD_CLIP_PREFIX}${JSON.stringify({ projectId: 'p', nodes: [{ id: 'x' }], edges: [] })}`)).toBeNull();
  });

  it('remaps ids, parents and edges to a new top-left', () => {
    const clip = parseClip(
      `${BOARD_CLIP_PREFIX}${JSON.stringify({
        projectId: PROJECT_ID,
        origin: { x: 0, y: 0 },
        nodes: [
          { id: 'g', kind: 'group', x: 0, y: 0, w: 500, h: 400, data: { role: 'section' } },
          { id: 'a', kind: 'note', x: 20, y: 30, w: 280, h: 220, parentId: 'g', data: { text: 'x' } },
          { id: 'b', kind: 'note', x: 300, y: 30, w: 280, h: 220, data: { text: 'y' } },
        ],
        edges: [{ kind: 'lineage', from: 'a', to: 'b' }, { kind: 'lineage', from: 'a', to: 'gone' }],
      })}`,
    )!;
    let next = 0;
    const remapped = remapClip(clip, { x: 1000, y: 2000 }, () => `n_${(next += 1)}`);
    expect(remapped.nodes.map(({ draft }) => [draft.id, draft.x, draft.y, draft.parentId ?? null])).toEqual([
      ['n_1', 1000, 2000, null],
      ['n_2', 1020, 2030, 'n_1'],
      ['n_3', 1300, 2030, null],
    ]);
    expect(remapped.edges).toEqual([{ kind: 'lineage', from: 'n_2', to: 'n_3' }]);
  });

  it('finds the file of a clip node (ref or composition source)', () => {
    expect(clipNodePath({ id: 'a', kind: 'image', x: 0, y: 0, w: 1, h: 1, data: { ref: { path: 'a.png' } } })).toBe('a.png');
    expect(clipNodePath({ id: 'm', kind: 'motion', x: 0, y: 0, w: 1, h: 1, data: { source: { type: 'composition', ref: { path: 'motion-source/x/index.html' } } } })).toBe('motion-source/x/index.html');
    expect(clipNodePath({ id: 'n', kind: 'note', x: 0, y: 0, w: 1, h: 1, data: { text: 'x' } })).toBeNull();
    expect(pastedFileName(new Date(2026, 9, 29, 8, 5, 9), 'png')).toBe('pasted-20261029-080509.png');
  });
});

describe('paste priority (clip > files > url > html > note > nothing)', () => {
  const png = new File(['x'], 'shot.png', { type: 'image/png' });
  const clipText = `${BOARD_CLIP_PREFIX}${JSON.stringify({ projectId: 'p', origin: { x: 0, y: 0 }, nodes: [{ id: 'a', kind: 'note', x: 0, y: 0, w: 1, h: 1, data: {} }], edges: [] })}`;

  it('orders the readings of one clipboard', () => {
    expect(planPaste({ text: clipText, files: [png] }).kind).toBe('clip');
    expect(planPaste({ text: 'https://example.com', files: [png] })).toEqual({ kind: 'files', files: [png] });
    expect(planPaste({ text: '  https://example.com/a?b=1 ', files: [] })).toEqual({ kind: 'url', url: 'https://example.com/a?b=1' });
    expect(planPaste({ text: '<!DOCTYPE html><html></html>', files: [] }).kind).toBe('html');
    expect(planPaste({ text: '<html><body>x</body></html>', files: [] }).kind).toBe('html');
    expect(planPaste({ text: 'buy milk', files: [] })).toEqual({ kind: 'note', text: 'buy milk' });
    expect(planPaste({ text: '   ', files: [] })).toEqual({ kind: 'nothing' });
  });

  it('ignores files the board cannot show and URLs inside prose', () => {
    const zip = new File(['x'], 'a.zip', { type: 'application/zip' });
    expect(planPaste({ text: '', files: [zip] }).kind).toBe('nothing');
    expect(planPaste({ text: 'see https://example.com', files: [] }).kind).toBe('note');
    expect(planPaste({ text: '', files: [new File(['<p>'], 'page.html', { type: '' })] }).kind).toBe('files');
  });
});

function act(engine: ReturnType<typeof setup>['engine'], run: () => void): void {
  run();
  engine.store.syncFromData();
}

describe('pasting a clip', () => {
  it('adds board-native nodes and their edges in one undoable transaction at the pointer, and selects them', async () => {
    const { engine, data } = setup([noteDraft('n_a', 100, 200), noteDraft('n_b', 500, 260)], [lineage('e_ab', 'n_a', 'n_b')]);
    const doc = engine.store.getState().doc;
    const clip = parseClip(serializeClip(clipNodesFor(doc, ['n_a', 'n_b']), doc.edges.values(), PROJECT_ID))!;
    const copyFile = vi.fn();
    const ids = await pasteBoardClip({ engine, clip, at: { x: 3000, y: 3000 }, copyFile, notify: vi.fn() });
    expect(ids).toHaveLength(2);
    expect(copyFile).not.toHaveBeenCalled();
    const call = data.applyCalls.at(-1)!;
    expect(call.options).toMatchObject({ undoable: true, label: 'paste' });
    expect(call.ops.map((op) => op.op)).toEqual(['add', 'add', 'connect']);
    expect(call.ops[0]).toMatchObject({ op: 'add', node: { kind: 'note', x: 3000, y: 3000, text: 'hello' } });
    expect(call.ops[2]).toMatchObject({ op: 'connect', edge: { kind: 'lineage', from: ids[0], to: ids[1] } });
    expect(engine.store.getState().ui.selection).toEqual(ids);
  });

  it('pastes at the copied position + 24/24 when the pointer is not over the stage', async () => {
    const { engine, data } = setup([noteDraft('n_a', 100, 200)]);
    const doc = engine.store.getState().doc;
    const clip = parseClip(serializeClip(clipNodesFor(doc, ['n_a']), doc.edges.values(), PROJECT_ID))!;
    await pasteBoardClip({ engine, clip, at: null, copyFile: vi.fn(), notify: vi.fn() });
    expect(data.applyCalls.at(-1)!.ops[0]).toMatchObject({ node: { x: 124, y: 224 } });
  });

  it('copies the file of a file node still on the board (I1) and keeps the path of a cut one', async () => {
    const { engine, data } = setup([{ ...frameDraft('n_f', 0, 0, 'pages/home.html'), cover: coverRef } as BoardNodeDraft]);
    const doc = engine.store.getState().doc;
    const clip = parseClip(serializeClip(clipNodesFor(doc, ['n_f']), doc.edges.values(), PROJECT_ID))!;
    const copyFile = vi.fn(async () => 'pages/home-copy.html');
    await pasteBoardClip({ engine, clip, at: null, copyFile, notify: vi.fn() });
    expect(copyFile).toHaveBeenCalledWith('pages/home.html', PROJECT_ID);
    const added = data.applyCalls.at(-1)!.ops[0] as Extract<BoardOp, { op: 'add' }>;
    expect(added.node).toMatchObject({ kind: 'frame', ref: { path: 'pages/home-copy.html' } });
    expect(added.node).not.toHaveProperty('cover');

    // cut: the original node left the board, so the paste may show the same file again
    act(engine, () => engine.commands.removeNodes(['n_f']));
    engine.store.syncFromData();
    const reuse = vi.fn(async () => 'never.html');
    await pasteBoardClip({ engine, clip, at: null, copyFile: reuse, notify: vi.fn() });
    expect(reuse).not.toHaveBeenCalled();
    expect((data.applyCalls.at(-1)!.ops[0] as Extract<BoardOp, { op: 'add' }>).node).toMatchObject({ ref: { path: 'pages/home.html' } });
  });

  it('copies files across projects (toast) and skips nodes whose copy failed, with their edges', async () => {
    const { engine, data } = setup([noteDraft('n_x', 0, 0)]);
    const clip = parseClip(
      `${BOARD_CLIP_PREFIX}${JSON.stringify({
        projectId: 'p_other',
        origin: { x: 0, y: 0 },
        nodes: [
          { id: 'i1', kind: 'image', x: 0, y: 0, w: 400, h: 300, data: { ref: { path: 'a.png' } } },
          { id: 'i2', kind: 'image', x: 500, y: 0, w: 400, h: 300, data: { ref: { path: 'broken.png' } } },
          { id: 't', kind: 'note', x: 0, y: 400, w: 280, h: 220, data: { text: 'n' } },
        ],
        edges: [{ kind: 'lineage', from: 'i1', to: 'i2' }, { kind: 'lineage', from: 'i1', to: 't' }],
      })}`,
    )!;
    const copyFile = vi.fn(async (path: string) => (path === 'a.png' ? 'a.png' : null));
    const notify = vi.fn();
    const ids = await pasteBoardClip({ engine, clip, at: { x: 0, y: 1000 }, copyFile, notify });
    expect(copyFile).toHaveBeenCalledWith('a.png', 'p_other');
    expect(ids).toHaveLength(2);
    expect(data.applyCalls.at(-1)!.ops.map((op) => op.op)).toEqual(['add', 'add', 'connect']);
    expect(notify).toHaveBeenCalledWith({ key: 'board.drop.failed', vars: { name: 'broken.png' }, tone: 'danger' });
    expect(notify).toHaveBeenCalledWith({ key: 'board.paste.crossProject' });
  });
});

describe('menu copy / cut', () => {
  it('keeps an in-memory clip and cuts remove nodes from the board only', async () => {
    const { engine, data } = setup([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]);
    engine.commands.select(['n_a']);
    expect(await copyBoardSelection(engine)).toBe(true);
    expect(lastBoardClip()?.startsWith(BOARD_CLIP_PREFIX)).toBe(true);
    expect(data.apply).not.toHaveBeenCalled();
    engine.commands.select(['n_b']);
    expect(await copyBoardSelection(engine, true)).toBe(true);
    expect(data.applyCalls.at(-1)!.ops).toEqual([{ op: 'remove', ids: ['n_b'] }]);
    engine.commands.select([]);
    expect(await copyBoardSelection(engine)).toBe(false);
  });
});
