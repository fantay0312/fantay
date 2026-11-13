// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { emptyManualEditStyles, type ManualEditTarget } from '../../../src/edit-mode/types';
import { writeProjectTextFileDetailed } from '../../../src/providers/registry';
import { installStageSize, mountBoard, projectFile } from './chrome-fixtures';
import { frameDraft, makeBoard } from './engine-fixtures';

const BOARD_PAGE = '<!doctype html><html><head></head><body><h1 data-od-id="hero">Hello</h1></body></html>';

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return {
    ...actual,
    fetchProjectFileText: vi.fn(async () => BOARD_PAGE),
    fetchProjectPreviewBaseHref: vi.fn(async () => null),
    writeProjectTextFileDetailed: vi.fn(async (_projectId: string, name: string) => ({ ok: true, file: { name, mtime: 2_000 } })),
  };
});
import {
  contentPatchForDraft,
  createFrameEditSession,
  draftForTarget,
  patchNeedsRebuild,
  type FrameEditSessionDeps,
} from '../../../src/fantay/board/nodes/frame/use-frame-edit-session';

const SOURCE = '<!doctype html><html><head></head><body><h1 data-od-id="hero">Hello</h1><p data-od-id="lede">Lede</p></body></html>';
const LABELS = { content: 'Edit content', html: 'Edit HTML', undo: 'Undo edit', redo: 'Redo edit' };

function target(id = 'hero', text = 'Hello'): ManualEditTarget {
  return {
    id,
    kind: 'text',
    label: 'Heading',
    tagName: 'h1',
    className: '',
    text,
    rect: { x: 0, y: 0, width: 100, height: 40 },
    fields: { text },
    attributes: {},
    styles: emptyManualEditStyles(),
    isLayoutContainer: false,
    outerHtml: `<h1 data-od-id="${id}">${text}</h1>`,
  };
}

function setup(overrides: Partial<FrameEditSessionDeps> = {}) {
  const posts: Array<Record<string, unknown>> = [];
  const deps: FrameEditSessionDeps = {
    nodeId: 'n_f',
    path: 'index.html',
    readOnly: false,
    initialMtime: 1_000,
    sizeBytes: () => SOURCE.length,
    loadSource: vi.fn(async () => SOURCE),
    mountEditing: vi.fn(),
    write: vi.fn(async () => ({ ok: true as const, mtime: 2_000 })),
    post: (message) => posts.push(message as Record<string, unknown>),
    notify: vi.fn(),
    onEnded: vi.fn(),
    labels: LABELS,
    wait: async () => {},
    now: () => 42,
    ...overrides,
  };
  const session = createFrameEditSession(deps);
  return { session, deps, posts };
}

