// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from 'vitest';

import { BOARD_INTERACTIVE_ATTR } from '../../../src/fantay/board/extensions';
import {
  BOARD_SHORTCUTS,
  isActivationTarget,
  isOverlayOpen,
  isTypingTarget,
  resolveShortcut,
  type BoardShortcutId,
  type ShortcutContext,
  type ShortcutEventLike,
} from '../../../src/fantay/board/interaction/keyboard';

const key = (k: string, over: Partial<ShortcutEventLike> = {}): ShortcutEventLike => ({
  key: k,
  code: '',
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  repeat: false,
  ...over,
});

const mac: ShortcutContext = { isMac: true, hasSelection: true, singleLive: 'frame', mode: null };
const win: ShortcutContext = { ...mac, isMac: false };

afterEach(() => {
  document.body.innerHTML = '';
});

describe('resolveShortcut', () => {
  it('resolves every listed shortcut', () => {
    const cases: Array<[ShortcutEventLike, BoardShortcutId]> = [
      [key('v'), 'tool.select'],
      [key('h'), 'tool.hand'],
      [key('f'), 'tool.frame'],
      [key('r'), 'tool.rectangle'],
      [key('o'), 'tool.ellipse'],
      [key('t'), 'tool.text'],
      [key('g'), 'tool.generate'],
      [key('n'), 'tool.note'],
      [key('c'), 'tool.comment'],
      [key('=', { metaKey: true }), 'zoom.in'],
      [key('+', { metaKey: true, shiftKey: true }), 'zoom.in'],
      [key('-', { metaKey: true }), 'zoom.out'],
      [key('0', { metaKey: true }), 'zoom.reset'],
      [key('!', { shiftKey: true, code: 'Digit1' }), 'zoom.fit'],
      [key('@', { shiftKey: true, code: 'Digit2' }), 'zoom.selection'],
      [key('z', { metaKey: true }), 'edit.undo'],
      [key('z', { metaKey: true, shiftKey: true }), 'edit.redo'],
      [key('a', { metaKey: true }), 'edit.selectAll'],
      [key('d', { metaKey: true }), 'edit.duplicate'],
      [key('Delete'), 'edit.delete'],
      [key('Backspace'), 'edit.delete'],
      [key('g', { metaKey: true }), 'edit.group'],
      [key('g', { metaKey: true, shiftKey: true }), 'edit.ungroup'],
      [key('l', { metaKey: true, shiftKey: true }), 'edit.lock'],
      [key(']', { metaKey: true }), 'edit.forward'],
      [key('[', { metaKey: true }), 'edit.backward'],
      [key(']', { metaKey: true, altKey: true }), 'edit.front'],
      [key('[', { metaKey: true, altKey: true }), 'edit.back'],
      [key('F2'), 'edit.rename'],
      [key('ArrowLeft'), 'nudge.left'],
      [key('ArrowRight', { shiftKey: true }), 'nudge.right'],
      [key('ArrowUp'), 'nudge.up'],
      [key('ArrowDown'), 'nudge.down'],
      [key('Enter'), 'node.enter'],
      [key('e'), 'mode.edit'],
      [key('C', { shiftKey: true }), 'mode.capture'],
      [key('Escape'), 'escape'],
      [key('Tab'), 'select.next'],
      [key('Tab', { shiftKey: true }), 'select.prev'],
      [key('?', { shiftKey: true }), 'help'],
    ];
    for (const [event, id] of cases) expect(resolveShortcut(event, mac), JSON.stringify(event)).toBe(id);
    const listed = new Set(BOARD_SHORTCUTS.map((shortcut) => shortcut.id));
    for (const [, id] of cases) expect(listed.has(id)).toBe(true);
  });

  it('uses Ctrl as mod outside macOS (and Ctrl+Y redoes there)', () => {
    expect(resolveShortcut(key('z', { ctrlKey: true }), win)).toBe('edit.undo');
    expect(resolveShortcut(key('y', { ctrlKey: true }), win)).toBe('edit.redo');
    expect(resolveShortcut(key('z', { metaKey: true }), win)).toBeNull();
    expect(resolveShortcut(key('z', { ctrlKey: true }), mac)).toBeNull();
    expect(resolveShortcut(key('y', { metaKey: true }), mac)).toBeNull();
  });

  it('matches ⇧1 / ⇧2 by code, whatever the layout types', () => {
    expect(resolveShortcut(key('1', { shiftKey: true, code: 'Digit1' }), mac)).toBe('zoom.fit');
    expect(resolveShortcut(key('!', { shiftKey: true, code: 'KeyQ' }), mac)).toBeNull();
  });

  it('E / ⇧C only with one live-capable node selected (E: frames only); bare C is the Comment tool', () => {
    const shiftC = key('C', { shiftKey: true });
    expect(resolveShortcut(key('e'), { ...mac, singleLive: 'web' })).toBeNull();
    expect(resolveShortcut(shiftC, { ...mac, singleLive: 'web' })).toBe('mode.capture');
    expect(resolveShortcut(shiftC, { ...mac, singleLive: null })).toBeNull();
    expect(resolveShortcut(key('C', { shiftKey: true, repeat: true }), mac)).toBeNull();
    expect(resolveShortcut(key('e'), { ...mac, singleLive: null })).toBeNull();
    expect(resolveShortcut(key('c'), { ...mac, singleLive: null, hasSelection: false })).toBe('tool.comment');
  });

  it('selection-only shortcuts need a selection', () => {
    const none = { ...mac, hasSelection: false, singleLive: null };
    for (const event of [key('Delete'), key('ArrowLeft'), key('Enter'), key('F2'), key('d', { metaKey: true }), key('g', { metaKey: true })]) {
      expect(resolveShortcut(event, none)).toBeNull();
    }
    expect(resolveShortcut(key('v'), none)).toBe('tool.select');
  });

  it('ignores bare-key repeats and other modifier combos', () => {
    expect(resolveShortcut(key('v', { repeat: true }), mac)).toBeNull();
    expect(resolveShortcut(key('v', { altKey: true }), mac)).toBeNull();
    expect(resolveShortcut(key('v', { shiftKey: true }), mac)).toBeNull();
    expect(resolveShortcut(key('p', { metaKey: true }), mac)).toBeNull(); // ⌘P stays the app's
    expect(resolveShortcut(key('\\', { metaKey: true }), mac)).toBeNull(); // mod+\ toggles the sidebar (B5)
  });
});

