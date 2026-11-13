// SPDX-License-Identifier: Apache-2.0
/**
 * Shim for OpenPencil's `@/app/settings/preferences/apply` (06 §3.4). Snapping preferences live
 * on the editor state (replaced as a whole, the state is shallow-reactive) and persist in
 * `localStorage['fantay:design:snapping']`. Design issues and comments do not exist in Fantay.
 */
import { DEFAULT_SNAPPING_PREFERENCES, type SnappingPreferences } from '../engine/op';
import { getActiveEditorStoreOrNull } from './active-store';

export const SNAPPING_STORAGE_KEY = 'fantay:design:snapping';

const SNAPPING_KEYS = ['geometry', 'objects', 'pixelGrid'] as const satisfies ReadonlyArray<keyof SnappingPreferences>;

export function readSnappingPreferences(): SnappingPreferences {
  const preferences: SnappingPreferences = { ...DEFAULT_SNAPPING_PREFERENCES };
  try {
    const stored: unknown = JSON.parse(globalThis.localStorage?.getItem(SNAPPING_STORAGE_KEY) ?? 'null');
    if (stored && typeof stored === 'object') {
      for (const key of SNAPPING_KEYS) {
        const value = (stored as Record<string, unknown>)[key];
        if (typeof value === 'boolean') preferences[key] = value;
      }
    }
  } catch {
    // Unreadable storage keeps the defaults.
  }
  return preferences;
}

export function setSnappingPreference(key: keyof SnappingPreferences, value: boolean): void {
  const store = getActiveEditorStoreOrNull();
  const next: SnappingPreferences = { ...(store?.state.snappingPreferences ?? readSnappingPreferences()), [key]: value };
  if (store) store.state.snappingPreferences = next;
  try {
    globalThis.localStorage?.setItem(SNAPPING_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Storage may be unavailable (private mode); the preference still applies to this session.
  }
}

/** Design issues are not shown in Fantay; kept for type completeness (unused after patch P5). */
export function setDesignIssuesOnCanvas(_value: boolean): void {}

/** Comments are not part of the Fantay editor; kept for type completeness (unused after patch P5). */
export function setCommentsOnCanvas(_value: boolean): void {}
