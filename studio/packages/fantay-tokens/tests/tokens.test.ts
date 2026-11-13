/* SPDX-License-Identifier: AGPL-3.0-only */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CJK_OVERRIDES,
  COLOR_TOKENS,
  DEFAULT_THEME_PREFERENCE,
  DERIVED_TOKENS,
  SHADOW_TOKENS,
  STATIC_TOKENS,
  THEME_STORAGE_KEY,
  listTokenNames,
  parseThemePreference,
  renderTokensCss,
  resolveThemePreference,
  type ThemeName,
} from '../src/index';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const THEMES: readonly ThemeName[] = ['light', 'dark'];

type ColorName = keyof typeof COLOR_TOKENS;

/** WCAG 2.x relative luminance of an opaque `#rrggbb` colour. */
function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) throw new Error(`contrast needs an opaque #rrggbb colour, got ${hex}`);
  const [r, g, b] = [match[1], match[2], match[3]].map((part) => {
    const channel = Number.parseInt(part ?? '0', 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

function color(name: ColorName, theme: ThemeName): string {
  return COLOR_TOKENS[name][theme];
}

/** `var(--x)` resolved one level through the token tables (derived tokens point at colour tokens). */
function resolveColor(value: string, theme: ThemeName): string {
  const reference = /^var\(--([a-z0-9-]+)\)$/.exec(value);
  if (!reference) return value;
  const target = reference[1] as ColorName;
  if (!(target in COLOR_TOKENS)) throw new Error(`${value} does not point at a colour token`);
  return color(target, theme);
}

describe('tokens.css', () => {
  it('is the committed output of renderTokensCss() (run `pnpm --filter @fantay/tokens generate`)', () => {
    const committed = readFileSync(resolve(PACKAGE_ROOT, 'tokens.css'), 'utf8');
    expect(committed).toBe(renderTokensCss());
  });

  it('renders deterministically', () => {
    expect(renderTokensCss()).toBe(renderTokensCss());
  });

  it('declares static tokens on :root, CJK overrides under :lang(), and both theme blocks', () => {
    const css = renderTokensCss();
    expect(css).toContain(':root {\n  /* radii');
    expect(css).toContain(':root:lang(zh),\n:root:lang(ja),\n:root:lang(ko) {');
    expect(css).toContain(':root,\n[data-theme="light"] {\n  color-scheme: light;');
    expect(css).toContain('[data-theme="dark"] {\n  color-scheme: dark;');
    expect(css.endsWith('}\n')).toBe(true);
  });

  it('emits derived tokens in both theme blocks so theme islands re-resolve them', () => {
    const css = renderTokensCss();
    const lightBlock = css.slice(css.indexOf('[data-theme="light"] {'), css.indexOf('[data-theme="dark"] {'));
    const darkBlock = css.slice(css.indexOf('[data-theme="dark"] {'));
    for (const [name, value] of Object.entries(DERIVED_TOKENS)) {
      expect(lightBlock).toContain(`  --${name}: ${value};`);
      expect(darkBlock).toContain(`  --${name}: ${value};`);
    }
  });
});

describe('token tables', () => {
  it('gives every colour and shadow token a light and a dark value', () => {
    for (const table of [COLOR_TOKENS, SHADOW_TOKENS]) {
      for (const [name, value] of Object.entries(table)) {
        for (const theme of THEMES) {
          expect(value[theme], `${name} ${theme}`).toMatch(/\S/);
        }
      }
    }
  });

  it('uses every token name once', () => {
    const names = listTokenNames();
    expect(new Set(names).size).toBe(names.length);
    expect(Object.keys(CJK_OVERRIDES).every((name) => name in STATIC_TOKENS)).toBe(true);
  });

  it('pins the focus ring and the neutral primary', () => {
    expect(DERIVED_TOKENS['focus-ring-color']).toBe('var(--info)');
    expect(STATIC_TOKENS['focus-ring-width']).toBe('2px');
    expect(STATIC_TOKENS['focus-ring-offset']).toBe('2px');
    expect(COLOR_TOKENS.brand).toEqual({ light: '#181818', dark: '#ffffff' });
    expect(COLOR_TOKENS['on-brand']).toEqual({ light: '#ffffff', dark: '#181818' });
    expect(COLOR_TOKENS.info).toEqual({ light: '#407bd9', dark: '#4d81ef' });
  });

  it('defines the names other specs bind to (91 B1)', () => {
    const names = new Set(listTokenNames());
    for (const role of ['caption', 'label', 'body', 'copy', 'lead', 'heading', 'title']) {
      expect(names.has(`type-${role}`), `type-${role}`).toBe(true);
      expect(names.has(`type-${role}-lh`), `type-${role}-lh`).toBe(true);
    }
    for (const name of ['radius-chip', 'font-ui', 'ease-out-quint', 'motion-enter', 'motion-exit']) {
      expect(names.has(name), name).toBe(true);
    }
    expect(STATIC_TOKENS['radius-chip']).toBe('10px');
    expect(names.has('radius-pill')).toBe(false);
    expect(STATIC_TOKENS['motion-enter']).toBe('200ms');
    expect(STATIC_TOKENS['motion-exit']).toBe('140ms');
    expect(STATIC_TOKENS['ease-out-quint']).toBe('cubic-bezier(0.23, 1, 0.32, 1)');
  });
});

describe('contrast (WCAG 2.x, 01 §6 amended by 91 A1/A2)', () => {
  const textPairs: Array<[ColorName, ColorName, number]> = [
    ['ink', 'paper', 7],
    ['ink-soft', 'paper', 4.5],
    ['ink-soft', 'surface', 4.5],
    ['brand-ink', 'paper', 4.5],
    ['info-ink', 'paper', 4.5],
    ['accent-ink', 'paper', 4.5],
    ['on-danger', 'danger', 4.5],
    ['on-brand', 'brand', 4.5],
    ['on-brand', 'brand-hover', 4.5],
  ];

  for (const theme of THEMES) {
    for (const [foreground, background, minimum] of textPairs) {
      it(`${theme}: ${foreground} on ${background} ≥ ${minimum}:1`, () => {
        expect(contrastRatio(color(foreground, theme), color(background, theme))).toBeGreaterThanOrEqual(minimum);
      });
    }

    for (const surface of ['paper', 'surface', 'sub', 'paper-deep'] as const) {
      it(`${theme}: the focus ring is ≥ 3:1 on ${surface} (WCAG 1.4.11)`, () => {
        const ring = resolveColor(DERIVED_TOKENS['focus-ring-color'], theme);
        expect(contrastRatio(ring, color(surface, theme))).toBeGreaterThanOrEqual(3);
      });
    }
  }
});

describe('theme preference', () => {
  it('stores the preference under fantay:theme with a light default', () => {
    expect(THEME_STORAGE_KEY).toBe('fantay:theme');
    expect(DEFAULT_THEME_PREFERENCE).toBe('light');
  });

  it('parses only dark | light and falls back to light (including legacy system)', () => {
    expect(parseThemePreference('dark')).toBe('dark');
    expect(parseThemePreference('light')).toBe('light');
    for (const raw of ['system', null, undefined, '', 'Dark', 'auto', 1, {}, true]) {
      expect(parseThemePreference(raw)).toBe('light');
    }
  });

  it('resolves fixed dark | light preferences directly regardless of OS preference', () => {
    const table: Array<[Parameters<typeof resolveThemePreference>[0], boolean, 'dark' | 'light']> = [
      ['dark', false, 'dark'],
      ['dark', true, 'dark'],
      ['light', false, 'light'],
      ['light', true, 'light'],
    ];
    for (const [preference, systemPrefersDark, expected] of table) {
      expect(resolveThemePreference(preference, systemPrefersDark)).toBe(expected);
    }
  });
});
