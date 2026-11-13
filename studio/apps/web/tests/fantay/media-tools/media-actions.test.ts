// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// Spec 05 §11: media actions — sendToChat dispatches STAGE_ATTACHMENT_EVENT (image/file), openInDesignEditor
// resolves `unavailable` without an ack at 1500 ms, useAsReference connects to the last active generator or
// creates one; crop output becomes a derived image node; amendment C5: the video-node "剪辑视频" action seeds a
// footage film through insertMotionFromBoard and is disabled while the video is still generating.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GenerationGraph, GenerationGraphNode, MediaNodeGeneration } from '@open-design/contracts';

const motion = vi.hoisted(() => ({ insertMotionFromBoard: vi.fn() }));
vi.mock('../../../src/fantay/motion/motion-projects', () => ({ insertMotionFromBoard: motion.insertMotionFromBoard }));

const imageOps = vi.hoisted(() => ({ cropToBlob: vi.fn() }));
vi.mock('../../../src/fantay/media-tools/image-ops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/fantay/media-tools/image-ops')>()),
  cropToBlob: imageOps.cropToBlob,
}));

// The node bodies below render without the thumbnail pipeline (no fetch, no detached <video>).
vi.mock('../../../src/fantay/media-tools/thumbnails', () => ({
  useImageSource: (url: string) => url,
  useVideoPoster: () => null,
}));

import { createElement, type ReactElement } from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

import { STAGE_ATTACHMENT_EVENT } from '../../../src/components/ChatComposer';
import { GenerationContext } from '../../../src/fantay/generation/GenerationProvider';
import { ImageNodeBody } from '../../../src/fantay/media-nodes/ImageNodeBody';
import { VideoNodeBody } from '../../../src/fantay/media-nodes/VideoNodeBody';
import { english } from '../../../src/i18n/dictionaries';
import { createGeneratorOnBoard } from '../../../src/fantay/generation/components/create-generator';
import { getGeneratorPanelFocusRequest, resetGeneratorUiStoreForTests } from '../../../src/fantay/generation/components/generator-ui-store';
import { buildMediaNodeActions, createMediaToolContext } from '../../../src/fantay/media-nodes/node-actions';
import type { MediaToolContext } from '../../../src/fantay/media-nodes/node-tools';
import {
  DESIGN_EDITOR_ACK_TIMEOUT_MS,
  cropImageNode,
  openInDesignEditor,
  sendToChat,
  useAsReference,
} from '../../../src/fantay/media-tools/actions';
import { FANTAY_OPEN_DESIGN_EDITOR_EVENT, type OpenDesignEditorDetail } from '../../../src/fantay/media-tools/events';

const t = english.t;

function imageNode(partial: Partial<GenerationGraphNode> = {}): GenerationGraphNode {
  const file = { path: 'assets/hero.png', mime: 'image/png', size: 1000, width: 1200, height: 800 };
  return {
    id: 'img1',
    kind: 'image',
    title: 'Hero',
    x: 100,
    y: 50,
    w: 320,
    h: 213,
    media: { file },
    image: { ...file, daemonReady: true },
    ...partial,
  };
}

function videoNode(partial: Partial<GenerationGraphNode> = {}): GenerationGraphNode {
  return { id: 'vid1', kind: 'video', title: 'Clip', x: 0, y: 400, w: 384, h: 216, media: { file: { path: 'clips/clip.mp4' } }, ...partial };
}

function generatorNode(id: string, title = ''): GenerationGraphNode {
  return {
    id,
    kind: 'generator',
    title,
    x: 900,
    y: 0,
    w: 320,
    h: 272,
    generator: { version: 1, surface: 'image', prompt: '', model: null, params: { aspect: '1:1', count: 1 }, runs: [] },
  };
}

