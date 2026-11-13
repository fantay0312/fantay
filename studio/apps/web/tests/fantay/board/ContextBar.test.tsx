// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { ImageDown } from 'lucide-react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { BoardNodeDraft } from '@open-design/contracts';

import type { BoardExtensions } from '../../../src/fantay/board/extensions';
import { installStageSize, mountBoard, type BoardHarness } from './chrome-fixtures';
import { frameDraft, makeBoard, noteDraft } from './engine-fixtures';

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
afterEach(() => cleanup());

const webDraft = (id: string, x: number, y: number): BoardNodeDraft =>
  ({ kind: 'web', id, x, y, w: 1280, h: 800, url: 'https://example.com', device: 'desktop' }) as BoardNodeDraft;
const imageDraft = (id: string, x: number, y: number): BoardNodeDraft =>
  ({ kind: 'image', id, x, y, w: 400, h: 300, ref: { path: 'assets/cat.png' } }) as BoardNodeDraft;

function select(h: BoardHarness, ids: string[]): void {
  act(() => h.commands().select(ids));
}

function bar(): HTMLElement {
  return screen.getByTestId('board-context-bar');
}

function openMenu(trigger: HTMLElement): void {
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
  });
}

describe('ContextBar', () => {
  it('stays mounted and closed without a selection; opens for a single frame with the three modes', () => {
    const h = mountBoard({ board: makeBoard([frameDraft('n_f', 0, 0, 'index.html'), noteDraft('n_note', 0, 1200)]) });
    expect(bar()).toHaveAttribute('data-state', 'closed');
    expect(screen.getByTestId('board-context-dock')).toHaveAttribute('aria-hidden', 'true');

    select(h, ['n_f']);
    expect(bar()).toHaveAttribute('data-state', 'open');
    expect(screen.getByRole('toolbar', { name: 'Selection actions' })).toBe(bar());
    const modes = within(bar()).getByLabelText('Preview mode');
    expect(within(modes).getByTestId('board-mode-navigate')).toBeEnabled();
    expect(within(modes).getByTestId('board-mode-edit')).toBeEnabled();
    expect(within(modes).getByTestId('board-mode-capture')).toBeEnabled();
    expect(within(bar()).getByTestId('board-frame-size')).toHaveTextContent('Desktop');
    expect(within(bar()).getByTestId('board-action-open-in-files')).toBeInTheDocument();

    select(h, []);
    // closed again but still mounted (exit transition, AGENTS.md rule)
    expect(bar()).toHaveAttribute('data-state', 'closed');
  });

  it('enters Navigate from the segment, shows the hint and Done, and toggling the active segment leaves the mode', () => {
    const h = mountBoard({ board: makeBoard([frameDraft('n_f', 0, 0, 'index.html')]) });
    select(h, ['n_f']);
    fireEvent.click(within(bar()).getByTestId('board-mode-navigate'));
    expect(h.commands().getSelection()).toEqual(['n_f']);
    expect(screen.getByTestId('board-mode-hint')).toHaveTextContent('Use the page directly');
    expect(within(bar()).getByTestId('board-mode-navigate')).toHaveAttribute('data-state', 'on');
    fireEvent.click(within(bar()).getByTestId('board-mode-navigate'));
    expect(screen.queryByTestId('board-mode-hint')).toBeNull();

    fireEvent.click(within(bar()).getByTestId('board-mode-navigate'));
    fireEvent.click(screen.getByTestId('board-mode-done'));
    expect(screen.queryByTestId('board-mode-done')).toBeNull();
  });

  it('keeps Edit disabled with its reason for a web node; Capture needs the desktop app', async () => {
    const h = mountBoard({ board: makeBoard([webDraft('n_w', 0, 0)]) });
    select(h, ['n_w']);
    const edit = within(bar()).getByTestId('board-mode-edit');
    expect(edit).toBeDisabled();
    expect(within(bar()).getByTestId('board-mode-capture')).toBeDisabled();
    expect(within(bar()).getByTestId('board-mode-navigate')).toBeEnabled();
    const reason = within(bar()).getByTestId('board-mode-edit-reason');
    act(() => {
      fireEvent.pointerMove(reason, { pointerType: 'mouse' });
    });
    const tooltip = await screen.findByRole('tooltip');
    expect(tooltip).toHaveTextContent("External pages can't be edited");
  });

  it('offers the device and social-media sizes for a frame (C4) and resizes in one update', () => {
    const h = mountBoard({ board: makeBoard([frameDraft('n_f', 0, 0, 'index.html')]) });
    select(h, ['n_f']);
    openMenu(within(bar()).getByTestId('board-frame-size'));
    const menu = screen.getByTestId('board-frame-size-menu');
    expect(within(menu).getByText('Devices')).toBeInTheDocument();
    expect(within(menu).getByText('Social media')).toBeInTheDocument();
    expect(within(menu).getByTestId('board-frame-size-desktop')).toHaveAttribute('data-state', 'checked');
    for (const id of ['tablet', 'mobile', 'square', 'portrait', 'story', 'xhs', 'landscape']) {
      expect(within(menu).getByTestId(`board-frame-size-${id}`)).toBeInTheDocument();
    }
    fireEvent.click(within(menu).getByTestId('board-frame-size-xhs'));
    expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_f', patch: { w: 1242, h: 1660, device: 'custom' } }]);
  });

  it('exports a frame at 1× or 2×; a frame without a file keeps the export disabled', () => {
    const h = mountBoard({
      board: makeBoard([
        frameDraft('n_f', 0, 0, 'index.html'),
        { kind: 'frame', id: 'n_live', x: 0, y: 1200, w: 1440, h: 900, ref: null, liveArtifactId: 'la_1', device: 'desktop' } as BoardNodeDraft,
      ]),
    });
    select(h, ['n_f']);
    openMenu(within(bar()).getByTestId('board-frame-export'));
    const menu = screen.getByTestId('board-frame-export-menu');
    expect(within(menu).getByTestId('board-frame-export-1x')).toHaveTextContent('1×');
    expect(within(menu).getByTestId('board-frame-export-2x')).toHaveTextContent('2880 × 1800');
    act(() => {
      fireEvent.keyDown(menu, { key: 'Escape' });
    });

    select(h, ['n_live']);
    expect(within(bar()).getByTestId('board-frame-export')).toBeDisabled();
  });

  it('renders the extension node actions of an image (bar and more) and runs them', () => {
    const run = vi.fn();
    const more = vi.fn();
    const nodeActions = vi.fn((_nodeId: string, kind: 'image' | 'video' | 'design') =>
      kind === 'image'
        ? [
            { id: 'image.upscale', labelKey: 'board.export.image' as const, icon: ImageDown, placement: 'bar' as const, run },
            { id: 'image.crop', labelKey: 'board.node.copyPath' as const, icon: ImageDown, placement: 'more' as const, run: more },
          ]
        : [],
    );
    const extensions: BoardExtensions = { nodeActions };
    const h = mountBoard({ board: makeBoard([imageDraft('n_i', 0, 0)]), extensions });
    select(h, ['n_i']);
    expect(nodeActions).toHaveBeenCalledWith('n_i', 'image');
    fireEvent.click(within(bar()).getByTestId('board-action-image.upscale'));
    expect(run).toHaveBeenCalledTimes(1);
    openMenu(within(bar()).getByTestId('board-context-more'));
    fireEvent.click(screen.getByTestId('board-more-image.crop'));
    expect(more).toHaveBeenCalledTimes(1);
    // the built-in image actions are there too
    expect(within(bar()).getByTestId('board-action-download')).toBeInTheDocument();
    expect(within(bar()).getByTestId('board-action-attach-to-chat')).toBeInTheDocument();
  });

  it('shows note colours and sizes; a swatch is one style update', () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_note', 0, 0)]) });
    select(h, ['n_note']);
    expect(within(bar()).queryByLabelText('Preview mode')).toBeNull();
    const violet = within(bar()).getByTestId('board-note-color-violet');
    expect(violet).toHaveAttribute('aria-pressed', 'false');
    expect(within(bar()).getByTestId('board-note-color-yellow')).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(violet);
    expect(h.data.applyCalls.at(-1)?.ops).toEqual([{ op: 'update', id: 'n_note', patch: { color: 'violet' } }]);
    expect(within(bar()).getByTestId('board-note-color-violet')).toHaveAttribute('aria-pressed', 'true');
  });

  it('shows the count, Group and Align for a multi-selection', () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0), noteDraft('n_b', 400, 0)]) });
    select(h, ['n_a', 'n_b']);
    expect(within(bar()).getByTestId('board-selection-count')).toHaveTextContent('2 selected');
    expect(within(bar()).getByTestId('board-action-group')).toBeInTheDocument();
    openMenu(within(bar()).getByTestId('board-align'));
    fireEvent.click(screen.getByText('Align left'));
    expect(h.data.applyCalls.at(-1)?.ops[0]).toMatchObject({ op: 'move' });
  });

  it("a composition's Pause stops its motion preview even while it is selected", async () => {
    const composition = { kind: 'motion', id: 'n_c', x: 0, y: 0, w: 640, h: 360, source: { type: 'composition', ref: { path: 'motion-source/intro/index.html' } } } as BoardNodeDraft;
    const h = mountBoard({ board: makeBoard([composition]), viewport: { centerX: 320, centerY: 180, zoom: 1 } });
    select(h, ['n_c']);
    const iframe = await vi.waitFor(() => screen.getByTestId('board-frame-iframe'));
    expect(iframe).toHaveAttribute('data-od-motion-active', 'true');
    fireEvent.click(within(bar()).getByTestId('board-action-play'));
    expect(within(bar()).getByTestId('board-action-play')).toHaveAccessibleName('Pause');
    expect(screen.getByTestId('board-frame-iframe')).toHaveAttribute('data-od-motion-active', 'true');
    fireEvent.click(within(bar()).getByTestId('board-action-play'));
    expect(within(bar()).getByTestId('board-action-play')).toHaveAccessibleName('Play');
    expect(screen.getByTestId('board-frame-iframe')).toHaveAttribute('data-od-motion-active', 'false');
  });

  it('hides while a draw tool is armed (the toolbar hint owns that spot)', () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    select(h, ['n_a']);
    expect(bar()).toHaveAttribute('data-state', 'open');
    act(() => h.commands().setTool('rectangle'));
    expect(bar()).toHaveAttribute('data-state', 'closed');
  });
});

