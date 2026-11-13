// SPDX-License-Identifier: Apache-2.0
/**
 * Theme mapping (06 §4, R12): the editor imports the shared Fantay tokens directly, every
 * variable op-theme.css reads is defined for both themes, every colour the vendored OpenPencil
 * UI uses is mapped, the canvas reads only plain colours, and CJK labels keep a 12px floor.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(root, '../..');
const tokensCss = readFileSync(path.join(repoRoot, 'packages/fantay-tokens/tokens.css'), 'utf8');
const opThemeCss = readFileSync(path.join(root, 'src/theme/op-theme.css'), 'utf8');
const indexCss = readFileSync(path.join(root, 'src/theme/index.css'), 'utf8');

const stripComments = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');

interface Block {
  selector: string;
  declarations: Map<string, string>;
}

/** Flat rule blocks (selector + custom properties); good enough for the generated tokens file and op-theme.css. */
function blocks(css: string): Block[] {
  const result: Block[] = [];
  for (const match of stripComments(css).matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const declarations = new Map<string, string>();
    for (const declaration of match[2]!.split(';')) {
      const colon = declaration.indexOf(':');
      if (colon < 0) continue;
      const name = declaration.slice(0, colon).trim();
      if (name.startsWith('--')) declarations.set(name, declaration.slice(colon + 1).trim());
    }
    result.push({ selector: match[1]!.trim(), declarations });
  }
  return result;
}

const tokenBlocks = blocks(tokensCss);
const lightTokens = new Map<string, string>();
const darkTokens = new Map<string, string>();
for (const block of tokenBlocks) {
  const selector = block.selector.replace(/\s+/g, ' ');
  if (selector === ':root') {
    for (const [name, value] of block.declarations) {
      lightTokens.set(name, value);
      darkTokens.set(name, value);
    }
  } else if (selector === ':root, [data-theme="light"]') {
    for (const [name, value] of block.declarations) lightTokens.set(name, value);
  } else if (selector === '[data-theme="dark"]') {
    for (const [name, value] of block.declarations) darkTokens.set(name, value);
  }
}

const themeBlock = /@theme\s+static\s*\{([^}]*)\}/.exec(stripComments(opThemeCss));
const opTheme = new Map<string, string>();
for (const declaration of (themeBlock?.[1] ?? '').split(';')) {
  const colon = declaration.indexOf(':');
  if (colon > 0) opTheme.set(declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim());
}
const opThemeBlocks = blocks(opThemeCss.replace(/@theme\s+static\s*\{[^}]*\}/, ''));
const opLocal = (theme: 'dark' | 'light') =>
  new Map(opThemeBlocks.filter((block) => block.selector === `:root[data-theme='${theme}']`).flatMap((block) => [...block.declarations]));

/** OpenPencil v0.16.0 `src/theme/tokens.css` colour names (the vocabulary of the vendored class strings). */
const UPSTREAM_COLORS = [
  'white', 'black', 'panel', 'panel-secondary', 'panel-field', 'panel-field-hover', 'panel-focus', 'panel-selected',
  'panel-selected-muted', 'canvas', 'border', 'hover', 'accent', 'on-accent', 'on-primary', 'surface', 'muted', 'input',
  'component', 'slot', 'warning', 'warning-bg', 'warning-border', 'warning-action', 'success', 'primary', 'inverted', 'error',
  'error-bg', 'error-border', 'error-fill', 'success-fill', 'checkerboard', 'checkerboard-muted', 'ruler-bg', 'ruler-tick',
  'ruler-text', 'code-keyword', 'code-tag', 'code-string', 'code-number', 'code-comment',
];

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const uiSources = [...walk(path.join(root, 'src/vendor/open-pencil')), ...walk(path.join(root, 'src/fx'))]
  .filter((file) => /\.(?:ts|vue)$/.test(file))
  .map((file) => readFileSync(file, 'utf8'))
  .join('\n');

describe('tokens import (R12)', () => {
  it('imports @fantay/tokens directly and keeps no synced copy', () => {
    const imports = [...stripComments(indexCss).matchAll(/@import\s+'([^']+)';/g)].map((match) => match[1]);
    expect(imports).toEqual(['tailwindcss', 'tw-animate-css', '@fantay/tokens/tokens.css', './op-theme.css']);
    expect(existsSync(path.join(root, 'src/theme/fantay-tokens.css'))).toBe(false);
    expect(existsSync(path.join(root, 'scripts/sync-fantay-tokens.ts'))).toBe(false);
  });
});

