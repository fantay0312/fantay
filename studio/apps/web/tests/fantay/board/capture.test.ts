// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardNodeDraft, BoardOp } from '@open-design/contracts';

import { STAGE_ATTACHMENT_EVENT, type StageAttachmentEventDetail } from '../../../src/components/ChatComposer';
import { modesFor } from '../../../src/fantay/board/chrome/context-bar-model';
import type { FrameCommentTarget } from '../../../src/fantay/board/engine/message-router';
import { toEngineNode } from '../../../src/fantay/board/model/contract-adapter';
import {
  captureCropRect,
  captureFileName,
  captureSlug,
  createFrameCaptureSession,
  runFrameCapture,
  targetScreenRect,
  type FrameCaptureDeps,
} from '../../../src/fantay/board/nodes/frame/use-frame-capture';
import { uploadProjectFiles } from '../../../src/providers/registry';
import { installStageSize, mountBoard } from './chrome-fixtures';
import { frameDraft, makeBoard } from './engine-fixtures';

const SNAPSHOT_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/** the desktop host (compositor capture), off unless a case turns it on */
const host = vi.hoisted(() => ({ available: false }));
vi.mock('@open-design/host', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@open-design/host')>();
  return { ...actual, isOpenDesignHostAvailable: () => host.available };
});

vi.mock('../../../src/runtime/exports', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/runtime/exports')>();
  return {
    ...actual,
    isOpenDesignHostAvailable: () => false,
    captureHostRegionSnapshot: vi.fn(async () => null),
    requestPreviewSnapshot: vi.fn(async () => ({ dataUrl: SNAPSHOT_URL, w: 800, h: 600 })),
  };
});

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return {
    ...actual,
    uploadProjectFiles: vi.fn(async (_projectId: string, files: File[]) => ({
      uploaded: files.map((file) => ({ path: file.name, name: file.name, kind: 'image' })),
      failed: [],
    })),
  };
});

function target(extra: Partial<FrameCommentTarget> = {}): FrameCommentTarget {
  return { elementId: 'nav', selector: 'nav', label: 'Main nav', text: 'Home About', position: { x: 10, y: 20, width: 300, height: 40 }, ...extra };
}

function deps(overrides: Partial<FrameCaptureDeps> = {}) {
  const posts: unknown[] = [];
  const value: FrameCaptureDeps = {
    nodeId: 'n_f',
    kind: 'frame',
    post: (message) => posts.push(message),
    captureImage: vi.fn(async () => ({ blob: new Blob(['png'], { type: 'image/png' }), width: 300, height: 40 })),
    upload: vi.fn(async (file: File) => ({ path: `captures/${file.name}`, name: file.name })),
    place: vi.fn(() => 'n_img'),
    stage: vi.fn(),
    notify: vi.fn(),
    nodeTitle: () => 'Home page',
    fullPageLabel: () => 'Full page',
    captureTitle: (page, element) => `${page} · ${element}`,
    now: () => new Date(2026, 9, 29, 9, 8, 7),
    ...overrides,
  };
  return { deps: value, posts };
}

describe('capture maths (03 §5.3)', () => {
  it('crops by the bridge position scaled to the snapshot (DPR / layout zoom), clamped to the image', () => {
    // a 1440 CSS px viewport captured at 2×
    expect(captureCropRect({ x: 10, y: 20, width: 300, height: 40 }, { w: 2880, h: 1800 }, 1440)).toEqual({ x: 20, y: 40, width: 600, height: 80 });
    expect(captureCropRect({ x: 1400, y: 880, width: 300, height: 300 }, { w: 1440, h: 900 }, 1440)).toEqual({ x: 1400, y: 880, width: 40, height: 20 });
    expect(captureCropRect({ x: -5, y: -5, width: 10, height: 10 }, { w: 100, h: 100 }, 100)).toEqual({ x: 0, y: 0, width: 5, height: 5 });
  });

  it('maps a target to screen px for the compositor and names files capture-<page>-<element>-<stamp>.png', () => {
    expect(targetScreenRect({ left: 100, top: 50 }, { x: 10, y: 20, width: 300, height: 40 }, 0.5)).toEqual({ left: 105, top: 60, width: 150, height: 20 });
    expect(captureSlug('Main Nav — Hero!')).toBe('main-nav-hero');
    expect(captureSlug('首页')).toBe('');
    const now = new Date(2026, 9, 29, 9, 8, 7);
    expect(captureFileName('Home page', 'Main nav', now)).toBe('capture-home-page-main-nav-20261029-090807.png');
    expect(captureFileName('首页', '', now)).toBe('capture-page-full-20261029-090807.png');
  });
});