async function active(overrides: Partial<FrameEditSessionDeps> = {}) {
  const harness = setup(overrides);
  await harness.session.start();
  harness.session.frameLoaded();
  return harness;
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('board Edit session (03 §5.3)', () => {
  it('loads the source, mounts the editing document and turns the bridge on when it loaded', async () => {
    const { session, deps, posts } = setup();
    await session.start();
    expect(deps.loadSource).toHaveBeenCalledTimes(1);
    expect(deps.mountEditing).toHaveBeenCalledWith(SOURCE);
    expect(session.getState().phase).toBe('mounting');
    session.frameLoaded();
    expect(posts).toEqual([{ type: 'od-edit-mode', enabled: true }]);
    expect(session.getState().phase).toBe('active');
  });

  it('refuses read-only projects and pages over 2 MiB without loading them', async () => {
    const readOnly = setup({ readOnly: true });
    await readOnly.session.start();
    expect(readOnly.deps.loadSource).not.toHaveBeenCalled();
    expect(readOnly.deps.notify).toHaveBeenCalledWith({ key: 'board.mode.reason.readOnly' });
    expect(readOnly.deps.onEnded).toHaveBeenCalledWith('refused');
    const large = setup({ sizeBytes: () => 3 * 1024 * 1024 });
    await large.session.start();
    expect(large.deps.loadSource).not.toHaveBeenCalled();
    expect(large.deps.notify).toHaveBeenCalledWith({ key: 'board.mode.reason.tooLarge' });
  });

  it('turns od-edit-text-commit into a set-text patch written as a manual version', async () => {
    const { session, deps } = await active();
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'Hi there' });
    await vi.waitFor(() => expect(deps.write).toHaveBeenCalledTimes(1));
    const [content, label] = (deps.write as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(content).toContain('>Hi there</h1>');
    expect(content).toContain('>Lede</p>');
    expect(label).toBe(LABELS.content);
    await flush();
    const state = session.getState();
    expect(state.phase).toBe('active');
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({ patch: { id: 'hero', kind: 'set-text', value: 'Hi there' }, beforeSource: SOURCE });
    // a text patch is mirrored by the live bridge: no rebuild of the editing document
    expect(deps.mountEditing).toHaveBeenCalledTimes(1);
  });

  it('previews panel styles live and saves them with the draft; selection follows the bridge', async () => {
    const { session, deps, posts } = await active();
    session.handleMessage({ type: 'od-edit-select', target: target() });
    expect(posts.at(-1)).toEqual({ type: 'od-edit-selected-target', id: 'hero' });
    expect(session.getState().draft.text).toBe('Hello');
    session.previewStyles('hero', { color: 'red' });
    expect(posts.at(-1)).toMatchObject({ type: 'od-edit-preview-style', id: 'hero', styles: { color: 'red' } });
    await session.saveDraft();
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect((deps.write as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toContain('color: red');
    expect(deps.notify).toHaveBeenCalledWith({ key: 'board.edit.saved', vars: { file: 'index.html' }, tone: 'success' });
    expect(session.getState().selected).toBeNull();
    session.handleMessage({ type: 'od-edit-background' });
    expect(posts.at(-1)).toEqual({ type: 'od-edit-selected-target', id: null });
  });

  it('ends on an external change of the file (not its own writes): finish without commit, mode off, toast', async () => {
    const { session, deps, posts } = await active();
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'Mine' });
    await vi.waitFor(() => expect(deps.write).toHaveBeenCalledTimes(1));
    await flush();
    session.fileChanged(2_000); // our own write echoed by the file list
    expect(deps.onEnded).not.toHaveBeenCalled();
    posts.length = 0;
    session.fileChanged(9_000); // someone else
    expect(posts).toEqual([
      { type: 'od-edit-text-finish', commit: false },
      { type: 'od-edit-mode', enabled: false },
    ]);
    expect(deps.notify).toHaveBeenCalledWith({ key: 'board.edit.conflict', tone: 'danger' });
    expect(deps.onEnded).toHaveBeenCalledWith('conflict');
    // nothing is written after the conflict
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'late' });
    await flush();
    expect(deps.write).toHaveBeenCalledTimes(1);
  });

  it('exit commits a pending inline text edit, then turns the bridge off and waits for saves', async () => {
    const { session, deps, posts } = await active();
    posts.length = 0;
    await session.exit();
    expect(posts).toEqual([
      { type: 'od-edit-text-finish', commit: true },
      { type: 'od-edit-mode', enabled: false },
    ]);
    expect(deps.onEnded).toHaveBeenCalledWith('exit');
    expect(session.getState().phase).toBe('idle');
  });

  it('undo writes the previous source and rebuilds the editing document', async () => {
    const { session, deps } = await active();
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'Changed' });
    await vi.waitFor(() => expect(session.getState().history).toHaveLength(1));
    await session.undo();
    expect((deps.write as ReturnType<typeof vi.fn>).mock.calls.at(-1)).toEqual([SOURCE, LABELS.undo]);
    expect(deps.mountEditing).toHaveBeenLastCalledWith(SOURCE);
    expect(session.getState().undone).toHaveLength(1);
  });

  it('a patch that leaves the source as it was writes nothing and keeps the session editable (no rebuild to wait for)', async () => {
    const { session, deps } = await active();
    expect(await session.applyPatch({ kind: 'set-full-source', source: SOURCE }, LABELS.html)).toBe(true);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.mountEditing).toHaveBeenCalledTimes(1);
    expect(session.getState()).toMatchObject({ phase: 'active', history: [] });
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'Still editable' });
    await vi.waitFor(() => expect(deps.write).toHaveBeenCalledTimes(1));
  });

  it('reports a failed write and stays editable', async () => {
    const { session, deps } = await active({ write: vi.fn(async () => ({ ok: false as const, message: 'disk full' })) });
    session.handleMessage({ type: 'od-edit-text-commit', id: 'hero', value: 'x' });
    await vi.waitFor(() => expect(deps.notify).toHaveBeenCalledWith({ key: 'board.edit.failed', vars: { reason: 'disk full' }, tone: 'danger' }));
    await flush();
    expect(session.getState()).toMatchObject({ phase: 'active', error: 'disk full' });
  });
});

