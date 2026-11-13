/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Compile-level gate for the Fantay CSS entry (01 §2.7, plan R13): runs the web app's own PostCSS +
 * Tailwind pipeline on the real `src/fantay/styles/app.css` and checks the cascade layer contract.
 * The built-chunk check (Turbopack) is recorded in the W1-tokens-theme notes; this is its unit twin.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import tailwind from '@tailwindcss/postcss';
import postcss from 'postcss';
import { beforeAll, describe, expect, it } from 'vitest';
import { isInside, layerBlocks, layerTokens } from './css-blocks';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ENTRY = resolve(WEB_ROOT, 'src/fantay/styles/app.css');
const LAYER_ORDER = ['legacy', 'legacy-fixes', 'theme', 'base', 'components', 'utilities'];
/* Utilities the assertions need even before any Fantay component uses them (the entry scans src/fantay). */
const PROBE_CANDIDATES = '\n@source inline("bg-paper focus-ring text-caption rounded-pill duration-enter");\n';
const SCOPE_PRELUDE = /@scope\s*\(\.fx\)\s*to\s*\(\.fx-legacy,\s*\[data-fx-legacy\]\)\s*\{/;
/* styles/primitives.css:2-25 — the upstream 36px element button (lightningcss reorders its declarations). */
const PRIMITIVES_BUTTON = /(?:^|[\s{};])button\s*\{[^}]*height:\s*36px/m;

async function compile(optimize: boolean): Promise<string> {
  const source = readFileSync(ENTRY, 'utf8') + PROBE_CANDIDATES;
  const result = await postcss([tailwind({ base: WEB_ROOT, optimize })]).process(source, { from: ENTRY });
  return result.css;
}

describe.each([
  { optimize: false, label: 'dev (optimize: false)' },
  { optimize: true, label: 'prod (optimize: true)' },
])('Fantay CSS entry — $label', ({ optimize }) => {
  let css = '';

  beforeAll(async () => {
    css = await compile(optimize);
  }, 30_000);

  it('inlines every import (Turbopack receives no layered @import)', () => {
    expect(css.length).toBeGreaterThan(100_000);
    expect(css).not.toMatch(/@import\b/);
  });

  it('keeps the layer order legacy < legacy-fixes < theme < base < components < utilities', () => {
    const tokens = layerTokens(css).filter((token) => !token.startsWith('properties'));
    if (!optimize) {
      // The declared order statement comes first (Tailwind may only prepend `@layer properties`).
      expect(tokens[0]).toBe(`${LAYER_ORDER.join(',')};`);
      const statementIndex = layerTokens(css).indexOf(`${LAYER_ORDER.join(',')};`);
      expect(layerTokens(css).slice(0, statementIndex).every((token) => token === 'properties;')).toBe(true);
    }
    const firstSeen = LAYER_ORDER.map((name) =>
      tokens.findIndex((token) => token === `${name}{` || token === `${name};` || token.split(/[,;]/).includes(name)),
    );
    expect(firstSeen.every((index) => index >= 0)).toBe(true);
    expect([...firstSeen].sort((a, b) => a - b)).toEqual(firstSeen);
    const firstBlock = (name: string) => css.search(new RegExp(`@layer\\s+${name}\\s*\\{`));
    expect(firstBlock('legacy')).toBeLessThan(firstBlock('legacy-fixes'));
    expect(firstBlock('legacy-fixes')).toBeLessThan(firstBlock('theme'));
    expect(firstBlock('theme')).toBeLessThan(firstBlock('base'));
    expect(firstBlock('base')).toBeLessThan(firstBlock('utilities'));
  });

  it('puts the upstream global CSS in @layer legacy, Excalidraw before the Sketch overrides', () => {
    const legacy = layerBlocks(css, 'legacy');
    expect(legacy.length).toBeGreaterThan(0);
    const spinner = css.indexOf('.excalidraw .Spinner');
    const sketch = css.indexOf('.sketch-excalidraw-wrap .excalidraw');
    expect(isInside(legacy, spinner)).toBe(true);
    expect(isInside(legacy, sketch)).toBe(true);
    expect(spinner).toBeLessThan(sketch);
    const button = css.search(PRIMITIVES_BUTTON);
    expect(button, 'styles/primitives.css `button {` rule').toBeGreaterThan(-1);
    expect(isInside(legacy, button)).toBe(true);
  });

  it('puts the selector fixes (incl. the A3 body weight) in @layer legacy-fixes', () => {
    const fixes = layerBlocks(css, 'legacy-fixes');
    expect(fixes.length).toBeGreaterThan(0);
    const body = fixes.map((block) => block.body).join('\n');
    // Group A (literal white label on an accent fill) and group D (kind tags kept as literals) are what
    // legacy-fixes.css still carries; one selector from each proves both groups reached the layer.
    expect(body).toContain('.viewer-action-export');
    expect(body).toContain('.design-card-tag.tag-prototype');
    // Entries whose own stylesheet already pairs label and fill with tokens were dropped from the layer.
    expect(body).not.toContain('.chrome-action-export');
    expect(body).toMatch(/(?:^|[\s};])body\s*\{\s*font-weight:\s*500;?\s*\}/m);
  });

  it('puts tokens and aliases in @layer theme and emits no Tailwind theme block', () => {
    const theme = layerBlocks(css, 'theme');
    expect(isInside(theme, css.indexOf('--paper:'))).toBe(true);
    expect(isInside(theme, css.indexOf('--text-secondary:'))).toBe(true);
    expect(css).not.toMatch(/:root\s*,\s*:host\s*\{/);
    // `@theme inline reference` never declares --color-* / --text-* theme variables.
    expect(css).not.toMatch(/--color-paper\s*:/);
    expect(css).not.toMatch(/--text-body\s*:/);
  });

  it('scopes the preflight to .fx, stopping at .fx-legacy and [data-fx-legacy], inside @layer base', () => {
    const base = layerBlocks(css, 'base');
    const scope = css.search(SCOPE_PRELUDE);
    expect(scope).toBeGreaterThan(-1);
    expect(isInside(base, scope)).toBe(true);
    expect(isInside(base, css.indexOf('@keyframes fx-spin'))).toBe(true);
  });

  it('generates Fantay utilities from token variables in @layer utilities', () => {
    const utilities = layerBlocks(css, 'utilities');
    const bgPaper = /\.bg-paper\s*\{\s*background-color:\s*var\(--paper\)/;
    expect(css).toMatch(bgPaper);
    expect(isInside(utilities, css.search(bgPaper))).toBe(true);
    expect(isInside(utilities, css.indexOf('.focus-ring'))).toBe(true);
    // `rounded-pill` is the full pill (upstream `--radius-pill`); the Fantay 10px `--radius-chip` is a separate token.
    expect(css).toMatch(/\.rounded-pill\s*\{\s*border-radius:\s*var\(--radius-pill\)/);
    expect(css).not.toMatch(/\.rounded-pill\s*\{[^}]*--radius-chip/);
    expect(css).toMatch(/\.duration-enter\s*\{[^}]*transition-duration:\s*var\(--motion-enter\)/);
    expect(css).toMatch(/\.text-caption\s*\{\s*font-size:\s*var\(--type-caption\)/);
  });
});
