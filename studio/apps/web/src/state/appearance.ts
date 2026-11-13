import type { AppTheme } from '../types';
import { paintThemePreference } from '../fantay/theme/theme';

const ACCENT_VARS = [
  '--accent',
  '--accent-strong',
  '--accent-soft',
  '--accent-tint',
  '--accent-hover',
] as const;

export const DEFAULT_ACCENT_COLOR = '#353535';
export const ACCENT_SWATCHES = [
  DEFAULT_ACCENT_COLOR,
  '#202020',
  '#848484',
  '#87ea5c',
  '#0d5400',
  '#1A74FF',
  '#FFBA12',
  '#FF7528',
  '#F04142',
] as const;

export function normalizeAccentColor(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return /^#[0-9a-fA-F]{6}$/.test(trimmed) ? trimmed.toLowerCase() : null;
}

export function resolveAccentColor(value: unknown): string {
  return normalizeAccentColor(value) ?? DEFAULT_ACCENT_COLOR;
}

function accentVars(accentColor: string): Record<(typeof ACCENT_VARS)[number], string> {
  return {
    '--accent': accentColor,
    // Keep these mix ratios in sync with the pre-hydration script in src/fantay/theme/init-script.ts.
    '--accent-strong': `color-mix(in srgb, ${accentColor} 82%, var(--text-strong))`,
    '--accent-soft': `color-mix(in srgb, ${accentColor} 12%, var(--bg-subtle))`,
    '--accent-tint': `color-mix(in srgb, ${accentColor} 6%, var(--bg-panel))`,
    '--accent-hover': `color-mix(in srgb, ${accentColor} 86%, var(--text-strong))`,
  };
}

/** Legacy config compatibility. The visible theme uses fantay:theme. */
export const FORCED_APP_THEME = 'system' as const;
export function resolveAppTheme(persisted?: AppTheme | null): AppTheme {
  return persisted === 'light' || persisted === 'dark' || persisted === 'system' ? persisted : FORCED_APP_THEME;
}

export function applyAppearanceToDocument({
  accentColor,
}: {
  accentColor?: string;
}): void {
  const root = document.documentElement;
  // Fantay: paint the stored preference (dark default) and sync the desktop window appearance.
  paintThemePreference();

  const normalized = resolveAccentColor(accentColor);
  // Fantay: the default accent follows the theme tokens (--accent → var(--ink)); only a custom accent is inline.
  if (normalized === DEFAULT_ACCENT_COLOR) {
    for (const name of ACCENT_VARS) root.style.removeProperty(name);
    return;
  }
  const vars = accentVars(normalized);
  for (const name of ACCENT_VARS) {
    root.style.setProperty(name, vars[name]);
  }
}
