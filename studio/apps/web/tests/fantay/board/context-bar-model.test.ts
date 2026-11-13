// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from 'vitest';
import { ImageDown } from 'lucide-react';
import type { BoardNodeDraft } from '@open-design/contracts';

import { contextBarModelFor, modesFor, type ContextBarInput, type ContextBarOps } from '../../../src/fantay/board/chrome/context-bar-model';
import { exportOutputSize, frameExportName, renderFrameImage, type FrameExportDeps } from '../../../src/fantay/board/chrome/frame-export';
import type { BoardExtensions } from '../../../src/fantay/board/extensions';
import { toEngineNode } from '../../../src/fantay/board/model/contract-adapter';
import type { EngineNode, NodeRuntime } from '../../../src/fantay/board/model/types';
import { frameDraft, makeBoard, noteDraft } from './engine-fixtures';

function nodes(...drafts: BoardNodeDraft[]): EngineNode[] {
  return makeBoard(drafts).nodes.map(toEngineNode);
}

function ops(): ContextBarOps {
  const names: Array<keyof ContextBarOps> = [
    'openInFiles', 'openBrowserTab', 'openExternal', 'reload', 'toggleMaximize', 'refreshCover', 'copyPath', 'download', 'addToChat', 'copyAsPng',
    'remove', 'deleteFile', 'duplicate', 'rename', 'group', 'ungroup', 'zoomTo', 'setLocked', 'togglePlay', 'toggleMute',
    'openStudio', 'openEditor',
  ];
  return Object.fromEntries(names.map((name) => [name, vi.fn()])) as unknown as ContextBarOps;
}

function model(selection: EngineNode[], extra: Partial<ContextBarInput> = {}) {
  return contextBarModelFor({
    selection,
    runtime: new Map(),
    mode: null,
    readOnly: false,
    hostAvailable: false,
    extensions: undefined,
    hasBrowserTab: false,
    ops: ops(),
    ...extra,
  });
}

const web = (id: string): BoardNodeDraft => ({ kind: 'web', id, x: 0, y: 0, w: 1280, h: 800, url: 'https://example.com', device: 'desktop' }) as BoardNodeDraft;
const image = (id: string): BoardNodeDraft => ({ kind: 'image', id, x: 0, y: 0, w: 400, h: 300, ref: { path: 'a.png' } }) as BoardNodeDraft;
const video = (id: string): BoardNodeDraft => ({ kind: 'video', id, x: 0, y: 0, w: 640, h: 360, ref: { path: 'clip.mp4' } }) as BoardNodeDraft;
const design = (id: string): BoardNodeDraft => ({ kind: 'design', id, x: 0, y: 0, w: 800, h: 600, ref: { path: 'designs/a.fig' }, format: 'fig' }) as BoardNodeDraft;
const ids = (list: Array<{ id: string }>) => list.map((entry) => entry.id);

