/* SPDX-License-Identifier: AGPL-3.0-only */
export type ThemePreference = 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';
export const THEME_STORAGE_KEY = 'fantay:theme';
export const DEFAULT_THEME_PREFERENCE: ThemePreference = 'light';
export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === 'dark' || raw === 'light' ? raw : DEFAULT_THEME_PREFERENCE;
}
export function resolveThemePreference(preference: ThemePreference, _systemPrefersDark?: boolean): ResolvedTheme {
  return preference === 'dark' ? 'dark' : 'light';
}
