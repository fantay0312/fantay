// Spec 05 §4.2 / plan R3–R4: the generation board port maps the board contract (flattened generator fields,
// `generation` / `refProxy` on media nodes, `lineage` stored for the graph's `derived` role, edge order) to the
// generation graph and back. The fake store applies ops with the real contract engine, optimistically.
import { describe, expect, it, vi } from 'vitest';

import {
  applyBoardOps,
  compileGeneration,
  createGeneratorNodeInput,
  paramSupportFor,
  planGenerationRun,
  referenceLabelSetFor,
  type BoardDocument,
  type BoardEdge,
  type BoardNode,
  type BoardOp,
  type GenerationBoardOp,
  type MediaNodeData,
} from '@open-design/contracts';

import {
  createGenerationBoardPort,
  generationOpsToBoardOps,
  toGenerationGraph,
  type BoardStoreLike,
} from '../../../src/fantay/generation/board-adapter';
import type { BoardApplyOptions } from '../../../src/fantay/board/data/types';

const actor = { kind: 'user' as const };
function stamped(node: Record<string, unknown>): BoardNode {
  return { createdAt: 1, updatedAt: 1, createdBy: actor, updatedBy: actor, rev: 1, ...node } as unknown as BoardNode;
}
function edge(id: string, kind: BoardEdge['kind'], from: string, to: string, createdAt: number): BoardEdge {
  return { id, kind, from, to, createdAt, createdBy: actor, updatedBy: actor, rev: 1 };
}
function doc(nodes: BoardNode[], edges: BoardEdge[] = []): BoardDocument {
  return {
    schemaVersion: 1,
    projectId: 'p1',
    revision: 3,
    updatedAt: 1,
    updatedBy: null,
    viewport: null,
    settings: { background: 'dots', autoPlace: true },
    nodes,
    edges,
  };
}

