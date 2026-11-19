// SPDX-License-Identifier: AGPL-3.0-only
// Remembered switches of the 代码 surface. Storage can be off limits (private browsing, a locked-down
// webview), so every access is guarded and the surface works without it.

export function readStoredFlag(key: string, fallback: boolean): boolean {
  try {
    const stored = window.localStorage.getItem(key);
    return stored === '1' ? true : stored === '0' ? false : fallback;
  } catch {
    return fallback;
  }
}

export function writeStoredFlag(key: string, value: boolean): void {
  try {
    window.localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* storage is off limits */
  }
}