function fakeGeneration(graph: GenerationGraph, overrides: Record<string, unknown> = {}) {
  let ids = 0;
  const board = {
    getGraph: () => graph,
    getNode: (id: string) => graph.nodes.find((node) => node.id === id) ?? null,
    apply: vi.fn(),
    subscribe: () => () => undefined,
    onNodesRemoved: () => () => undefined,
    select: vi.fn(),
    focus: vi.fn(),
  };
  const generation = {
    service: { moreLikeThis: vi.fn(async () => undefined) },
    projectId: 'p1',
    workspaceContext: null,
    board,
    onOpenSettings: vi.fn(),
    notify: vi.fn(),
    lastActiveGeneratorId: null as string | null,
    setLastActiveGenerator: vi.fn(),
    openToolDialog: vi.fn(),
    registerVideoElement: vi.fn(),
    videoElementOf: () => null,
    onRevealChat: vi.fn(),
    ...overrides,
  };
  const nextId = () => `id${(ids += 1)}`;
  return { generation, board, ids: { next: nextId } };
}

function contextFor(node: GenerationGraphNode, graph: GenerationGraph, overrides: Record<string, unknown> = {}) {
  const fake = fakeGeneration(graph, overrides);
  const ctx = createMediaToolContext(fake.generation as never, node, graph, t, { ids: fake.ids, now: () => 1_730_000_000_000 });
  return { ...fake, ctx };
}

beforeEach(() => {
  resetGeneratorUiStoreForTests();
  motion.insertMotionFromBoard.mockReset();
  imageOps.cropToBlob.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('sendToChat', () => {
  it('stages project files in the composer: images as image, videos as file', () => {
    const events: CustomEvent[] = [];
    const listener = (event: Event) => events.push(event as CustomEvent);
    window.addEventListener(STAGE_ATTACHMENT_EVENT, listener);
    const reveal = vi.fn();
    sendToChat(
      [
        { file: { path: 'board-media/crops/a.png', size: 42 }, title: 'Crop · Hero', kind: 'image' },
        { file: { path: 'clips/clip.mp4' }, kind: 'video' },
      ],
      reveal,
    );
    window.removeEventListener(STAGE_ATTACHMENT_EVENT, listener);
    expect(STAGE_ATTACHMENT_EVENT).toBe('opendesign:stage-attachment');
    expect(events).toHaveLength(1);
    expect(events[0]?.detail).toEqual({
      attachments: [
        { path: 'board-media/crops/a.png', name: 'Crop · Hero', kind: 'image', size: 42 },
        { path: 'clips/clip.mp4', name: 'clip.mp4', kind: 'file' },
      ],
    });
    expect(reveal).toHaveBeenCalledTimes(1);
  });
});

describe('openInDesignEditor', () => {
  it('resolves unavailable when nobody acks within 1500 ms', async () => {
    vi.useFakeTimers();
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const { ctx, generation } = contextFor(graph.nodes[0] as GenerationGraphNode, graph);
    const details: OpenDesignEditorDetail[] = [];
    const listener = (event: Event) => details.push((event as CustomEvent<OpenDesignEditorDetail>).detail);
    window.addEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, listener);
    let settled: string | null = null;
    void openInDesignEditor(ctx).then((result) => (settled = result));
    expect(details[0]?.request).toEqual({
      kind: 'new-from-image',
      image: expect.objectContaining({ path: 'assets/hero.png' }),
      title: 'Hero',
      sourceNodeId: 'img1',
    });
    expect(details[0]?.projectId).toBe('p1');
    await vi.advanceTimersByTimeAsync(DESIGN_EDITOR_ACK_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('unavailable');
    expect(generation.notify).toHaveBeenCalledWith({ tone: 'error', message: "The design editor isn't available yet" });
    window.removeEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, listener);
  });

  it('resolves opened on a positive ack', async () => {
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const { ctx, generation } = contextFor(graph.nodes[0] as GenerationGraphNode, graph);
    const listener = (event: Event) => (event as CustomEvent<OpenDesignEditorDetail>).detail.ack({ ok: true });
    window.addEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, listener);
    await expect(openInDesignEditor(ctx)).resolves.toBe('opened');
    window.removeEventListener(FANTAY_OPEN_DESIGN_EDITOR_EVENT, listener);
    expect(generation.notify).not.toHaveBeenCalled();
  });
});

