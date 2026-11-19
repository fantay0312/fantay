import { describe, expect, it } from 'vitest';
import { PA_CHAT_THEMES, PA_THEME_SURFACES, contrastRatio, guardAccent } from '../../src/soul/index';
import type { PaChatTheme, PaColorMode } from '../../src/soul/index';

/** Each theme's own stage 1 accent (`--pa-skin-accent` in pa.css; `fantay` uses the base ink). */
const OWN_ACCENT: Record<PaChatTheme, Record<PaColorMode, string>> = {
  fantay: { light: '#181818', dark: '#ffffff' },
  clean: { light: '#215a45', dark: '#74c6a3' },
  sakura: { light: '#943b57', dark: '#f09bb4' },
  archive: { light: '#7d3225', dark: '#e69a88' },
  rain: { light: '#2e4e7e', dark: '#8fb4eb' },
  ink: { light: '#8c271e', dark: '#e58a7d' },
  deepsea: { light: '#17707a', dark: '#6fd0d6' },
};
const MODES: readonly PaColorMode[] = ['light', 'dark'];

describe('contrastRatio', () => {
  it('follows WCAG 2.x', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 10);
    expect(contrastRatio('#ffffff', '#000000')).toBeCloseTo(21, 10);
    expect(contrastRatio('#777777', '#777777')).toBe(1);
    expect(contrastRatio('#767676', '#FFFFFF')).toBeCloseTo(4.54, 2);
    expect(contrastRatio('#fff', '#000000')).toBeNaN();
    expect(contrastRatio('red', '#000000')).toBeNaN();
  });
});

describe('guardAccent', () => {
  it('keeps every input readable on every theme in both modes', () => {
    for (const theme of PA_CHAT_THEMES) {
      for (const input of ['#ffff00', '#ffffff', '#000000', '#7d3225', '#74c6a3', '#FF00AA', '#101010']) {
        const guard = guardAccent(theme, input);
        if (!guard?.ok) throw new Error(`${theme} ${input}: ${JSON.stringify(guard)}`);
        for (const mode of MODES) {
          const surfaces = PA_THEME_SURFACES[theme][mode];
          const tokens = guard[mode];
          const label = `${theme} ${mode} ${input}`;
          expect(contrastRatio(tokens.accent, surfaces.paper), label).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(tokens.accent, surfaces.cardBg), label).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(tokens.link, surfaces.inBg), label).toBeGreaterThanOrEqual(4.5);
          expect(contrastRatio(tokens.accentInk, tokens.accent), label).toBeGreaterThanOrEqual(4.5);
          expect(tokens.accent, label).toMatch(/^#[0-9a-f]{6}$/);
          expect(tokens.link, label).toMatch(/^#[0-9a-f]{6}$/);
          expect(['#ffffff', '#111111']).toContain(tokens.accentInk);
          expect(tokens.adjusted, label).toBe(tokens.accent !== input.toLowerCase());
        }
        expect(guard.adjusted).toBe(guard.light.adjusted || guard.dark.adjusted);
      }
    }
  });

  it('returns a theme its own accent unadjusted in its own mode', () => {
    for (const theme of PA_CHAT_THEMES) {
      for (const mode of MODES) {
        const own = OWN_ACCENT[theme][mode];
        const guard = guardAccent(theme, own);
        if (!guard?.ok) throw new Error(`${theme} ${mode}`);
        expect(guard[mode].accent, `${theme} ${mode}`).toBe(own);
        expect(guard[mode].adjusted, `${theme} ${mode}`).toBe(false);
      }
    }
  });

  it('keeps hue and saturation when it moves the lightness', () => {
    const guard = guardAccent('fantay', '#ffff00');
    if (!guard?.ok) throw new Error('not ok');
    expect(guard.light.adjusted).toBe(true);
    expect(guard.dark.accent).toBe('#ffff00');
    const [r, g, b] = [1, 3, 5].map(at => Number.parseInt(guard.light.accent.slice(at, at + 2), 16));
    expect(r).toBe(g);
    expect(b).toBe(0);
    expect(guardAccent('fantay', '#FFFF00')).toEqual(guard);
  });

  it('rejects an invalid value and answers null for none', () => {
    expect(guardAccent('fantay', '#12345')).toEqual({ ok: false, reason: 'invalid' });
    expect(guardAccent('fantay', 'red')).toEqual({ ok: false, reason: 'invalid' });
    expect(guardAccent('fantay', 42 as unknown as string)).toEqual({ ok: false, reason: 'invalid' });
    expect(guardAccent('fantay', null)).toBeNull();
    expect(guardAccent('fantay', undefined)).toBeNull();
  });
});
