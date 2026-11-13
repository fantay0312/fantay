// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import '../helpers/radix-jsdom';

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { MERGED_VISIBLE_MS, SAVING_DELAY_MS, saveStatusView } from '../../../src/fantay/board/chrome/SaveStatus';
import { __resetToastsForTests, useToasts } from '../../../src/fantay/ui/toast';
import { installStageSize, mountBoard } from './chrome-fixtures';
import { makeBoard, noteDraft } from './engine-fixtures';

let restoreStage: () => void = () => {};
beforeAll(() => {
  restoreStage = installStageSize();
});
afterAll(() => restoreStage());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  __resetToastsForTests();
});

const idle = { status: 'ready' as const, pendingOps: 0, lastError: null };

describe('save status (03 §6.6, read from the 04 store)', () => {
  it('maps the store state to the chip', () => {
    expect(saveStatusView(idle, false, { savingDue: false, mergedVisible: false })).toBeNull();
    expect(saveStatusView({ ...idle, pendingOps: 2 }, false, { savingDue: false, mergedVisible: false })).toBeNull();
    expect(saveStatusView({ ...idle, pendingOps: 2 }, false, { savingDue: true, mergedVisible: false })).toMatchObject({ kind: 'saving', labelKey: 'board.save.saving' });
    expect(saveStatusView({ ...idle, lastError: { code: 'offline', at: 1 } }, false, { savingDue: true, mergedVisible: false })).toMatchObject({
      kind: 'offline',
      labelKey: 'board.save.offline',
      detailKey: 'board.sync.offline',
      tone: 'danger',
    });
    expect(saveStatusView({ ...idle, lastError: { code: 'save-failed', message: 'disk full', at: 1 } }, false, { savingDue: false, mergedVisible: false })).toMatchObject({
      kind: 'failed',
      detailVars: { detail: 'disk full' },
    });
    expect(saveStatusView({ ...idle, lastError: { code: 'conflict', at: 1 } }, false, { savingDue: false, mergedVisible: true })).toMatchObject({ kind: 'merged', labelKey: 'board.save.merged' });
    expect(saveStatusView({ ...idle, lastError: { code: 'conflict', at: 1 } }, false, { savingDue: false, mergedVisible: false })).toBeNull();
    expect(saveStatusView(idle, true, { savingDue: false, mergedVisible: false })).toMatchObject({ kind: 'readOnly', labelKey: 'board.save.readOnly' });
    expect(saveStatusView({ ...idle, lastError: { code: 'read-only', at: 1 } }, false, { savingDue: false, mergedVisible: false })).toMatchObject({ kind: 'readOnly' });
  });

  it('shows "Saving…" only after 800 ms of pending ops, offline at once, and the merge note for 3 s', () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    const chip = () => screen.getByTestId('board-save-status');
    expect(chip()).toHaveAttribute('data-state', 'closed');

    act(() => h.data.setBoard(h.data.getState().board, { pendingOps: 1 }));
    act(() => vi.advanceTimersByTime(SAVING_DELAY_MS - 1));
    expect(chip()).toHaveAttribute('data-state', 'closed');
    act(() => vi.advanceTimersByTime(1));
    expect(chip()).toHaveAttribute('data-kind', 'saving');
    expect(chip()).toHaveTextContent('Saving…');

    act(() => h.data.setBoard(h.data.getState().board, { pendingOps: 1, lastError: { code: 'offline', at: Date.now() } }));
    expect(chip()).toHaveAttribute('data-kind', 'offline');
    expect(chip()).toHaveAttribute('data-tone', 'danger');

    act(() => h.data.setBoard(h.data.getState().board, { pendingOps: 0, lastError: { code: 'conflict', at: Date.now() } }));
    expect(chip()).toHaveAttribute('data-kind', 'merged');
    act(() => vi.advanceTimersByTime(MERGED_VISIBLE_MS));
    expect(chip()).toHaveAttribute('data-state', 'closed');
  });

  it('a read-only board says so', () => {
    mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]), readOnly: true });
    expect(screen.getByTestId('board-save-status')).toHaveAttribute('data-kind', 'readOnly');
    expect(screen.getByTestId('board-save-status')).toHaveTextContent("This project is read-only. Board changes won't be saved.");
  });

  it('a blocked undo is a toast, once per error', () => {
    let toasts: readonly { title: unknown }[] = [];
    function Probe() {
      toasts = useToasts();
      return null;
    }
    render(<Probe />);
    const h = mountBoard({ board: makeBoard([noteDraft('n_a', 0, 0)]) });
    const blocked = { code: 'undo-blocked' as const, at: 42 };
    act(() => h.data.setBoard(h.data.getState().board, { lastError: blocked }));
    act(() => h.data.setBoard(h.data.getState().board, { lastError: { ...blocked } }));
    expect(toasts.map((entry) => entry.title)).toEqual(["Can't undo: someone else or an agent changed these nodes since."]);
  });
});
