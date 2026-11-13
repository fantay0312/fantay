// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Editor shortcuts (06 §3.7) against a fake store: the table's rows, read-only, focus rules, forwarding. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installShortcuts, type ShortcutContext } from '../src/fx/editor/shortcuts';
import type { FxEditorStore } from '../src/fx/store/types';

function fakeStore() {
  const state = {
    selectedIds: new Set<string>(),
    activeTool: 'SELECT',
    editingTextId: null as string | null,
    numberFieldFocused: false,
    penState: null,
    pencilState: null,
    play: null,
    enteredContainerId: null,
    showRulers: false,
    showPixelGrid: undefined as boolean | undefined,
    snappingPreferences: { geometry: true, objects: true, pixelGrid: true },
  };
  const store = {
    state,
    setTool: vi.fn((tool: string) => {
      state.activeTool = tool;
    }),
    clearSelection: vi.fn(),
    viewportScreenCenter: () => ({ x: 100, y: 80 }),
    applyZoom: vi.fn(),
    nudgeSelected: vi.fn(),
    flushNudge: vi.fn(),
    requestRepaint: vi.fn(),
    getSelectedNodes: vi.fn(() => [] as Array<{ id: string; type: string; layoutMode?: string }>),
    setLayoutMode: vi.fn(),
    startTextEditing: vi.fn(),
    requestRender: vi.fn(),
    textEditor: null,
    penCommit: vi.fn(),
    penCancel: vi.fn(),
    pencilCancel: vi.fn(),
    exitContainer: vi.fn(),
    stopPlay: vi.fn(),
  };
  return store;
}

let store: ReturnType<typeof fakeStore>;
let ctx: ShortcutContext & { [key: string]: unknown };
let uninstall: () => void;
let readOnly = false;
let closeOnEscape = false;

beforeEach(() => {
  document.body.innerHTML = '<canvas id="canvas"></canvas><input id="field"><button id="button">b</button>';
  store = fakeStore();
  readOnly = false;
  closeOnEscape = false;
  ctx = {
    store: store as unknown as FxEditorStore,
    runCommand: vi.fn(),
    setOpacityTarget: vi.fn(),
    isReadOnly: () => readOnly,
    isOpDocument: () => false,
    saveNow: vi.fn(),
    toggleUi: vi.fn(),
    forwardShortcuts: () => ['$mod+KeyK'],
    closeOnEscape: () => closeOnEscape,
    requestClose: vi.fn(),
    forwardShortcut: vi.fn(),
    clipboardBlockedMessage: () => 'blocked',
    platform: 'mac',
  };
  uninstall = installShortcuts(ctx);
});

afterEach(() => {
  uninstall();
  vi.useRealTimers();
});