describe('board-active rule helpers', () => {
  it('typing targets: inputs, textareas, selects, contenteditable and data-board-interactive regions', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    const inner = document.createElement('span');
    editable.append(inner);
    const region = document.createElement('div');
    region.setAttribute(BOARD_INTERACTIVE_ATTR, '');
    const regionChild = document.createElement('span');
    region.append(regionChild);
    const plain = document.createElement('div');
    document.body.append(input, textarea, select, editable, region, plain);
    expect(isTypingTarget(input)).toBe(true);
    expect(isTypingTarget(textarea)).toBe(true);
    expect(isTypingTarget(select)).toBe(true);
    expect(isTypingTarget(inner)).toBe(true);
    expect(isTypingTarget(regionChild)).toBe(true);
    expect(isTypingTarget(plain)).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });

  it('focused controls keep Space / Enter / arrows / Tab (activation targets)', () => {
    const button = document.createElement('button');
    const icon = document.createElement('span');
    button.append(icon);
    const radio = document.createElement('div');
    radio.setAttribute('role', 'radio');
    const plain = document.createElement('div');
    document.body.append(button, radio, plain);
    expect(isActivationTarget(icon)).toBe(true);
    expect(isActivationTarget(radio)).toBe(true);
    expect(isActivationTarget(plain)).toBe(false);
  });

  it('an open dialog or menu keeps its own keys', () => {
    expect(isOverlayOpen()).toBe(false);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('data-state', 'open');
    document.body.append(dialog);
    expect(isOverlayOpen()).toBe(true);
  });
});