describe('useAsReference', () => {
  it('connects the node to the last active generator', () => {
    const graph: GenerationGraph = { nodes: [imageNode(), generatorNode('gen1', 'Posters')], edges: [] };
    const { ctx, board, generation } = contextFor(graph.nodes[0] as GenerationGraphNode, graph, { lastActiveGeneratorId: 'gen1' });
    expect(useAsReference(ctx)).toEqual({ generatorId: 'gen1', created: false });
    expect(board.apply).toHaveBeenCalledWith(
      [{ type: 'edge.add', edge: { id: 'id1', from: 'img1', to: 'gen1', role: 'reference' } }],
      expect.objectContaining({ undoable: true, flush: true }),
    );
    expect(board.select).toHaveBeenCalledWith(['gen1']);
    expect(generation.notify).toHaveBeenCalledWith({ tone: 'success', message: 'Connected to "Posters"' });
  });

  it('does not duplicate an existing reference edge', () => {
    const graph: GenerationGraph = {
      nodes: [imageNode(), generatorNode('gen1')],
      edges: [{ id: 'e1', from: 'img1', to: 'gen1', role: 'reference', order: 0 }],
    };
    const { ctx, board } = contextFor(graph.nodes[0] as GenerationGraphNode, graph, { lastActiveGeneratorId: 'gen1' });
    expect(useAsReference(ctx)).toEqual({ generatorId: 'gen1', created: false });
    expect(board.apply).not.toHaveBeenCalled();
    expect(board.select).toHaveBeenCalledWith(['gen1']);
  });

  it('creates an image generator right of the node when there is no active one', () => {
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const { ctx, board, generation } = contextFor(graph.nodes[0] as GenerationGraphNode, graph);
    expect(useAsReference(ctx)).toEqual({ generatorId: 'id1', created: true });
    const [ops, meta] = board.apply.mock.calls[0] ?? [];
    expect(meta).toEqual(expect.objectContaining({ undoable: true, flush: true }));
    expect(ops).toEqual([
      { type: 'node.add', node: expect.objectContaining({ id: 'id1', kind: 'generator', x: 100 + 320 + 96, y: 50, data: expect.objectContaining({ surface: 'image' }) }) },
      { type: 'edge.add', edge: { id: 'id2', from: 'img1', to: 'id1', role: 'reference' } },
    ]);
    expect(board.select).toHaveBeenCalledWith(['id1']);
    expect(getGeneratorPanelFocusRequest()).toMatchObject({ nodeId: 'id1', target: 'prompt' });
    expect(generation.notify).toHaveBeenCalledWith({ tone: 'success', message: 'Connected to "Image generator"' });
  });

  it('refuses nodes without a picture', () => {
    const empty = imageNode({ media: {}, image: undefined });
    const graph: GenerationGraph = { nodes: [empty], edges: [] };
    const { ctx, board } = contextFor(empty, graph);
    expect(useAsReference(ctx)).toBeNull();
    expect(board.apply).not.toHaveBeenCalled();
  });
});