describe('op-theme.css', () => {
  it('resets the Tailwind palette and emits every variable', () => {
    expect(themeBlock).not.toBeNull();
    expect(opTheme.get('--color-*')).toBe('initial');
  });

  it.each(['dark', 'light'] as const)('defines every variable it reads in the %s theme', (theme) => {
    const tokens = theme === 'dark' ? darkTokens : lightTokens;
    const local = opLocal(theme);
    const used = new Set([...stripComments(opThemeCss).matchAll(/var\(\s*(--[\w-]+)/g)].map((match) => match[1]!));
    const missing = [...used].filter((name) => !tokens.has(name) && !opTheme.has(name) && !local.has(name));
    expect(missing).toEqual([]);
  });

  it('maps the OpenPencil roles onto the Fantay tokens (06 §4.3)', () => {
    expect(Object.fromEntries([...opTheme].filter(([name]) => name.startsWith('--color-') && name !== '--color-*'))).toMatchObject({
      '--color-canvas': 'var(--paper)',
      '--color-panel': 'var(--surface)',
      '--color-panel-secondary': 'var(--sub)',
      '--color-panel-field': 'var(--paper-deep)',
      // Amendment A1 supersedes 06 §4.3 here: every focus indication uses the shared focus-ring colour.
      '--color-panel-focus': 'var(--focus-ring-color)',
      '--color-panel-selected': 'var(--brand)',
      '--color-panel-selected-muted': 'var(--brand-soft)',
      '--color-border': 'var(--line)',
      '--color-hover': 'var(--sub)',
      '--color-accent': 'var(--brand)',
      '--color-on-accent': '#ffffff',
      '--color-primary': 'var(--brand-ink)',
      '--color-on-primary': 'var(--paper)',
      '--color-surface': 'var(--ink)',
      '--color-muted': 'var(--ink-soft)',
      '--color-input': 'var(--paper)',
      '--color-component': 'var(--fx-op-component)',
      '--color-slot': 'var(--fx-op-slot)',
      '--color-warning': 'var(--warning-ink)',
      '--color-success': 'var(--success-ink)',
      '--color-error': 'var(--accent-ink)',
      '--color-ruler-bg': 'var(--surface)',
      '--color-ruler-tick': 'var(--ink-faint)',
      '--color-ruler-text': 'var(--ink-soft)',
    });
    for (const theme of ['dark', 'light'] as const) {
      expect(opLocal(theme).get('--fx-op-component')).toMatch(/^#[0-9a-f]{6}$/i);
      expect(opLocal(theme).get('--fx-op-slot')).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('defines every colour the vendored UI and the Fantay components use', () => {
    const prefixes = 'bg|text|border(?:-[trblxyse])?|ring(?:-offset)?|outline|fill|stroke|from|via|to|divide|placeholder|caret|accent|decoration|shadow';
    const used = UPSTREAM_COLORS.filter((name) =>
      new RegExp(`(?:^|[\\s'"\`:\\[(])(?:${prefixes})-${name}(?![\\w-])`).test(uiSources),
    );
    expect(used.length).toBeGreaterThan(20);
    const arbitrary = [...uiSources.matchAll(/var\(--color-([\w-]+)/g)].map((match) => match[1]!);
    const missing = [...new Set([...used, ...arbitrary])].filter((name) => !opTheme.has(`--color-${name}`));
    expect(missing).toEqual([]);
    // The code editor is not shipped, so its syntax colours are deliberately unmapped and unused.
    expect(used.filter((name) => name.startsWith('code-'))).toEqual([]);
  });

  it('gives the canvas chrome plain colours in both themes (host/theme.ts never reads color-mix)', () => {
    for (const variable of ['--color-accent', '--color-on-accent', '--color-ruler-bg', '--color-ruler-tick', '--color-ruler-text']) {
      const value = opTheme.get(variable)!;
      for (const tokens of [lightTokens, darkTokens]) {
        const resolved = /^var\((--[\w-]+)\)$/.exec(value)?.[1];
        const final = resolved ? tokens.get(resolved) : value;
        expect(final, variable).toMatch(/^#[0-9a-f]{3,8}$/i);
      }
    }
  });

  it('draws every vendored focus ring in the focus-ring colour (A1)', () => {
    // Rings drawn with the accent at partial strength are redirected; panel-focus maps to the token.
    const accentRings = new Set([...uiSources.matchAll(/focus-visible:ring-accent\/\d+/g)].map((match) => match[0]));
    expect(accentRings.size).toBeGreaterThan(0);
    const css = stripComments(opThemeCss);
    for (const ring of accentRings) {
      const selector = `.${ring.replace(/[:/]/g, (char) => `\\${char}`)}:focus-visible`;
      const rule = new RegExp(`${selector.replace(/[.\\/[\]]/g, (char) => `\\${char}`)}\\s*\\{\\s*--tw-ring-color:\\s*var\\(--focus-ring-color\\);\\s*\\}`);
      expect(css, ring).toMatch(rule);
    }
    expect(opTheme.get('--color-panel-focus')).toBe('var(--focus-ring-color)');
    expect(css).toMatch(/\.focus\\:ring-accent\\\/25:focus\s*\{\s*--tw-ring-color:\s*var\(--focus-ring-color\);\s*\}/);
    expect(css).toContain('var(--focus-ring-width) var(--focus-ring-color)');
  });

  it('keeps CJK labels at 12px or more', () => {
    const rule = /([^{}]+)\{\s*font-size:\s*12px;\s*line-height:\s*16px;\s*\}/.exec(stripComments(opThemeCss));
    expect(rule).not.toBeNull();
    const selectors = rule![1]!.trim().split(/,\s*(?=:root:lang)/).map((selector) => selector.trim());
    // Every sub-12px size the vendored UI uses is covered, for each CJK language.
    const sizes = new Set([...uiSources.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)].map((match) => Number(match[1])).filter((size) => size < 12));
    expect(sizes.size).toBeGreaterThan(0);
    for (const lang of ['zh', 'ja', 'ko']) {
      const selector = selectors.find((candidate) => candidate.startsWith(`:root:lang(${lang}) `));
      expect(selector, lang).toBeDefined();
      for (const size of sizes) expect(selector, `${lang} ${size}px`).toContain(`.text-\\[${size}px\\]`);
      // Numeric fields keep their size (digits only; widths cut for 11px).
      expect(selector).toContain(":not(:where(input, .tabular-nums, .tabular-nums *, [data-slot='paint-field'], [data-slot='paint-field'] *))");
    }
  });
});
