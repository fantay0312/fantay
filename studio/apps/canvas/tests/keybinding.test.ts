// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/** Keybindings (06 §3.7): `$mod` per platform, exact modifiers, `event.code`, ignored targets and IME composition. */
import { describe, expect, it } from 'vitest';

import { isEditableTarget, isTypingEvent, keybindingForEvent, matchesKeybinding, parseKeybinding, detectKeyPlatform } from '../src/fx/editor/keybinding';

const key = (code: string, modifiers: Partial<Record<'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey', boolean>> = {}, extra: Partial<KeyboardEvent> = {}) => ({
  code,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...modifiers,
  ...extra,
});

describe('parseKeybinding', () => {
  it('maps $mod to Meta on macOS and Control elsewhere', () => {
    expect(parseKeybinding('$mod+KeyZ', 'mac')).toEqual({ key: 'KeyZ', meta: true, ctrl: false, alt: false, shift: false });
    expect(parseKeybinding('$mod+KeyZ', 'other')).toEqual({ key: 'KeyZ', meta: false, ctrl: true, alt: false, shift: false });
    expect(parseKeybinding('Control+Meta+KeyM', 'other')).toMatchObject({ meta: true, ctrl: true });
    expect(parseKeybinding('Alt+Shift+KeyU', 'mac')).toMatchObject({ key: 'KeyU', alt: true, shift: true });
    expect(parseKeybinding('Backslash', 'mac')).toEqual({ key: 'Backslash', meta: false, ctrl: false, alt: false, shift: false });
    expect(() => parseKeybinding('Hyper+KeyA', 'mac')).toThrow();
  });

  it('detects the platform from the navigator', () => {
    expect(detectKeyPlatform({ platform: 'MacIntel', userAgent: '' })).toBe('mac');
    expect(detectKeyPlatform({ platform: 'Win32', userAgent: 'Windows NT 10.0' })).toBe('other');
    expect(detectKeyPlatform({ platform: '', userAgent: 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)' })).toBe('mac');
  });
});

describe('matchesKeybinding', () => {
  it('matches $mod per platform', () => {
    expect(matchesKeybinding(key('KeyZ', { metaKey: true }), '$mod+KeyZ', 'mac')).toBe(true);
    expect(matchesKeybinding(key('KeyZ', { ctrlKey: true }), '$mod+KeyZ', 'mac')).toBe(false);
    expect(matchesKeybinding(key('KeyZ', { ctrlKey: true }), '$mod+KeyZ', 'other')).toBe(true);
    expect(matchesKeybinding(key('KeyZ', { metaKey: true }), '$mod+KeyZ', 'other')).toBe(false);
  });

  it('requires exactly the listed modifiers', () => {
    expect(matchesKeybinding(key('KeyZ', { metaKey: true, shiftKey: true }), '$mod+KeyZ', 'mac')).toBe(false);
    expect(matchesKeybinding(key('KeyZ', { metaKey: true, shiftKey: true }), '$mod+Shift+KeyZ', 'mac')).toBe(true);
    expect(matchesKeybinding(key('KeyS', { altKey: true, shiftKey: true }), 'Alt+Shift+KeyS', 'mac')).toBe(true);
    expect(matchesKeybinding(key('KeyS', { shiftKey: true }), 'Alt+Shift+KeyS', 'mac')).toBe(false);
    expect(matchesKeybinding(key('KeyV'), 'KeyV', 'mac')).toBe(true);
    expect(matchesKeybinding(key('KeyV', { shiftKey: true }), 'KeyV', 'mac')).toBe(false);
  });

  it('matches the physical key (event.code), not the produced character', () => {
    // Shift+' types a double quote; Figma's pixel grid shortcut still matches its key position.
    expect(matchesKeybinding(key('Quote', { shiftKey: true }, { key: '"' }), 'Shift+Quote', 'mac')).toBe(true);
    // AZERTY: the key printed A sits where QWERTY has Q.
    expect(matchesKeybinding(key('KeyQ', {}, { key: 'a' }), 'KeyA', 'mac')).toBe(false);
    expect(matchesKeybinding(key('Digit1', { shiftKey: true }, { key: '!' }), 'Shift+Digit1', 'other')).toBe(true);
  });

  it('turns events back into keybindings for forwarding', () => {
    expect(keybindingForEvent(key('KeyK', { metaKey: true }), 'mac')).toBe('$mod+KeyK');
    expect(keybindingForEvent(key('KeyK', { ctrlKey: true, shiftKey: true }), 'other')).toBe('$mod+Shift+KeyK');
    expect(keybindingForEvent(key('KeyM', { ctrlKey: true, metaKey: true }), 'mac')).toBe('$mod+Control+KeyM');
    expect(keybindingForEvent(key('ShiftLeft', { shiftKey: true }), 'mac')).toBeNull();
    const combo = keybindingForEvent(key('KeyK', { metaKey: true }), 'mac')!;
    expect(matchesKeybinding(key('KeyK', { metaKey: true }), combo, 'mac')).toBe(true);
  });
});

describe('ignored targets', () => {
  it('treats fields, contenteditable regions and comboboxes as typing', () => {
    document.body.innerHTML = `
      <input id="input"><textarea id="textarea"></textarea><select id="select"><option>1</option></select>
      <div contenteditable="true" id="editable"><span id="inside">x</span></div>
      <div role="combobox" id="combo"><span id="combo-child"></span></div>
      <button id="button">b</button><canvas id="canvas"></canvas>`;
    for (const id of ['input', 'textarea', 'select', 'editable', 'inside', 'combo', 'combo-child']) {
      expect(isEditableTarget(document.getElementById(id)), id).toBe(true);
      expect(isTypingEvent(key('KeyV', {}, { target: document.getElementById(id) })), id).toBe(true);
    }
    for (const id of ['button', 'canvas']) {
      expect(isEditableTarget(document.getElementById(id)), id).toBe(false);
      expect(isTypingEvent(key('KeyV', {}, { target: document.getElementById(id) })), id).toBe(false);
    }
    expect(isEditableTarget(null)).toBe(false);
  });

  it('always ignores IME composition', () => {
    expect(isTypingEvent(key('KeyN', {}, { isComposing: true, target: document.body }))).toBe(true);
  });
});