describe('cropImageNode', () => {
  it('saves the crop as a project file and adds a derived image node right of the source', async () => {
    imageOps.cropToBlob.mockResolvedValue(new Blob([new Uint8Array(16)], { type: 'image/png' }));
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const { ctx, board } = contextFor(graph.nodes[0] as GenerationGraphNode, graph);
    const upload = vi.fn(async (file: File, path: string) => ({ name: path, size: file.size, mtime: 9, kind: 'image' as const, mime: 'image/png' }));
    const id = await cropImageNode({ ...ctx, upload } as MediaToolContext, { x: 0, y: 0, width: 0.5, height: 0.5 });
    expect(id).toBe('id1');
    expect(imageOps.cropToBlob).toHaveBeenCalledWith('/api/projects/p1/raw/assets/hero.png', { x: 0, y: 0, width: 0.5, height: 0.5 });
    const path = upload.mock.calls[0]?.[1] ?? '';
    expect(path).toMatch(/^board-media\/crops\/crops-[0-9a-z]{6}-[0-9a-z]{6}\.png$/);
    expect(board.apply).toHaveBeenCalledWith(
      [
        {
          type: 'node.add',
          node: {
            id: 'id1',
            kind: 'image',
            x: 100 + 320 + 96,
            y: 50,
            w: 320,
            h: 213,
            title: 'Crop · Hero',
            data: { file: { path, mime: 'image/png', size: 16, mtime: 9, width: 600, height: 400 } },
          },
        },
        { type: 'edge.add', edge: { id: 'id2', from: 'img1', to: 'id1', role: 'derived' } },
      ],
      expect.objectContaining({ undoable: true, flush: true }),
    );
    expect(board.select).toHaveBeenCalledWith(['id1']);
  });

  it('toasts and adds nothing when the upload fails', async () => {
    imageOps.cropToBlob.mockResolvedValue(new Blob([new Uint8Array(4)], { type: 'image/png' }));
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const { ctx, board, generation } = contextFor(graph.nodes[0] as GenerationGraphNode, graph);
    await expect(cropImageNode({ ...ctx, upload: async () => null } as MediaToolContext)).resolves.toBeNull();
    expect(board.apply).not.toHaveBeenCalled();
    expect(generation.notify).toHaveBeenCalledWith({ tone: 'error', message: "Couldn't save to project files" });
  });
});

