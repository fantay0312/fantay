// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/shell/menu/shortcut` (06 §3.4). OpenPencil derives these from its
 * app menu schema (which also names the OpenPencil app); Fantay keeps only the entries the
 * vendored menus show. Ids starting with `view.` resolve through the SDK command metadata.
 */
import { editorCommandMetadata, formatShortcut, type EditorCommandId } from '../engine/op';

export const APP_MENU_SHORTCUTS: Readonly<Record<string, string>> = {
  copy: 'MOD+C',
  cut: 'MOD+X',
  paste: 'MOD+V',
  save: 'MOD+S',
  'zoom-in': 'MOD+=',
  'zoom-out': 'MOD+-',
  'view-rulers': 'SHIFT+R',
  'view-pixel-grid': "SHIFT+'",
  'snap-pixel-grid': "MOD+SHIFT+'",
  'toggle-ui': 'MOD+\\',
  'text.bold': 'MOD+B',
  'text.italic': 'MOD+I',
  'text.underline': 'MOD+U',
};

export function appMenuShortcut(id: string): string | undefined {
  if (Object.prototype.hasOwnProperty.call(APP_MENU_SHORTCUTS, id)) return APP_MENU_SHORTCUTS[id];
  if (id.startsWith('view.')) {
    try {
      return editorCommandMetadata(id as EditorCommandId)?.shortcut;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function appMenuShortcutLabel(id: string): string | undefined {
  return formatShortcut(appMenuShortcut(id));
}