describe('context bar model (03 §6.3)', () => {
  it('is empty without a selection', () => {
    expect(model([])).toEqual({ kind: 'none', widgets: [], actions: [], more: [] });
  });

  it('frame: Navigate / Edit / Capture, Size and Export, Open in Files; reload / cover / path / chat / PNG / remove in More', () => {
    const [frame] = nodes(frameDraft('n_f', 0, 0, 'index.html'));
    const m = model([frame!]);
    expect(m.kind).toBe('single-live');
    expect(m.modes).toEqual([
      { mode: 'navigate', enabled: true },
      { mode: 'edit', enabled: true },
      { mode: 'capture', enabled: true },
    ]);
    expect(m.widgets.map((widget) => widget.type)).toEqual(['frame-size', 'frame-export']);
    expect(ids(m.actions)).toEqual(['open-in-files', 'maximize']);
    expect(ids(m.more)).toEqual(['reload', 'refresh-cover', 'copy-path', 'add-to-chat', 'copy-png', 'remove']);
  });

  it('web: Edit never, Capture only with the desktop host, read-only blocks Capture', () => {
    const [page] = nodes(web('n_w'));
    expect(model([page!]).modes).toEqual([
      { mode: 'navigate', enabled: true },
      { mode: 'edit', enabled: false, reasonKey: 'board.mode.reason.webEdit' },
      { mode: 'capture', enabled: false, reasonKey: 'board.mode.reason.webCapture' },
    ]);
    expect(model([page!], { hostAvailable: true }).modes?.[2]).toEqual({ mode: 'capture', enabled: true });
    expect(model([page!], { hostAvailable: true, readOnly: true }).modes?.[2]).toEqual({ mode: 'capture', enabled: false, reasonKey: 'board.mode.reason.readOnly' });
    const withTab = model([page!], { hasBrowserTab: true });
    expect(ids(withTab.actions)).toEqual(['reload', 'open-browser-tab', 'maximize']);
    expect(ids(model([page!]).more)).toEqual(['open-external', 'refresh-cover', 'remove']);
    expect(model([page!]).more.find((action) => action.id === 'refresh-cover')?.disabledReasonKey).toBe('board.mode.reason.webCapture');
  });

  it('frame disabled reasons: read-only, over 2 MiB, building, powered page, missing file', () => {
    const [frame] = nodes(frameDraft('n_f', 0, 0, 'index.html'));
    const reasons = (runtime: Partial<NodeRuntime>, extra: Partial<Parameters<typeof modesFor>[2]> = {}) =>
      modesFor(frame!, { phase: 'ready', ...runtime } as NodeRuntime, { readOnly: false, hostAvailable: false, ...extra })!.map((entry) => entry.reasonKey ?? null);
    expect(reasons({}, { readOnly: true })).toEqual([null, 'board.mode.reason.readOnly', 'board.mode.reason.readOnly']);
    expect(reasons({ fileSize: 3 * 1024 * 1024 })).toEqual([null, 'board.mode.reason.tooLarge', 'board.mode.reason.tooLarge']);
    // a large page can still be captured from the compositor on desktop
    expect(reasons({ fileSize: 3 * 1024 * 1024 }, { hostAvailable: true })).toEqual([null, 'board.mode.reason.tooLarge', null]);
    expect(reasons({ phase: 'building' })).toEqual(['board.mode.reason.building', 'board.mode.reason.building', null]);
    expect(reasons({}, { facts: { powered: true } })).toEqual([null, 'board.mode.reason.powered', 'board.mode.reason.powered']);
    expect(reasons({ phase: 'missing' })).toEqual(['board.node.state.missing', 'board.node.state.missing', 'board.node.state.missing']);
  });

  it('a live-artifact frame has no file to edit or export', () => {
    const [frame] = nodes({ kind: 'frame', id: 'n_la', x: 0, y: 0, w: 1440, h: 900, ref: null, liveArtifactId: 'la_1', device: 'desktop' } as BoardNodeDraft);
    const m = model([frame!]);
    expect(m.modes?.[1]).toEqual({ mode: 'edit', enabled: false, reasonKey: 'board.insert.unavailable' });
    expect(m.widgets[1]).toEqual({ type: 'frame-export', nodeId: 'n_la', disabledReasonKey: 'board.export.unavailable' });
    expect(ids(m.actions)).toEqual(['maximize']);
  });

  it('dispatches extension node actions for image, video and design (C5) and keeps the built-ins', () => {
    const run = vi.fn();
    const nodeActions = vi.fn((nodeId: string, kind: 'image' | 'video' | 'design') => [
      { id: `${kind}.tool`, labelKey: 'board.export.image' as const, icon: ImageDown, placement: 'bar' as const, run },
      { id: `${kind}.later`, labelKey: 'board.export.image' as const, icon: ImageDown, placement: 'more' as const, run, disabledReasonKey: 'board.insert.unavailable' as const },
      ...(kind === 'design' && nodeId ? [{ id: 'design.open', labelKey: 'board.node.openEditor' as const, icon: ImageDown, placement: 'bar' as const, run }] : []),
    ]);
    const extensions: BoardExtensions = { nodeActions };
    const [img, vid, doc] = nodes(image('n_i'), video('n_v'), design('n_d'));

    const imageModel = model([img!], { extensions });
    expect(nodeActions).toHaveBeenCalledWith('n_i', 'image');
    expect(ids(imageModel.actions)).toEqual(['download', 'attach-to-chat', 'image.tool']);
    expect(ids(imageModel.more)).toEqual(['copy-png', 'copy-path', 'image.later', 'remove', 'delete-file']);
    expect(imageModel.more.find((action) => action.id === 'image.later')?.disabledReasonKey).toBe('board.insert.unavailable');
    expect(imageModel.more.find((action) => action.id === 'delete-file')?.tone).toBe('danger');

    const videoModel = model([vid!], { extensions });
    expect(nodeActions).toHaveBeenCalledWith('n_v', 'video');
    expect(ids(videoModel.actions)).toEqual(['play', 'mute', 'download', 'video.tool']);
    // the generation extension draws its own video body: no built-in play/mute
    expect(ids(model([vid!], { extensions: { ...extensions, renderVideoBody: () => null } }).actions)).toEqual(['download', 'video.tool']);

    // the extension's own "open" replaces the built-in Open editor
    const designModel = model([doc!], { extensions });
    expect(designModel.widgets).toEqual([]);
    expect(ids(designModel.actions)).toEqual(['design.tool', 'design.open']);
    // without extensions: Open editor is disabled with "not available yet"
    expect(model([doc!]).widgets).toEqual([{ type: 'open-editor', nodeId: 'n_d', path: 'designs/a.fig', disabledReasonKey: 'board.insert.unavailable' }]);
    imageModel.actions[2]!.run();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('notes and shapes get their style widgets; read-only drops every edit', () => {
    const [note] = nodes(noteDraft('n_n', 0, 0));
    expect(model([note!]).widgets.map((widget) => widget.type)).toEqual(['note-color', 'note-size']);
    expect(ids(model([note!]).more)).toEqual(['duplicate', 'remove']);
    expect(model([note!], { readOnly: true })).toMatchObject({ widgets: [], actions: [], more: [] });
    const [rect, text] = nodes(
      { kind: 'shape', id: 'n_r', x: 0, y: 0, w: 100, h: 100, shape: 'rect' } as BoardNodeDraft,
      { kind: 'shape', id: 'n_t', x: 0, y: 200, w: 240, h: 36, shape: 'text', text: 'Hi' } as BoardNodeDraft,
    );
    expect(model([rect!]).widgets.map((widget) => widget.type)).toEqual(['shape-fill', 'shape-stroke', 'shape-radius']);
    expect(model([text!]).widgets.map((widget) => widget.type)).toEqual(['text-size', 'text-weight']);
  });

  it('multi-selection: count, Group when allowed, Align, Remove', () => {
    const list = nodes(noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0));
    const m = model(list);
    expect(m.kind).toBe('multi');
    expect(m.countLabel).toEqual({ key: 'board.selection.count', vars: { count: 2 } });
    expect(ids(m.actions)).toEqual(['group', 'remove']);
    expect(m.widgets).toEqual([{ type: 'align', nodeIds: ['n_a', 'n_b'] }]);
  });

  it('motion: a film plays in its own body (07), so the bar has no Play/Pause; a composition keeps it', () => {
    const [film, composition] = nodes(
      { kind: 'motion', id: 'n_film', x: 0, y: 0, w: 640, h: 360, source: { type: 'movie', projectId: 'p_board_test' } } as BoardNodeDraft,
      { kind: 'motion', id: 'n_comp', x: 0, y: 400, w: 640, h: 360, source: { type: 'composition', ref: { path: 'motion-source/intro/index.html' } } } as BoardNodeDraft,
    );
    expect(ids(model([film!]).actions)).toEqual(['open-studio']);
    expect(ids(model([film!], { extensions: { renderMotionBody: () => null, openMotionStudio: vi.fn() } }).actions)).toEqual(['open-studio']);
    expect(ids(model([composition!]).actions)).toEqual(['play', 'open-studio']);
  });

  it('an active mode on the node switches the bar to its mode view', () => {
    const [frame] = nodes(frameDraft('n_f', 0, 0, 'index.html'));
    const m = model([frame!], { mode: { nodeId: 'n_f', mode: 'capture', captureTool: 'pick' } });
    expect(m).toMatchObject({ kind: 'mode-active', activeMode: 'capture', nodeId: 'n_f', widgets: [] });
    expect(ids(m.actions)).toEqual(['reload', 'maximize']);
    expect(m.modes).toHaveLength(3);
  });
});

describe('frame export (C4)', () => {
  const snapshot = { dataUrl: 'data:image/png;base64,AAA', w: 2880, h: 3600 };
  const input = { projectId: 'p1', path: 'pages/home.html', w: 1440, h: 900, scale: 2 as const, deck: false, workspaceContext: null };
  const deps = (daemon: Awaited<ReturnType<FrameExportDeps['renderViaDaemon']>>, frame: FrameExportDeps['renderViaFrame'] = vi.fn(async () => snapshot)): FrameExportDeps => ({
    renderViaDaemon: vi.fn(async () => daemon),
    renderViaFrame: frame,
    resample: vi.fn(async () => new Blob(['png'], { type: 'image/png' })),
  });

  it('names exports and keeps the page length at the chosen width', () => {
    expect(frameExportName('pages/home.html', 1)).toBe('home.png');
    expect(frameExportName('pages/home.html', 2)).toBe('home-2x.png');
    expect(exportOutputSize({ w: 1440, h: 3000 }, 1440, 2)).toEqual({ width: 2880, height: 6000 });
  });

  it('renders through the project export path first', async () => {
    const d = deps({ ok: true, snapshot });
    const result = await renderFrameImage(input, d);
    expect(d.renderViaDaemon).toHaveBeenCalledWith({ projectId: 'p1', fileName: 'pages/home.html', width: 1440, height: 900, deck: false, workspaceContext: null });
    expect(d.renderViaFrame).not.toHaveBeenCalled();
    expect(result).toMatchObject({ ok: true, name: 'home-2x.png', width: 2880, height: 3600, via: 'daemon' });
  });

  it('falls back to the live frame where the renderer is unavailable, and fails when neither renders', async () => {
    const d = deps({ ok: false, unavailable: true, reason: 'no-renderer' } as never);
    expect(await renderFrameImage(input, d)).toMatchObject({ ok: true, via: 'frame' });
    const none = deps({ ok: false, unavailable: true, reason: 'no-renderer' } as never, vi.fn(async () => null));
    expect(await renderFrameImage(input, none)).toEqual({ ok: false, reason: 'no-renderer' });
    // a renderer error is a failure, not a fallback
    const broken = deps({ ok: false, error: 'boom' });
    expect(await renderFrameImage(input, broken)).toEqual({ ok: false, reason: 'boom' });
    expect(broken.renderViaFrame).not.toHaveBeenCalled();
  });
});
