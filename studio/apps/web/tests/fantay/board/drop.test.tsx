// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardOp } from '@open-design/contracts';

import {
  classifyDropFile,
  DROP_STAGGER,
  dropNodeDraft,
  dropNodeSize,
  uploadAndPlace,
  uploadDirFor,
} from '../../../src/fantay/board/interaction/drop';
import { uploadProjectFiles } from '../../../src/providers/registry';
import { installStageSize, mountBoard } from './chrome-fixtures';
import { makeBoard, noteDraft } from './engine-fixtures';

vi.mock('../../../src/providers/registry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/providers/registry')>();
  return {
    ...actual,
    uploadProjectFiles: vi.fn(async (_projectId: string, files: File[], dir?: string) => ({
      uploaded: files.map((file) => ({ path: dir ? `${dir}/${file.name}` : file.name, name: file.name, kind: 'image' })),
      failed: [],
    })),
  };
});

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
afterEach(() => cleanup());

const file = (name: string, type: string) => new File(['x'], name, { type });

describe('drop classification and placement (03 §3.13)', () => {
  it('classifies by extension and type; design documents go to designs/', () => {
    expect(classifyDropFile(file('a.png', 'image/png'))).toBe('image');
    expect(classifyDropFile(file('clip.mov', ''))).toBe('video');
    expect(classifyDropFile(file('song.mp3', 'audio/mpeg'))).toBe('audio');
    expect(classifyDropFile(file('page.HTML', ''))).toBe('frame');
    expect(classifyDropFile(file('brand.fig', ''))).toBe('design');
    expect(classifyDropFile(file('notes.zip', 'application/zip'))).toBe('unsupported');
    expect(uploadDirFor('design')).toBe('designs');
    expect(uploadDirFor('image')).toBeUndefined();
  });

  it('sizes nodes at the file aspect and centres them on the drop point', () => {
    expect(dropNodeSize('image', { w: 2000, h: 1000 })).toEqual({ w: 512, h: 256 });
    expect(dropNodeSize('video', null)).toEqual({ w: 640, h: 360 });
    const draft = dropNodeDraft('image', 'a.png', { x: 100, y: 100 }, { w: 2000, h: 1000 });
    expect(draft).toMatchObject({ kind: 'image', x: 100 - 256, y: 100 - 128, w: 512, h: 256, data: { ref: { path: 'a.png' }, naturalWidth: 2000, naturalHeight: 1000 } });
  });

  it('uploads per folder, places supported files staggered in one call and reports the rest', async () => {
    const upload = vi.fn(async (_projectId: string, files: File[], dir?: string) => ({
      uploaded: files.map((entry) => ({ path: dir ? `${dir}/${entry.name}` : entry.name, name: entry.name, kind: 'image' as const })),
      failed: [],
    }));
    const place = vi.fn((drafts: Array<{ path: string }>) => drafts.map((_, index) => `n_${index}`));
    const notify = vi.fn();
    const ghosts = vi.fn();
    const ids = await uploadAndPlace({
      projectId: 'p1',
      workspaceContext: null,
      files: [file('a.png', 'image/png'), file('brand.fig', ''), file('notes.zip', 'application/zip')],
      at: { x: 0, y: 0 },
      place,
      notify,
      onGhosts: ghosts,
      upload: upload as never,
      measure: async () => ({ w: 400, h: 400 }),
    });
    expect(ids).toEqual(['n_0', 'n_1']);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(upload.mock.calls.map((call) => call[2])).toEqual([undefined, 'designs']);
    const drafts = place.mock.calls[0]![0] as Array<{ path: string; draft: { x: number } }>;
    expect(drafts.map((entry) => entry.path)).toEqual(['a.png', 'designs/brand.fig']);
    expect(notify).toHaveBeenCalledWith({ key: 'board.drop.uploading', vars: { count: 3 } });
    expect(notify).toHaveBeenCalledWith({ key: 'board.drop.unsupported', vars: { name: 'notes.zip' } });
    // ghosts while uploading (supported files only, staggered), then cleared
    expect(ghosts.mock.calls[0]![0]).toHaveLength(2);
    expect(ghosts.mock.calls[0]![0][1].x - ghosts.mock.calls[0]![0][0].x).not.toBe(0);
    expect(ghosts.mock.calls.at(-1)![0]).toBeNull();
    expect(DROP_STAGGER).toBe(40);
  });
});

describe('OS drop on the board', () => {
  it('shows the drop overlay, uploads dropped files and adds their nodes at the drop point', async () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    const root = screen.getByTestId('board-root');
    const transfer = { types: ['Files'], files: [file('shot.png', 'image/png')], dropEffect: 'none' };
    act(() => {
      fireEvent.dragEnter(root, { dataTransfer: transfer });
    });
    expect(screen.getByTestId('board-drop-overlay')).toHaveAttribute('data-state', 'open');
    await act(async () => {
      fireEvent.drop(root, { dataTransfer: transfer, clientX: 400, clientY: 300 });
      await Promise.resolve();
    });
    expect(screen.getByTestId('board-drop-overlay')).toHaveAttribute('data-state', 'closed');
    await vi.waitFor(() => expect(uploadProjectFiles).toHaveBeenCalled());
    await vi.waitFor(() => expect(h.data.applyCalls.some((call) => call.ops.some((op) => op.op === 'add'))).toBe(true));
    const add = h.data.applyCalls.flatMap((call) => call.ops).find((op): op is Extract<BoardOp, { op: 'add' }> => op.op === 'add')!;
    expect(add.node).toMatchObject({ kind: 'image', ref: { path: 'shot.png' } });
    expect(h.commands().getSelection()).toEqual([add.node.id]);
  });

  it('hands external drags (materials) to extensions.onExternalDrop first', async () => {
    const onExternalDrop = vi.fn(() => true);
    const acceptsExternalDrag = vi.fn(() => true);
    vi.mocked(uploadProjectFiles).mockClear();
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), extensions: { acceptsExternalDrag, onExternalDrop } });
    const root = screen.getByTestId('board-root');
    const transfer = { types: ['application/x-fantay-material'], files: [], dropEffect: 'none' };
    act(() => {
      fireEvent.dragEnter(root, { dataTransfer: transfer });
      fireEvent.drop(root, { dataTransfer: transfer, clientX: 100, clientY: 100 });
    });
    expect(onExternalDrop).toHaveBeenCalledTimes(1);
    const [, world] = onExternalDrop.mock.calls[0]! as unknown as [unknown, { x: number; y: number }];
    expect(Number.isFinite(world.x) && Number.isFinite(world.y)).toBe(true);
    expect(uploadProjectFiles).not.toHaveBeenCalled();
  });

  it('ignores drops on read-only boards', () => {
    vi.mocked(uploadProjectFiles).mockClear();
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), readOnly: true });
    const root = screen.getByTestId('board-root');
    const transfer = { types: ['Files'], files: [file('shot.png', 'image/png')], dropEffect: 'none' };
    act(() => {
      fireEvent.dragEnter(root, { dataTransfer: transfer });
      fireEvent.drop(root, { dataTransfer: transfer });
    });
    expect(screen.getByTestId('board-drop-overlay')).toHaveAttribute('data-state', 'closed');
    expect(uploadProjectFiles).not.toHaveBeenCalled();
  });
});