/** Optimistic in-memory store: `apply` runs the contract engine synchronously (04 §7.2). */
function memoryStore(initial: BoardDocument) {
  let board = initial;
  const listeners = new Set<() => void>();
  const applied: Array<{ ops: BoardOp[]; options?: BoardApplyOptions }> = [];
  let id = 0;
  let now = 100;
  const store: BoardStoreLike & { applied: typeof applied; set(next: BoardDocument): void; board(): BoardDocument } = {
    applied,
    getState: () => ({ board }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async apply(ops, options) {
      applied.push({ ops, ...(options ? { options } : {}) });
      const outcome = applyBoardOps({ settings: board.settings, nodes: board.nodes, edges: board.edges }, ops, {
        baseRevision: board.revision,
        nextRevision: board.revision + 1,
        actor: { kind: 'user', clientId: 'tab' },
        now: (now += 1),
        newId: (prefix) => `${prefix}_x${++id}`,
        checkConflicts: false,
      });
      if (!outcome.ok) throw new Error(`invalid ops: ${JSON.stringify(outcome)}`);
      board = { ...board, ...outcome.content };
      for (const listener of [...listeners]) listener();
      return { ok: true, results: outcome.results };
    },
    set(next) {
      board = next;
      for (const listener of [...listeners]) listener();
    },
    board: () => board,
  };
  return store;
}

const generatorNode = stamped({
  id: 'n_gen',
  kind: 'generator',
  x: 400,
  y: 0,
  w: 320,
  h: 272,
  title: 'Hero shots',
  version: 1,
  surface: 'image',
  prompt: 'a bike like @[node:n_img]',
  model: 'gpt-image-2',
  params: { aspect: '1:1', count: 2 },
  templateId: 'tpl-1',
  runs: [],
});
const imageNode = stamped({ id: 'n_img', kind: 'image', x: 0, y: 0, w: 320, h: 320, ref: { path: 'refs/bike.png' }, naturalWidth: 1024, naturalHeight: 768 });
const svgNode = stamped({ id: 'n_svg', kind: 'image', x: 0, y: 400, w: 320, h: 320, ref: { path: 'refs/logo.svg' }, refProxy: { path: 'board-media/refs/ref-aaaaaa.png', sourceKey: 'refs/logo.svg@0' } });
const frameNode = stamped({
  id: 'n_frame',
  kind: 'frame',
  x: 0,
  y: 800,
  w: 1440,
  h: 900,
  ref: { path: 'index.html' },
  cover: { source: 'board-cover', digest: 'a'.repeat(64), mime: 'image/webp', width: 720, height: 450, capturedAt: 5 },
});
const noteNode = stamped({ id: 'n_note', kind: 'note', x: 0, y: 2000, w: 280, h: 220, text: 'warm light', parentId: 'n_group' });
const groupNode = stamped({ id: 'n_group', kind: 'group', x: -20, y: 1950, w: 400, h: 300, role: 'section', layout: 'free' });

describe('toGenerationGraph', () => {
  const board = doc(
    [groupNode, generatorNode, imageNode, svgNode, frameNode, noteNode],
    [
      edge('e_2', 'reference', 'n_frame', 'n_gen', 5),
      edge('e_1', 'reference', 'n_img', 'n_gen', 5),
      edge('e_3', 'lineage', 'n_img', 'n_svg', 7),
      edge('e_4', 'reference', 'n_note', 'n_gen', 9),
    ].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1)),
  );
  const graph = toGenerationGraph(board);
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));

  it('reads the flattened generator fields (R3a)', () => {
    expect(byId.get('n_gen')).toMatchObject({
      kind: 'generator',
      title: 'Hero shots',
      generator: {
        version: 1,
        surface: 'image',
        prompt: 'a bike like @[node:n_img]',
        model: 'gpt-image-2',
        params: { aspect: '1:1', count: 2 },
        templateId: 'tpl-1',
        runs: [],
      },
    });
  });

  it('turns image refs into media files and daemon-ready pictures; a matching refProxy wins', () => {
    expect(byId.get('n_img')?.media?.file).toEqual({ path: 'refs/bike.png', width: 1024, height: 768 });
    expect(byId.get('n_img')?.image).toEqual({ path: 'refs/bike.png', width: 1024, height: 768, daemonReady: true });
    expect(byId.get('n_svg')?.image).toEqual({ path: 'board-media/refs/ref-aaaaaa.png', daemonReady: true });
  });

  it('exposes frame/web/design covers as not-ready pictures with a cover pseudo path', () => {
    expect(byId.get('n_frame')).toMatchObject({
      kind: 'other',
      image: { path: `board-cover:${'a'.repeat(64)}`, mime: 'image/webp', width: 720, height: 450, daemonReady: false },
    });
  });

  it('lists group members in paint order and note text', () => {
    expect(byId.get('n_group')?.memberIds).toEqual(['n_note']);
    expect(byId.get('n_note')).toMatchObject({ kind: 'note', text: 'warm light' });
  });

  it('keeps the board edge order (createdAt, then id) and maps lineage to derived (R3e)', () => {
    expect(graph.edges.map((entry) => [entry.id, entry.role, entry.order])).toEqual([
      ['e_1', 'reference', 0],
      ['e_2', 'reference', 1],
      ['e_3', 'derived', 2],
      ['e_4', 'reference', 3],
    ]);
    const compiled = compileGeneration(graph, 'n_gen', { maxReferences: 5, requiresReference: false, labels: referenceLabelSetFor('en') });
    expect(compiled.inputs.map((input) => input.nodeId)).toEqual(['n_img', 'n_frame', 'n_note']);
    expect(compiled.warnings).toContainEqual({ kind: 'reference-not-ready', nodeId: 'n_frame' });
  });

  it('accepts a {board} response and reads anything else as an empty graph', () => {
    expect(toGenerationGraph({ board }).nodes).toHaveLength(6);
    expect(toGenerationGraph(null)).toEqual({ nodes: [], edges: [] });
  });

  it('leaves missing or pending media out of the references', () => {
    const graphWithMissing = toGenerationGraph(
      doc([
        stamped({ id: 'n_gone', kind: 'image', x: 0, y: 0, w: 10, h: 10, ref: { path: 'gone.png' }, missing: { since: 1 } }),
        stamped({ id: 'n_wait', kind: 'image', x: 0, y: 0, w: 10, h: 10, ref: null, pending: { mediaTaskId: 't1', status: 'running' } }),
      ]),
    );
    expect(graphWithMissing.nodes.map((node) => node.image)).toEqual([undefined, undefined]);
  });
});

