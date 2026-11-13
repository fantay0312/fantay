// SPDX-License-Identifier: Apache-2.0
/**
 * Keybindings in the SDK's notation (06 §3.7): `$mod+Shift+KeyZ`, `Alt+Shift+KeyU`, `Backslash`,
 * `Control+Meta+KeyM`. `$mod` is Meta on macOS and Control elsewhere; the key part matches
 * `event.code` (the physical key, as Figma does). Modifiers must match exactly. No dependency
 * (upstream uses tinykeys).
 */
import { isCanvasTextInput } from '../engine/op';

export type KeyPlatform = 'mac' | 'other';

export interface ParsedKeybinding {
  key: string;
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export interface KeyEventLike {
  code: string;
  key?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
  target?: EventTarget | null;
}

export function detectKeyPlatform(source?: { platform?: string; userAgent?: string } | null): KeyPlatform {
  const nav = source ?? (typeof navigator === 'undefined' ? null : navigator);
  const text = `${nav?.platform ?? ''} ${nav?.userAgent ?? ''}`;
  return /Mac|iPhone|iPad|iPod/.test(text) ? 'mac' : 'other';
}

const MODIFIER_CODES = new Set(['MetaLeft', 'MetaRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'ShiftLeft', 'ShiftRight']);

export function parseKeybinding(binding: string, platform: KeyPlatform = detectKeyPlatform()): ParsedKeybinding {
  const parts = binding.split('+').filter(Boolean);
  const key = parts.pop() ?? '';
  const parsed: ParsedKeybinding = { key, meta: false, ctrl: false, alt: false, shift: false };
  for (const part of parts) {
    switch (part) {
      case '$mod':
        if (platform === 'mac') parsed.meta = true;
        else parsed.ctrl = true;
        break;
      case 'Meta':
        parsed.meta = true;
        break;
      case 'Control':
        parsed.ctrl = true;
        break;
      case 'Alt':
        parsed.alt = true;
        break;
      case 'Shift':
        parsed.shift = true;
        break;
      default:
        throw new Error(`Unknown modifier "${part}" in keybinding "${binding}"`);
    }
  }
  return parsed;
}

export function matchesKeybinding(event: KeyEventLike, binding: string | ParsedKeybinding, platform: KeyPlatform = detectKeyPlatform()): boolean {
  const parsed = typeof binding === 'string' ? parseKeybinding(binding, platform) : binding;
  return (
    event.code === parsed.key &&
    event.metaKey === parsed.meta &&
    event.ctrlKey === parsed.ctrl &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

/** The event as a keybinding string (`$mod` for the platform's primary modifier), or null for a bare modifier. */
export function keybindingForEvent(event: KeyEventLike, platform: KeyPlatform = detectKeyPlatform()): string | null {
  if (!event.code || MODIFIER_CODES.has(event.code)) return null;
  const parts: string[] = [];
  const primary = platform === 'mac' ? event.metaKey : event.ctrlKey;
  if (primary) parts.push('$mod');
  if (platform === 'mac' ? event.ctrlKey : event.metaKey) parts.push(platform === 'mac' ? 'Control' : 'Meta');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  parts.push(event.code);
  return parts.join('+');
}

function elementOf(target: EventTarget | null | undefined): Element | null {
  if (!target || typeof Element === 'undefined') return null;
  return target instanceof Element ? target : null;
}

/** Inputs, text areas, selects, contenteditable regions and comboboxes keep their own keys. */
export function isEditableTarget(target: EventTarget | null | undefined): boolean {
  const element = elementOf(target);
  if (!element) return false;
  if (element.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="combobox"]')) return true;
  return element instanceof HTMLElement && element.isContentEditable === true;
}

/** Shortcuts never run while typing in a field, while editing text on the canvas, or during IME composition. */
export function isTypingEvent(event: KeyEventLike): boolean {
  if (event.isComposing) return true;
  if (isEditableTarget(event.target)) return true;
  const element = elementOf(event.target);
  return element !== null && isCanvasTextInput(element);
}