describe('node actions for the board ContextBar', () => {
  function actionsFor(node: GenerationGraphNode, kind: 'image' | 'video') {
    const graph: GenerationGraph = { nodes: [node], edges: [] };
    const fake = fakeGeneration(graph);
    return { ...fake, actions: buildMediaNodeActions({ generation: fake.generation as never, t }, node.id, kind) };
  }

  it('lists the image tools in table order and leaves out "one more" for plain images', () => {
    const { actions } = actionsFor(imageNode(), 'image');
    expect(actions.map((action) => [action.id, action.placement])).toEqual([
      ['use-as-reference', 'bar'],
      ['send-to-chat', 'bar'],
      ['crop', 'bar'],
      ['split', 'bar'],
      ['upscale', 'bar'],
      ['download', 'bar'],
      ['open-in-design', 'more'],
      ['view', 'more'],
    ]);
    expect(actions.every((action) => action.disabledReasonKey === undefined)).toBe(true);
  });

  it('opens the crop dialog through the provider', async () => {
    const { actions, generation } = actionsFor(imageNode(), 'image');
    await actions.find((action) => action.id === 'crop')?.run();
    expect(generation.openToolDialog).toHaveBeenCalledWith({ kind: 'crop', nodeId: 'img1' });
  });

  it('returns no actions for design nodes (the design host provides them)', () => {
    const graph: GenerationGraph = { nodes: [imageNode()], edges: [] };
    const fake = fakeGeneration(graph);
    expect(buildMediaNodeActions({ generation: fake.generation as never, t }, 'img1', 'design')).toEqual([]);
  });

  it('C5: "edit video" seeds a footage film from the video and shows the seam status as a toast', async () => {
    motion.insertMotionFromBoard.mockReturnValue({ status: 'opened-editor', projectId: 'p1', statusKey: 'motion.create.existingHasFilm' });
    const { actions, generation } = actionsFor(videoNode(), 'video');
    const edit = actions.find((action) => action.id === 'edit-video');
    expect(edit).toMatchObject({ labelKey: 'fantay.media.tool.editVideo', placement: 'bar' });
    expect(edit?.disabledReasonKey).toBeUndefined();
    await edit?.run();
    expect(motion.insertMotionFromBoard).toHaveBeenCalledWith({ projectId: 'p1', kind: 'footage', files: ['clips/clip.mp4'] });
    expect(generation.notify).toHaveBeenCalledWith({ tone: 'info', message: t('motion.create.existingHasFilm') });
  });

  it('C5: opening the create dialog needs no toast', async () => {
    motion.insertMotionFromBoard.mockReturnValue({ status: 'create-dialog', projectId: 'p1', request: {} });
    const { actions, generation } = actionsFor(videoNode(), 'video');
    await actions.find((action) => action.id === 'edit-video')?.run();
    expect(motion.insertMotionFromBoard).toHaveBeenCalledTimes(1);
    expect(generation.notify).not.toHaveBeenCalled();
  });

  it('C5: "edit video" is disabled while the video is still generating', async () => {
    const generation: MediaNodeGeneration = {
      candidates: [{ id: 'c1', runId: 'r1', index: 0, attempt: 0, status: 'running', outputStem: 'gen-a-b-1' }],
      request: {
        surface: 'video',
        model: 'vela/video',
        modelBase: 'vela/video',
        provider: 'vela',
        prompt: 'waves',
        promptSource: 'waves',
        references: [],
        generatorId: 'gen1',
        runId: 'r1',
        createdAt: 1,
      },
    };
    const { actions } = actionsFor(videoNode({ media: { generation } }), 'video');
    const edit = actions.find((action) => action.id === 'edit-video');
    expect(edit?.disabledReasonKey).toBe('fantay.media.tool.videoGenerating');
    expect(t('fantay.media.tool.videoGenerating')).toBe('The video is still generating');
    await edit?.run();
    expect(motion.insertMotionFromBoard).not.toHaveBeenCalled();
    expect(actions.find((action) => action.id === 'more-like-this')).toBeDefined();
  });

  it('video tools: capture frame, edit video and download on the bar', () => {
    const { actions } = actionsFor(videoNode(), 'video');
    expect(actions.filter((action) => action.placement === 'bar').map((action) => action.id)).toEqual([
      'send-to-chat',
      'capture-current',
      'edit-video',
      'download',
    ]);
    expect(actions.find((action) => action.id === 'capture-current')?.labelKey).toBe('fantay.media.tool.captureFrame');
  });
});

describe('media node bodies: double-click opens the preview (spec 05 §6.3)', () => {
  afterEach(() => cleanup());

  function renderBody(node: GenerationGraphNode, body: ReactElement) {
    const fake = fakeGeneration({ nodes: [node], edges: [] });
    const outer = vi.fn();
    render(
      createElement(
        'div',
        { onDoubleClick: outer },
        createElement(GenerationContext.Provider, { value: fake.generation as never }, body),
      ),
    );
    return { openToolDialog: fake.generation.openToolDialog, outer };
  }

  it('image: opens the preview of the node and keeps the double-click from the board', () => {
    const { openToolDialog, outer } = renderBody(
      imageNode(),
      createElement(ImageNodeBody, { nodeId: 'img1', selected: false, zoom: 1, width: 320, height: 213 }),
    );
    fireEvent.doubleClick(screen.getByRole('img', { name: 'Hero' }));
    expect(openToolDialog).toHaveBeenCalledWith({ kind: 'preview', nodeId: 'img1' });
    expect(outer).not.toHaveBeenCalled();
  });

  it('image without media: nothing to preview, the board handles the double-click', () => {
    const { openToolDialog, outer } = renderBody(
      imageNode({ media: {}, image: undefined }),
      createElement(ImageNodeBody, { nodeId: 'img1', selected: false, zoom: 1, width: 320, height: 213 }),
    );
    fireEvent.doubleClick(screen.getByTestId('fx-media-node').firstElementChild as Element);
    expect(openToolDialog).not.toHaveBeenCalled();
    expect(outer).toHaveBeenCalledTimes(1);
  });

  it('video: the poster opens the preview; the play button and the live <video> keep their own clicks', () => {
    const poster = renderBody(
      videoNode(),
      createElement(VideoNodeBody, { nodeId: 'vid1', selected: false, zoom: 1, live: false, requestLive: vi.fn() }),
    );
    fireEvent.doubleClick(screen.getByTestId('fx-media-play'));
    expect(poster.openToolDialog).not.toHaveBeenCalled();
    fireEvent.doubleClick(screen.getByTestId('fx-media-node').firstElementChild as Element);
    expect(poster.openToolDialog).toHaveBeenCalledWith({ kind: 'preview', nodeId: 'vid1' });
    cleanup();

    const live = renderBody(
      videoNode(),
      createElement(VideoNodeBody, { nodeId: 'vid1', selected: true, zoom: 1, live: true, requestLive: vi.fn() }),
    );
    fireEvent.doubleClick(screen.getByLabelText('Clip'));
    expect(live.openToolDialog).not.toHaveBeenCalled();
  });
});