describe('generationOpsToBoardOps', () => {
  const board = doc([generatorNode, imageNode]);

  it('adds a generator with its data flattened onto the node', () => {
    const input = createGeneratorNodeInput({ id: 'n_new', x: 10, y: 20, surface: 'video', prompt: 'waves' });
    const [op] = generationOpsToBoardOps(board, [{ type: 'node.add', node: input }]);
    expect(op).toEqual({
      op: 'add',
      node: {
        id: 'n_new',
        x: 10,
        y: 20,
        // The frame previews its output: the 16:9 video media node's 384 × 216.
        w: 384,
        h: 216,
        kind: 'generator',
        version: 1,
        surface: 'video',
        prompt: 'waves',
        model: null,
        params: { aspect: '16:9', count: 1, length: 5 },
        runs: [],
      },
    });
  });

  it('patches generator keys, clearing templateId with null', () => {
    const ops = generationOpsToBoardOps(board, [
      { type: 'node.patchData', id: 'n_gen', patch: { prompt: 'new', model: null, templateId: undefined, params: { aspect: '16:9', count: 1 } } },
    ]);
    expect(ops).toEqual([
      { op: 'update', id: 'n_gen', patch: { prompt: 'new', model: null, params: { aspect: '16:9', count: 1 }, templateId: null } },
    ]);
  });

  it('mirrors the media file into ref + natural size and clears refProxy with null', () => {
    const ops = generationOpsToBoardOps(board, [
      {
        type: 'node.patchData',
        id: 'n_img',
        patch: { file: { path: 'refs/bike-2.png', width: 512, height: 512 }, refProxy: undefined },
      },
    ]);
    expect(ops).toEqual([
      { op: 'update', id: 'n_img', patch: { ref: { path: 'refs/bike-2.png' }, naturalWidth: 512, naturalHeight: 512, refProxy: null } },
    ]);
  });

  it('does not set a ref whose extension cannot live on the node, and drops no-op patches', () => {
    expect(
      generationOpsToBoardOps(board, [{ type: 'node.patchData', id: 'n_img', patch: { file: { path: 'out/clip.mp4' } } }]),
    ).toEqual([]);
    expect(
      generationOpsToBoardOps(board, [
        { type: 'node.patchData', id: 'n_img', patch: { file: { path: 'refs/bike.png', width: 1024, height: 768 } } },
      ]),
    ).toEqual([]);
    expect(generationOpsToBoardOps(board, [{ type: 'node.patchData', id: 'n_nope', patch: { prompt: 'x' } }])).toEqual([]);
  });

  it('stores the derived role as lineage and connects idempotently', () => {
    const ops = generationOpsToBoardOps(board, [
      { type: 'edge.add', edge: { id: 'e_new', from: 'n_img', to: 'n_gen', role: 'reference' } },
      { type: 'edge.add', edge: { id: 'e_der', from: 'n_img', to: 'n_gen', role: 'derived' } },
      { type: 'edge.remove', id: 'e_old' },
    ]);
    expect(ops).toEqual([
      { op: 'connect', edge: { id: 'e_new', kind: 'reference', from: 'n_img', to: 'n_gen' }, ifAbsent: true },
      { op: 'connect', edge: { id: 'e_der', kind: 'lineage', from: 'n_img', to: 'n_gen' }, ifAbsent: true },
      { op: 'disconnect', ids: ['e_old'] },
    ]);
  });

  it('plans a run that the contract engine accepts, with the output node owned by the generator', () => {
    const graph = toGenerationGraph(board);
    const model = { id: 'gpt-image-2', provider: 'openai', caps: ['t2i', 'i2i'] };
    const support = paramSupportFor(model, 'image');
    const compiled = compileGeneration(graph, 'n_gen', { maxReferences: support.maxReferences, requiresReference: false, labels: referenceLabelSetFor('en') });
    let n = 0;
    const plan = planGenerationRun({
      graph,
      generatorId: 'n_gen',
      compiled,
      model,
      params: { aspect: '1:1', count: 2 },
      support,
      now: 50,
      ids: { next: () => `id-${++n}` },
      title: 'a bike',
    });
    const ops = generationOpsToBoardOps(board, plan.ops);
    const outcome = applyBoardOps({ settings: board.settings, nodes: board.nodes, edges: board.edges }, ops, {
      baseRevision: board.revision,
      nextRevision: board.revision + 1,
      actor,
      now: 60,
      newId: () => 'unused',
      checkConflicts: true,
    });
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const output = outcome.content.nodes.find((node) => node.id === plan.outputNodeId) as unknown as Record<string, unknown>;
    expect(output).toMatchObject({ kind: 'image', ref: null, title: 'a bike', origin: { source: 'generator', generatorNodeId: 'n_gen' } });
    expect((output.generation as MediaNodeData['generation'])?.candidates).toHaveLength(2);
    const generator = outcome.content.nodes.find((node) => node.id === 'n_gen') as unknown as { runs: Array<{ runId: string }> };
    expect(generator.runs[0]?.runId).toBe(plan.runId);
    expect(outcome.content.edges.find((entry) => entry.to === plan.outputNodeId)?.kind).toBe('output');
  });
});