describe('capture session', () => {
  it('turns the picker on for frames, tracks hover and the pick, and turns it off on end', () => {
    const { deps: d, posts } = deps();
    const session = createFrameCaptureSession(d);
    session.frameLoaded();
    expect(posts).toEqual([{ type: 'od:comment-mode', enabled: true, mode: 'picker' }]);
    session.hover(target());
    expect(session.getState().hover?.elementId).toBe('nav');
    session.pick(target());
    expect(session.getState()).toMatchObject({ target: { elementId: 'nav' }, hover: null });
    session.setTool('markup');
    expect(posts.at(-1)).toEqual({ type: 'od:comment-mode', enabled: false, mode: 'picker' });
    expect(session.getState().target).toBeNull();
    session.end();
    expect(posts.at(-1)).toEqual({ type: 'od:comment-mode', enabled: false, mode: 'picker' });
  });

  it('web pages capture with Markup only', () => {
    const { deps: d, posts } = deps({ kind: 'web' });
    const session = createFrameCaptureSession(d, 'pick');
    expect(session.getState().tool).toBe('markup');
    session.setTool('pick');
    expect(session.getState().tool).toBe('markup');
    session.frameLoaded();
    expect(posts).toEqual([]);
  });

  it('uploads once, places the image right of the frame, stages it in chat and toasts', async () => {
    const { deps: d } = deps();
    const id = await runFrameCapture(d, { target: target(), full: false });
    expect(id).toBe('n_img');
    expect(d.upload).toHaveBeenCalledTimes(1);
    const file = vi.mocked(d.upload).mock.calls[0]![0];
    expect(file.name).toBe('capture-home-page-main-nav-20261029-090807.png');
    expect(file.type).toBe('image/png');
    expect(d.place).toHaveBeenCalledWith({ path: `captures/${file.name}`, title: 'Home page · Main nav', width: 300, height: 40 });
    expect(d.stage).toHaveBeenCalledWith({ path: `captures/${file.name}`, name: file.name, kind: 'image' });
    expect(d.notify).toHaveBeenCalledWith({ key: 'board.capture.added', tone: 'success' });
  });

  it('a failed snapshot or upload places nothing', async () => {
    const failing = deps({ captureImage: vi.fn(async () => null) });
    expect(await runFrameCapture(failing.deps, { target: target(), full: false })).toBeNull();
    expect(failing.deps.upload).not.toHaveBeenCalled();
    const noUpload = deps({ upload: vi.fn(async () => null) });
    expect(await runFrameCapture(noUpload.deps, { target: null, full: true })).toBeNull();
    expect(noUpload.deps.place).not.toHaveBeenCalled();
    expect(noUpload.deps.notify).toHaveBeenCalledWith(expect.objectContaining({ key: 'board.capture.failed', tone: 'danger' }));
  });

  it('is unavailable on read-only boards (viewerOnly)', () => {
    const [node] = makeBoard([frameDraft('n_f', 0, 0, 'index.html')]).nodes.map(toEngineNode);
    const capture = modesFor(node!, undefined, { readOnly: true, hostAvailable: true })!.find((entry) => entry.mode === 'capture');
    expect(capture).toEqual({ mode: 'capture', enabled: false, reasonKey: 'board.mode.reason.readOnly' });
  });
});

