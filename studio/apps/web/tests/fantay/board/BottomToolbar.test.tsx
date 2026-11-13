// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { toolHintKey } from '../../../src/fantay/board/chrome/BottomToolbar';
import type { BoardExtensions } from '../../../src/fantay/board/extensions';
import { installStageSize, mountBoard } from './chrome-fixtures';
import { makeBoard, noteDraft } from './engine-fixtures';

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
afterEach(() => cleanup());

const ORDER = [
  'board-tool-select',
  'board-tool-hand',
  'board-tool-frame',
  'board-tool-rectangle',
  'board-tool-ellipse',
  'board-tool-text',
  'board-tool-image',
  'board-tool-generate',
  'board-tool-note',
  'board-tool-comment',
  'board-tool-insert',
];

function toolbarButtons(): string[] {
  const toolbar = screen.getByTestId('board-toolbar');
  return within(toolbar)
    .getAllByRole('button')
    .map((button) => button.dataset.testid ?? '');
}

describe('BottomToolbar', () => {
  it('is a labelled toolbar with V H F R O T, Upload, G, N, C and + in order (32 px buttons, B4)', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    const toolbar = screen.getByRole('toolbar', { name: 'Board tools' });
    expect(toolbar).toHaveAttribute('data-testid', 'board-toolbar');
    expect(toolbarButtons()).toEqual(ORDER);
    for (const id of ORDER) expect(screen.getByTestId(id)).toHaveAttribute('data-size', 'md');
  });

  it('marks the current tool with aria-pressed and switches on click; draw tools show the hint bubble', () => {
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    expect(screen.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('board-tool-rectangle')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('board-tool-hint')).toHaveAttribute('data-state', 'closed');
    // Upload and Insert are actions, not tools
    expect(screen.getByTestId('board-tool-image')).not.toHaveAttribute('aria-pressed');
    expect(screen.getByTestId('board-tool-insert')).not.toHaveAttribute('aria-pressed');

    fireEvent.click(screen.getByTestId('board-tool-rectangle'));
    expect(h.data.apply).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-tool-rectangle')).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('board-tool-select')).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByTestId('board-tool-hint')).toHaveAttribute('data-state', 'open');
    expect(screen.getByTestId('board-tool-hint')).toHaveTextContent('Drag to draw');

    fireEvent.click(screen.getByTestId('board-tool-frame'));
    expect(screen.getByTestId('board-tool-hint')).toHaveTextContent('Drag to draw a new page');
    expect(toolHintKey('note')).toBe('board.tool.hintPlace');
    expect(toolHintKey('select')).toBeNull();
  });

  it('names each tool by its tooltip with the key cap', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    const button = screen.getByTestId('board-tool-rectangle');
    expect(button).toHaveAccessibleName('Rectangle');
    act(() => button.focus());
    const tooltip = screen.getAllByRole('tooltip').find((element) => element.textContent?.includes('Rectangle'));
    expect(tooltip).toBeDefined();
    expect(tooltip!.textContent).toContain('R');
  });

  it('keeps Generate disabled with a reason without the generation extension, enabled with it', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    expect(screen.getByTestId('board-tool-generate')).toBeDisabled();
    cleanup();
    const extensions: BoardExtensions = { createGenerator: vi.fn(() => 'n_gen') };
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), extensions });
    expect(screen.getByTestId('board-tool-generate')).toBeEnabled();
  });

  it('shows only Select and Hand on a read-only board', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), readOnly: true });
    expect(toolbarButtons()).toEqual(['board-tool-select', 'board-tool-hand']);
  });

  it('uses the locale: zh-CN labels', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), locale: 'zh-CN' });
    expect(screen.getByRole('toolbar', { name: '画板工具' })).toBeInTheDocument();
    expect(screen.getByTestId('board-tool-note')).toHaveAccessibleName('便签');
    expect(screen.getByTestId('board-tool-insert')).toHaveAccessibleName('插入');
  });

  it('the insert menu calls the extensions, or keeps the entry disabled as "not available yet"', async () => {
    const createMotion = vi.fn();
    const createDesignDocument = vi.fn();
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), extensions: { createMotion, createDesignDocument } });
    const trigger = screen.getByTestId('board-tool-insert');
    act(() => {
      fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' });
    });
    const menu = await screen.findByTestId('board-insert-menu');
    // available: design document, animation, video edit, web, upload, project files
    expect(within(menu).getByTestId('board-insert-design-doc')).not.toHaveAttribute('data-disabled');
    // missing: materials, generators → disabled with the unavailable sub-line
    const materials = within(menu).getByTestId('board-insert-materials');
    expect(materials).toHaveAttribute('data-disabled');
    expect(materials).toHaveTextContent('Not available yet');
    expect(within(menu).getByTestId('board-insert-image-generator')).toHaveAttribute('data-disabled');
    // no audio generator in phase 1 (C8)
    expect(within(menu).queryByTestId('board-insert-audio-generator')).toBeNull();
    fireEvent.click(within(menu).getByTestId('board-insert-animation'));
    expect(createMotion).toHaveBeenCalledWith('animation');
  });
});