describe('createGenerationBoardPort', () => {
  it('returns the same graph object until the board changes, and reuses unchanged node objects', async () => {
    const store = memoryStore(doc([generatorNode, imageNode]));
    const port = createGenerationBoardPort(store, { select: vi.fn(), focus: vi.fn() });
    const first = port.getGraph();
    expect(port.getGraph()).toBe(first);
    port.apply([{ type: 'node.setTitle', id: 'n_gen', title: 'Renamed' }], { label: 'rename', undoable: true, flush: false });
    const second = port.getGraph();
    expect(second).not.toBe(first);
    expect(port.getNode('n_gen')?.title).toBe('Renamed');
    expect(second.nodes.find((node) => node.id === 'n_img')).toBe(first.nodes.find((node) => node.id === 'n_img'));
  });

  it('maps op meta to store options (service writes are silent and not undoable)', () => {
    const store = memoryStore(doc([generatorNode]));
    const port = createGenerationBoardPort(store);
    port.apply([{ type: 'node.patchData', id: 'n_gen', patch: { prompt: 'typing' } }], {
      label: 'prompt',
      undoable: true,
      flush: false,
      coalesceKey: 'prompt:n_gen',
    });
    port.apply([{ type: 'node.patchData', id: 'n_gen', patch: { prompt: 'service' } }], { label: 'generation.result', undoable: false, flush: true });
    expect(store.applied.map((entry) => entry.options)).toEqual([
      { undoable: true, silentConflict: false, label: 'prompt', coalesceKey: 'prompt:n_gen' },
      { undoable: false, silentConflict: true, label: 'generation.result' },
    ]);
  });

  it('does not call the store for ops that translate to nothing', () => {
    const store = memoryStore(doc([generatorNode]));
    const port = createGenerationBoardPort(store);
    port.apply([], { label: 'x', undoable: false, flush: false });
    port.apply([{ type: 'node.patchData', id: 'n_missing', patch: { prompt: 'x' } } as GenerationBoardOp], { label: 'x', undoable: false, flush: false });
    expect(store.applied).toHaveLength(0);
  });

  it('notifies removed node ids, and treats an unloaded board as unknown', () => {
    const store = memoryStore(doc([generatorNode, imageNode]));
    const port = createGenerationBoardPort(store);
    const removed = vi.fn();
    const stop = port.onNodesRemoved(removed);
    store.set(doc([generatorNode]));
    expect(removed).toHaveBeenCalledWith(['n_img']);
    store.set(null as unknown as BoardDocument);
    store.set(doc([generatorNode]));
    expect(removed).toHaveBeenCalledTimes(1);
    stop();
    store.set(doc([]));
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('forwards select/focus and exposes pick mode only when the engine provides it', () => {
    const ui = { select: vi.fn(), focus: vi.fn() };
    const port = createGenerationBoardPort(memoryStore(doc([])), ui);
    port.select(['a']);
    port.focus('b');
    expect(ui.select).toHaveBeenCalledWith(['a']);
    expect(ui.focus).toHaveBeenCalledWith('b');
    expect(port.startReferencePick).toBeUndefined();
    const start = vi.fn();
    const withPick = createGenerationBoardPort(memoryStore(doc([])), { ...ui, startReferencePick: start, stopReferencePick: vi.fn() });
    expect(typeof withPick.startReferencePick).toBe('function');
  });
});