describe('Edit on the board (FrameNode + 文件 write path)', () => {
  let restoreStage: () => void = () => {};
  beforeAll(() => {
    restoreStage = installStageSize();
  });
  afterAll(() => restoreStage());
  afterEach(() => cleanup());

  it('mounts an editing srcdoc and writes committed text through writeProjectTextFileDetailed as a manual version', async () => {
    const h = mountBoard({
      board: makeBoard([frameDraft('n_f', 0, 0, 'index.html', { w: 400, h: 300 })]),
      files: [projectFile('index.html', { size: BOARD_PAGE.length, mtime: 1_000 })],
      viewport: { centerX: 200, centerY: 150, zoom: 1 },
    });
    // live → URL transport first (a plain page)
    await vi.waitFor(() => expect(screen.getByTestId('board-frame-iframe')).toHaveAttribute('data-transport', 'url'));
    act(() => h.commands().setMode('n_f', 'edit'));
    // the editing document arrives as the pending srcdoc (double buffer, ≤ 1 swap / 1.2 s)
    const pending = await vi.waitFor(
      () => {
        const element = screen.getAllByTestId('board-frame-iframe').find((iframe) => iframe.dataset.transport === 'srcdoc');
        if (!element) throw new Error('no editing document yet');
        return element as HTMLIFrameElement;
      },
      { timeout: 3_000 },
    );
    expect(pending.getAttribute('srcdoc') ?? '').toContain('data-od-id="hero"');
    act(() => {
      fireEvent.load(pending);
    });
    await vi.waitFor(() => expect(pending).toHaveAttribute('data-role', 'current'), { timeout: 2_000 });
    // the bridge in that document commits an inline text edit
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: { type: 'od-edit-text-commit', id: 'hero', value: 'Hi board' }, source: pending.contentWindow }));
      await Promise.resolve();
    });
    await vi.waitFor(() => expect(writeProjectTextFileDetailed).toHaveBeenCalled(), { timeout: 2_000 });
    const [projectId, name, content, options] = vi.mocked(writeProjectTextFileDetailed).mock.calls.at(-1)!;
    expect(projectId).toBe(h.props.data.host.projectId);
    expect(name).toBe('index.html');
    expect(content).toContain('>Hi board</h1>');
    expect(options).toMatchObject({ versionSource: 'manual' });
    expect(typeof (options as { versionLabel?: unknown }).versionLabel).toBe('string');
  });
});

describe('draft and patch rules (FileViewer semantics)', () => {
  it('reads the draft from the source and builds the content patch it implies', () => {
    const draft = draftForTarget(target(), SOURCE);
    expect(draft).toMatchObject({ text: 'Hello', fullSource: SOURCE });
    expect(contentPatchForDraft(target(), draft, SOURCE, LABELS)).toBeNull();
    expect(contentPatchForDraft(target(), { ...draft, text: 'New' }, SOURCE, LABELS)).toEqual({
      patch: { id: 'hero', kind: 'set-text', value: 'New' },
      label: LABELS.content,
    });
    expect(patchNeedsRebuild({ id: 'hero', kind: 'set-text', value: 'x' })).toBe(false);
    expect(patchNeedsRebuild({ id: 'hero', kind: 'remove-element' })).toBe(true);
  });
});
