// SPDX-License-Identifier: Apache-2.0
/**
 * Theme switching inside the editor iframe (06 §4.4). The host sends `theme` bridge events; the
 * iframe never reloads. CSS follows `<html data-theme>` (Fantay tokens + op-theme.css); the
 * Skia-drawn canvas chrome (selection, rulers) reads the resolved plain-colour tokens.
 */
import { parseColor, type Color } from '../fx/engine/op';
import type { FxEditorStore } from '../fx/store/types';

export type EditorTheme = 'dark' | 'light';

export function normalizeTheme(value: unknown): EditorTheme {
  return value === 'light' ? 'light' : 'dark';
}

function readColor(style: CSSStyleDeclaration, name: string): Color | null {
  const value = style.getPropertyValue(name).trim();
  if (!value) return null;
  try {
    return parseColor(value);
  } catch {
    return null;
  }
}

export function applyTheme(theme: EditorTheme, store?: FxEditorStore | null): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.classList.toggle('dark', theme === 'dark');
  root.style.colorScheme = theme;
  if (!store) return;
  const style = getComputedStyle(root);
  store.state.theme = theme;
  const accent = readColor(style, '--color-accent');
  const onAccent = readColor(style, '--color-on-accent');
  if (accent && onAccent) store.state.selectionTheme = { color: accent, foreground: onAccent };
  const background = readColor(style, '--color-ruler-bg');
  const tick = readColor(style, '--color-ruler-tick');
  const text = readColor(style, '--color-ruler-text');
  if (background && tick && text) store.state.rulerTheme = { background, tick, text };
  store.requestRepaint();
}
