// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { __resetThemeForTests } from '../../src/fantay/theme/theme';
import {
  DEFAULT_ACCENT_COLOR,
  applyAppearanceToDocument,
  normalizeAccentColor,
  resolveAccentColor,
} from '../../src/state/appearance';

describe('normalizeAccentColor', () => {
  it('accepts six-digit hex colors and normalizes casing', () => {
    expect(normalizeAccentColor('  #4F46E5  ')).toBe('#4f46e5');
  });

  it('rejects invalid accent colors', () => {
    expect(normalizeAccentColor('blue')).toBeNull();
    expect(normalizeAccentColor('#123')).toBeNull();
    expect(normalizeAccentColor('#12345g')).toBeNull();
  });
});

describe('resolveAccentColor', () => {
  it('falls back to the first appearance color for missing or invalid values', () => {
    expect(resolveAccentColor(undefined)).toBe(DEFAULT_ACCENT_COLOR);
    expect(resolveAccentColor('blue')).toBe(DEFAULT_ACCENT_COLOR);
  });
});

describe('applyAppearanceToDocument', () => {
  afterEach(() => {
    __resetThemeForTests();
    vi.unstubAllGlobals();
    window.localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-theme-switching');
    document.documentElement.style.removeProperty('color-scheme');
    document.documentElement.style.removeProperty('--accent');
    document.documentElement.style.removeProperty('--accent-strong');
    document.documentElement.style.removeProperty('--accent-soft');
    document.documentElement.style.removeProperty('--accent-tint');
    document.documentElement.style.removeProperty('--accent-hover');
  });

  // Fantay owns the visible theme: `fantay:theme` in localStorage, defaulting to light when empty.
  it('applies the default light theme when storage is empty (even if OS prefers dark) and accent variables to the root element', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-color-scheme: dark'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    applyAppearanceToDocument({ accentColor: '#4F46E5' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#4f46e5');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toContain('#4f46e5');
  });

  it('does not apply appearance colors to global background variables', () => {
    document.documentElement.style.setProperty('--bg', '#fafafa');
    document.documentElement.style.setProperty('--bg-app', '#f7f7f7');

    applyAppearanceToDocument({ accentColor: '#059669' });

    expect(document.documentElement.style.getPropertyValue('--bg')).toBe('#fafafa');
    expect(document.documentElement.style.getPropertyValue('--bg-app')).toBe('#f7f7f7');

    document.documentElement.style.removeProperty('--bg');
    document.documentElement.style.removeProperty('--bg-app');
  });

  it('applies accent variables while repainting a stale theme with the stored preference', () => {
    window.localStorage.setItem('fantay:theme', 'dark');
    document.documentElement.setAttribute('data-theme', 'light');

    applyAppearanceToDocument({ accentColor: '#10B981' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-tint')).toContain('#10b981');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toContain('#10b981');
  });

  it('paints a stored light preference', () => {
    window.localStorage.setItem('fantay:theme', 'light');

    applyAppearanceToDocument({ accentColor: '#4F46E5' });

    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('replaces existing accent variables when the saved color changes', () => {
    applyAppearanceToDocument({ accentColor: '#4F46E5' });

    applyAppearanceToDocument({ accentColor: '#EF4444' });

    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-strong')).not.toContain('#4f46e5');
    expect(document.documentElement.style.getPropertyValue('--accent-soft')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-tint')).toContain('#ef4444');
    expect(document.documentElement.style.getPropertyValue('--accent-hover')).toContain('#ef4444');
  });

  it('falls back to the default accent when no valid accent is configured', () => {
    document.documentElement.style.setProperty('--accent', '#4f46e5');

    applyAppearanceToDocument({ accentColor: 'not-a-color' });

    // No stored preference follows the system; jsdom has no matchMedia, so that resolves light.
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    // The default accent is not written inline: --accent follows the theme tokens (legacy-aliases.css).
    expect(document.documentElement.style.getPropertyValue('--accent')).toBe('');
  });

  it('removes every inline accent variable when the default accent is applied', () => {
    applyAppearanceToDocument({ accentColor: '#4F46E5' });

    applyAppearanceToDocument({ accentColor: DEFAULT_ACCENT_COLOR });

    for (const name of ['--accent', '--accent-strong', '--accent-soft', '--accent-tint', '--accent-hover']) {
      expect(document.documentElement.style.getPropertyValue(name)).toBe('');
    }
  });
});
