/* SPDX-License-Identifier: Apache-2.0 */
/**
 * Fantay tokens share the cascade with upstream CSS (01 §3.2, §2.5): raw token names must not collide with
 * upstream definitions except the three intended brand re-points, and Tailwind's theme stays non-emitting.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UPSTREAM_SHARED_TOKEN_NAMES } from '@fantay/tokens';
import postcss from 'postcss';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const TOKENS_CSS = resolve(WEB_ROOT, '../../packages/fantay-tokens/tokens.css');
const THEME_CSS = resolve(WEB_ROOT, 'src/fantay/styles/theme.css');

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

function definedProperties(css: string): Set<string> {
  const names = new Set<string>();
  postcss.parse(css).walkDecls((declaration) => {
    if (declaration.prop.startsWith('--')) names.add(declaration.prop);
  });
  return names;
}

describe('token collisions', () => {
  it('shares only --brand, --brand-ink and --brand-soft with apps/web/src/styles/**', () => {
    const fantay = definedProperties(readFileSync(TOKENS_CSS, 'utf8'));
    const upstream = new Set<string>();
    for (const file of cssFiles(resolve(WEB_ROOT, 'src/styles'))) {
      for (const name of definedProperties(readFileSync(file, 'utf8'))) upstream.add(name);
    }
    const shared = [...fantay].filter((name) => upstream.has(name)).sort();
    expect(shared).toEqual(UPSTREAM_SHARED_TOKEN_NAMES.map((name) => `--${name}`).sort());
    expect(shared).toEqual(['--brand', '--brand-ink', '--brand-soft']);
  });

  it('keeps the chip radius off upstream --radius-pill (999px)', () => {
    const fantay = definedProperties(readFileSync(TOKENS_CSS, 'utf8'));
    expect(fantay.has('--radius-chip')).toBe(true);
    expect(fantay.has('--radius-pill')).toBe(false);
  });

  it('declares Tailwind theme keys only as `@theme inline reference` (nothing emitted over upstream tokens)', () => {
    const themeCss = readFileSync(THEME_CSS, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const themeBlocks = themeCss.match(/@theme\b[^{]*\{/g) ?? [];
    expect(themeBlocks).toEqual(['@theme inline reference {']);
    expect(themeCss).toMatch(/@theme inline reference \{\s*--\*:\s*initial;/);
  });
});
