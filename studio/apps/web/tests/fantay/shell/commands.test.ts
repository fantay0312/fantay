import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerFantayCommand,
  resetFantayCommandsForTests,
  runFantayCommand,
} from '../../../src/fantay/shell/commands';

describe('fantay command registry', () => {
  afterEach(() => {
    resetFantayCommandsForTests();
  });

  it('returns false when no handler is registered', () => {
    expect(runFantayCommand('fantay.board.zoomIn')).toBe(false);
    expect(runFantayCommand('fantay.design.import')).toBe(false);
  });

  it('runs the most recently registered handler (stack semantics)', () => {
    const shell = vi.fn();
    const board = vi.fn();
    registerFantayCommand('fantay.newChat', shell);
    registerFantayCommand('fantay.newChat', board);

    expect(runFantayCommand('fantay.newChat')).toBe(true);
    expect(board).toHaveBeenCalledTimes(1);
    expect(shell).not.toHaveBeenCalled();
  });

  it('restores the previous handler when the top one unregisters', () => {
    const first = vi.fn();
    const second = vi.fn();
    registerFantayCommand('fantay.toggleSidebar', first);
    const unregisterSecond = registerFantayCommand('fantay.toggleSidebar', second);

    unregisterSecond();
    expect(runFantayCommand('fantay.toggleSidebar')).toBe(true);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it('removes a buried handler without disturbing the live one, and unregister is idempotent', () => {
    const first = vi.fn();
    const second = vi.fn();
    const unregisterFirst = registerFantayCommand('fantay.search', first);
    const unregisterSecond = registerFantayCommand('fantay.search', second);

    unregisterFirst();
    unregisterFirst();
    expect(runFantayCommand('fantay.search')).toBe(true);
    expect(second).toHaveBeenCalledTimes(1);

    unregisterSecond();
    expect(runFantayCommand('fantay.search')).toBe(false);
    expect(first).not.toHaveBeenCalled();
  });

  it('reports false when the handler returns false and true for void or true', () => {
    registerFantayCommand('fantay.board.zoomFit', () => false);
    expect(runFantayCommand('fantay.board.zoomFit')).toBe(false);

    registerFantayCommand('fantay.board.zoomOut', () => undefined);
    expect(runFantayCommand('fantay.board.zoomOut')).toBe(true);

    registerFantayCommand('fantay.board.zoomIn', () => true);
    expect(runFantayCommand('fantay.board.zoomIn')).toBe(true);
  });

  it('delivers payloads to the handler', () => {
    const zoomTo = vi.fn();
    const insertFiles = vi.fn();
    registerFantayCommand('fantay.board.zoomTo', zoomTo);
    registerFantayCommand('fantay.board.insertFiles', insertFiles);

    runFantayCommand('fantay.board.zoomTo', { zoom: 1 });
    runFantayCommand('fantay.board.insertFiles', { paths: ['a.png', 'b/index.html'] });

    expect(zoomTo).toHaveBeenCalledWith({ zoom: 1 });
    expect(insertFiles).toHaveBeenCalledWith({ paths: ['a.png', 'b/index.html'] });
  });

  it('passes undefined to payload-less handlers', () => {
    const handler = vi.fn();
    registerFantayCommand('fantay.openSettings', handler);
    runFantayCommand('fantay.openSettings');
    expect(handler).toHaveBeenCalledWith(undefined);
  });

  it('forgets every handler on reset', () => {
    registerFantayCommand('fantay.newProject', vi.fn());
    resetFantayCommandsForTests();
    expect(runFantayCommand('fantay.newProject')).toBe(false);
  });
});
