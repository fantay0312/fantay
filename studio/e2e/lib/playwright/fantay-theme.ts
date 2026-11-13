// SPDX-License-Identifier: Apache-2.0
import type { BrowserContext, Page } from '@playwright/test';

/** Must equal THEME_STORAGE_KEY in @fantay/tokens and FANTAY_THEME_STORAGE_KEY in apps/web. */
export const FANTAY_THEME_STORAGE_KEY = 'fantay:theme';

export type FantayThemeSeed = 'dark' | 'light';

type StorageSeed = { key: string; value: string; pin: boolean };

function isBrowserContext(target: BrowserContext | Page): target is BrowserContext {
  return typeof (target as BrowserContext).newPage === 'function';
}

/**
 * Seed one localStorage entry before any app script runs.
 *
 * - On a BrowserContext it is a default for a fresh profile: written only while the key is absent, so a
 *   value the app (or the spec) stores later survives reloads and in-app navigation.
 * - On a Page it pins the value on every navigation of that page. Page init scripts run after context
 *   ones, so a page seed overrides the context default.
 */
export async function seedLocalStorageEntry(
  target: BrowserContext | Page,
  key: string,
  value: string,
): Promise<void> {
  const seed: StorageSeed = { key, value, pin: !isBrowserContext(target) };
  await target.addInitScript((entry: StorageSeed) => {
    try {
      const storage = window.localStorage;
      if (entry.pin || storage.getItem(entry.key) === null) storage.setItem(entry.key, entry.value);
    } catch {
      // Opaque origins (about:blank, sandboxed frames) have no storage; the app falls back to its default.
    }
  }, seed);
}

/**
 * Upstream specs assume the old forced-light app: seed `light` per context. Fantay specs override per page
 * (page init scripts run after context ones), e.g. `await seedFantayTheme(page, 'dark')`.
 */
export async function seedFantayTheme(
  target: BrowserContext | Page,
  theme: FantayThemeSeed = 'light',
): Promise<void> {
  await seedLocalStorageEntry(target, FANTAY_THEME_STORAGE_KEY, theme);
}