describe('node context menu (03 §3.14)', () => {
  const videoDraft = (id: string, x: number, y: number): BoardNodeDraft =>
    ({ kind: 'video', id, x, y, w: 640, h: 360, ref: { path: 'clip.mp4' } }) as BoardNodeDraft;
  const filmDraft = (id: string, x: number, y: number): BoardNodeDraft =>
    ({ kind: 'motion', id, x, y, w: 640, h: 360, source: { type: 'movie', projectId: 'p_board_test' } }) as BoardNodeDraft;

  function openNodeMenu(id: string): HTMLElement {
    const node = screen.getAllByTestId('board-node').find((element) => element.dataset.nodeId === id);
    if (!node) throw new Error(`node ${id} not rendered`);
    act(() => {
      fireEvent.contextMenu(node, { clientX: 40, clientY: 40, button: 2 });
    });
    return screen.getByTestId('board-context-menu-node');
  }

  it('offers Add to chat only for nodes whose file can go to chat', () => {
    mountBoard({ board: makeBoard([frameDraft('n_f', 0, 0, 'index.html'), noteDraft('n_note', 0, 960)]) });
    expect(within(openNodeMenu('n_note')).queryByTestId('board-menu-add-to-chat')).toBeNull();
    act(() => {
      fireEvent.keyDown(screen.getByTestId('board-context-menu-node'), { key: 'Escape' });
    });
    expect(within(openNodeMenu('n_f')).getByTestId('board-menu-add-to-chat')).toBeInTheDocument();
  });

  it('has no Play row where the node body owns playback (generation video body, film)', () => {
    mountBoard({ board: makeBoard([videoDraft('n_v', 0, 0)]) });
    expect(within(openNodeMenu('n_v')).getByTestId('board-menu-play')).toBeInTheDocument();
    cleanup();
    mountBoard({ board: makeBoard([videoDraft('n_v', 0, 0)]), extensions: { renderVideoBody: () => null } });
    expect(within(openNodeMenu('n_v')).queryByTestId('board-menu-play')).toBeNull();
    cleanup();
    mountBoard({ board: makeBoard([filmDraft('n_m', 0, 0)]), extensions: { renderMotionBody: () => null, openMotionStudio: vi.fn() } });
    const menu = openNodeMenu('n_m');
    expect(within(menu).getByTestId('board-menu-open-studio')).toBeInTheDocument();
    expect(within(menu).queryByTestId('board-menu-play')).toBeNull();
  });

  it('keeps Copy as PNG of a web page disabled with its reason without the desktop app', () => {
    mountBoard({ board: makeBoard([webDraft('n_w', 0, 0)]) });
    const row = within(openNodeMenu('n_w')).getByTestId('board-menu-copy-png');
    expect(row).toHaveAttribute('data-disabled');
    expect(row).toHaveTextContent('Capturing external pages needs the desktop app');
  });
});