describe('Capture on the board (FrameNode)', () => {
  let restoreStage: () => void = () => {};
  beforeAll(() => {
    restoreStage = installStageSize();
  });
  afterAll(() => restoreStage());
  afterEach(() => cleanup());

  it('整页 uploads the page snapshot, adds an image node with a lineage edge, selects it and stages it in chat', async () => {
    const staged: StageAttachmentEventDetail[] = [];
    const onStage = (event: Event) => staged.push((event as CustomEvent<StageAttachmentEventDetail>).detail);
    window.addEventListener(STAGE_ATTACHMENT_EVENT, onStage);
    try {
      const h = mountBoard({ board: makeBoard([frameDraft('n_f', 0, 0, 'index.html', { w: 400, h: 300 })]), viewport: { centerX: 200, centerY: 150, zoom: 1 } });
      const iframe = await vi.waitFor(() => screen.getByTestId('board-frame-iframe'));
      act(() => h.commands().setMode('n_f', 'capture'));
      act(() => {
        fireEvent.load(iframe);
      });
      await vi.waitFor(() => expect(screen.getByTestId('board-capture-full')).toBeEnabled());
      // the picked element is required for 截取; the whole page is not
      expect(screen.getByTestId('board-capture-element')).toBeDisabled();
      await act(async () => {
        fireEvent.click(screen.getByTestId('board-capture-full'));
      });
      await vi.waitFor(() => expect(uploadProjectFiles).toHaveBeenCalled());
      const [, files] = vi.mocked(uploadProjectFiles).mock.calls.at(-1)!;
      expect(files[0]!.name).toMatch(/^capture-index-html-full-\d{8}-\d{6}\.png$/);
      await vi.waitFor(() => expect(staged).toHaveLength(1));
      expect(staged[0]).toEqual({ attachments: [{ path: files[0]!.name, name: files[0]!.name, kind: 'image' }] });
      const ops = h.data.applyCalls.flatMap((call) => call.ops) as BoardOp[];
      const add = ops.find((op): op is Extract<BoardOp, { op: 'add' }> => op.op === 'add');
      expect(add?.node).toMatchObject({ kind: 'image', ref: { path: files[0]!.name }, naturalWidth: 800, naturalHeight: 600 });
      const edge = ops.find((op): op is Extract<BoardOp, { op: 'connect' }> => op.op === 'connect');
      expect(edge?.edge).toMatchObject({ kind: 'lineage', from: 'n_f', to: add?.node.id });
      expect(h.commands().getSelection()).toEqual([add?.node.id]);
    } finally {
      window.removeEventListener(STAGE_ATTACHMENT_EVENT, onStage);
    }
  });

  it('captures a web page with Markup and a frozen camera on desktop; without the desktop app the mode is left', () => {
    const web = { kind: 'web', id: 'n_w', x: 0, y: 0, w: 800, h: 500, url: 'https://example.com', device: 'desktop' } as BoardNodeDraft;
    host.available = true;
    try {
      const h = mountBoard({ board: makeBoard([web]), viewport: { centerX: 400, centerY: 250, zoom: 1 } });
      // the keyboard (C), the menu and the bar all enter Capture with the default sub-tool
      act(() => h.commands().setMode('n_w', 'capture'));
      h.flush();
      expect(screen.getByTestId('board-capture-markup')).toBeInTheDocument();
      const before = h.commands().camera.get();
      act(() => {
        fireEvent.wheel(screen.getByTestId('board-stage'), { deltaY: 120, ctrlKey: true, clientX: 600, clientY: 400 });
      });
      h.flush(300);
      expect(h.commands().camera.get()).toEqual(before);
    } finally {
      host.available = false;
    }
    cleanup();
    const h = mountBoard({ board: makeBoard([web]), viewport: { centerX: 400, centerY: 250, zoom: 1 } });
    act(() => h.commands().setMode('n_w', 'capture'));
    h.flush();
    expect(screen.queryByTestId('board-capture-markup')).toBeNull();
    expect(screen.queryByTestId('board-mode-done')).toBeNull();
  });
});