function press(code: string, init: KeyboardEventInit = {}, target: EventTarget = document.getElementById('canvas')!) {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function release(code: string, target: EventTarget = document.getElementById('canvas')!) {
  target.dispatchEvent(new KeyboardEvent('keyup', { code, bubbles: true }));
}

describe('installShortcuts', () => {
  it('switches tools with the SDK keys, without the comment tool', () => {
    expect(press('KeyR').defaultPrevented).toBe(true);
    expect(store.setTool).toHaveBeenLastCalledWith('RECTANGLE');
    press('KeyS', { shiftKey: true });
    expect(store.setTool).toHaveBeenLastCalledWith('SECTION');
    store.setTool.mockClear();
    expect(press('KeyC').defaultPrevented).toBe(false);
    expect(store.setTool).not.toHaveBeenCalled();
  });

  it('runs SDK commands by their metadata keybindings', () => {
    press('KeyZ', { metaKey: true });
    press('KeyZ', { metaKey: true, shiftKey: true });
    press('KeyD', { metaKey: true });
    press('Digit1', { shiftKey: true });
    press('BracketRight');
    expect(ctx.runCommand).toHaveBeenNthCalledWith(1, 'edit.undo');
    expect(ctx.runCommand).toHaveBeenNthCalledWith(2, 'edit.redo');
    expect(ctx.runCommand).toHaveBeenNthCalledWith(3, 'selection.duplicate');
    expect(ctx.runCommand).toHaveBeenNthCalledWith(4, 'view.zoomFit');
    expect(ctx.runCommand).toHaveBeenNthCalledWith(5, 'selection.bringToFront');
  });

  it('never fires while typing, editing text or composing', () => {
    press('KeyR', {}, document.getElementById('field')!);
    press('Backspace', {}, document.getElementById('field')!);
    press('KeyR', { isComposing: true });
    store.state.editingTextId = 'text-1';
    press('KeyR');
    store.state.editingTextId = null;
    store.state.numberFieldFocused = true;
    press('KeyR');
    expect(store.setTool).not.toHaveBeenCalled();
    expect(ctx.runCommand).not.toHaveBeenCalled();
  });

  it('blocks edits in read-only documents but keeps viewing', () => {
    readOnly = true;
    press('Backspace');
    press('KeyR');
    press('KeyZ', { metaKey: true });
    expect(ctx.runCommand).not.toHaveBeenCalled();
    expect(store.setTool).not.toHaveBeenCalled();
    press('KeyH');
    expect(store.setTool).toHaveBeenLastCalledWith('HAND');
    press('Digit0', { metaKey: true });
    expect(ctx.runCommand).toHaveBeenLastCalledWith('view.zoom100');
  });

  it('deletes with Backspace and Delete', () => {
    press('Backspace');
    press('Delete');
    expect(ctx.runCommand).toHaveBeenCalledTimes(2);
    expect(ctx.runCommand).toHaveBeenCalledWith('selection.delete');
  });

  it('walks siblings with Tab only while no control has focus', () => {
    press('Tab', {}, document.body);
    expect(ctx.runCommand).toHaveBeenLastCalledWith('selection.selectNextSibling');
    press('Tab', { shiftKey: true }, document.getElementById('canvas')!);
    expect(ctx.runCommand).toHaveBeenLastCalledWith('selection.selectPreviousSibling');
    const onButton = press('Tab', {}, document.getElementById('button')!);
    expect(onButton.defaultPrevented).toBe(false);
    expect(ctx.runCommand).toHaveBeenCalledTimes(2);
  });

  it('deselects on Escape, then asks the host to close when allowed', () => {
    store.state.selectedIds = new Set(['1:2']);
    press('Escape');
    expect(store.clearSelection).toHaveBeenCalledTimes(1);
    store.state.selectedIds = new Set();
    press('Escape');
    expect(ctx.requestClose).not.toHaveBeenCalled();
    closeOnEscape = true;
    press('Escape');
    expect(ctx.requestClose).toHaveBeenCalledTimes(1);
  });

  it('forwards the combos the host asked for', () => {
    const event = press('KeyK', { metaKey: true });
    expect(event.defaultPrevented).toBe(true);
    expect(ctx.forwardShortcut).toHaveBeenCalledWith('$mod+KeyK');
    press('KeyJ', { metaKey: true });
    expect(ctx.forwardShortcut).toHaveBeenCalledTimes(1);
  });

  it('pans with the hand tool while Space is held', () => {
    store.state.activeTool = 'RECTANGLE';
    press('Space');
    press('Space');
    expect(store.setTool).toHaveBeenCalledTimes(1);
    expect(store.setTool).toHaveBeenLastCalledWith('HAND');
    release('Space');
    expect(store.setTool).toHaveBeenLastCalledWith('RECTANGLE');
  });

  it('sets opacity from digits, two quick digits for an exact value', () => {
    vi.useFakeTimers();
    store.state.selectedIds = new Set(['1:2']);
    press('Digit5');
    expect(ctx.setOpacityTarget).toHaveBeenLastCalledWith(0.5, expect.any(String));
    press('Digit5');
    expect(ctx.setOpacityTarget).toHaveBeenLastCalledWith(0.55, expect.any(String));
    vi.advanceTimersByTime(1000);
    press('Digit0');
    expect(ctx.setOpacityTarget).toHaveBeenLastCalledWith(1, expect.any(String));
    expect(ctx.runCommand).toHaveBeenCalledWith('selection.setOpacity');
  });

  it('nudges by 1 px and 10 px and flushes on release', () => {
    store.state.selectedIds = new Set(['1:2']);
    press('ArrowUp');
    press('ArrowRight', { shiftKey: true });
    expect(store.nudgeSelected).toHaveBeenNthCalledWith(1, 0, -1);
    expect(store.nudgeSelected).toHaveBeenNthCalledWith(2, 10, 0);
    release('ArrowUp');
    expect(store.flushNudge).toHaveBeenCalledTimes(1);
  });

  it('zooms at the viewport centre, saves, toggles panels, rulers and the pixel grid', () => {
    press('Equal', { metaKey: true });
    press('Minus', { metaKey: true });
    expect(store.applyZoom).toHaveBeenNthCalledWith(1, -100, 100, 80);
    expect(store.applyZoom).toHaveBeenNthCalledWith(2, 100, 100, 80);
    press('KeyS', { metaKey: true });
    expect(ctx.saveNow).toHaveBeenCalledTimes(1);
    press('Backslash', { metaKey: true });
    expect(ctx.toggleUi).toHaveBeenCalledTimes(1);
    press('KeyR', { shiftKey: true });
    expect(store.state.showRulers).toBe(true);
    press('Quote', { shiftKey: true });
    expect(store.state.showPixelGrid).toBe(false);
  });

  it('holds back everything but undo/redo while a menu or popover is open', () => {
    const layer = document.createElement('div');
    layer.setAttribute('data-dismissable-layer', '');
    layer.setAttribute('data-state', 'open');
    document.body.appendChild(layer);
    press('Backspace');
    press('KeyR');
    expect(ctx.runCommand).not.toHaveBeenCalled();
    press('KeyZ', { metaKey: true });
    expect(ctx.runCommand).toHaveBeenCalledWith('edit.undo');
  });

  it('adds auto layout to a frame or wraps the selection with Shift+A', () => {
    store.getSelectedNodes.mockReturnValue([{ id: 'f', type: 'FRAME', layoutMode: 'NONE' }]);
    press('KeyA', { shiftKey: true });
    expect(store.setLayoutMode).toHaveBeenCalledWith('f', 'VERTICAL');
    store.getSelectedNodes.mockReturnValue([{ id: 'a', type: 'RECTANGLE' }, { id: 'b', type: 'RECTANGLE' }]);
    press('KeyA', { shiftKey: true });
    expect(ctx.runCommand).toHaveBeenLastCalledWith('selection.wrapInAutoLayout');
  });

  it('uninstalls cleanly', () => {
    uninstall();
    press('KeyR');
    expect(store.setTool).not.toHaveBeenCalled();
    uninstall = () => undefined;
  });
});