describe('createGeneratorOnBoard (BoardExtensions.createGenerator)', () => {
  function boardWith(nodes: GenerationGraphNode[]) {
    const graph: GenerationGraph = { nodes, edges: [] };
    return fakeGeneration(graph);
  }

  it('centres a new image generator on the requested point', () => {
    const { board, ids } = boardWith([]);
    expect(createGeneratorOnBoard(board as never, { selectedIds: [], at: { x: 500, y: 300 } }, ids)).toBe('id1');
    // The frame previews its output: an image generator is the 1:1 media node's 320 × 320.
    expect(board.apply).toHaveBeenCalledWith(
      [{ type: 'node.add', node: expect.objectContaining({ id: 'id1', kind: 'generator', x: 340, y: 140, w: 320, h: 320 }) }],
      expect.objectContaining({ undoable: true, flush: true }),
    );
    expect(board.select).toHaveBeenCalledWith(['id1']);
    expect(getGeneratorPanelFocusRequest()).toMatchObject({ nodeId: 'id1', target: 'prompt' });
  });

  it('connects the node a connector was dragged from when it can be a reference', () => {
    const image = imageNode();
    const { board, ids } = boardWith([image, videoNode()]);
    createGeneratorOnBoard(board as never, { selectedIds: [], at: { x: 900, y: 100 }, connectFrom: 'img1', surface: 'video' }, ids);
    expect(board.apply.mock.calls[0]?.[0]).toEqual([
      { type: 'node.add', node: expect.objectContaining({ id: 'id1', data: expect.objectContaining({ surface: 'video' }) }) },
      { type: 'edge.add', edge: { id: 'id2', from: 'img1', to: 'id1', role: 'reference' } },
    ]);
    board.apply.mockClear();
    createGeneratorOnBoard(board as never, { selectedIds: [], at: { x: 900, y: 600 }, connectFrom: 'vid1' }, ids);
    expect(board.apply.mock.calls[0]?.[0]).toHaveLength(1);
  });

  it('places the generator right of the selection and references the eligible selected nodes', () => {
    const { board, ids } = boardWith([imageNode(), videoNode()]);
    createGeneratorOnBoard(board as never, { selectedIds: ['img1', 'vid1'], at: { x: 0, y: 0 } }, ids);
    const ops = board.apply.mock.calls[0]?.[0] as Array<{ type: string; node?: { x: number }; edge?: { from: string } }>;
    expect(ops[0]?.type).toBe('node.add');
    expect(ops[0]?.node?.x).toBe(Math.max(100 + 320, 0 + 384) + 96);
    expect(ops.filter((op) => op.type === 'edge.add').map((op) => op.edge?.from)).toEqual(['img1']);
  });
});
