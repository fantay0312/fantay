/* SPDX-License-Identifier: Apache-2.0 */
/**
 * legacy-aliases.css (01 §3.4): upstream token names and phantom tokens resolve to Fantay semantic tokens,
 * declared on `:root, [data-theme]` so theme islands re-resolve them.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTokenNames } from '@fantay/tokens';
import postcss, { type AtRule, type Declaration, type Rule } from 'postcss';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const ALIASES_PATH = resolve(WEB_ROOT, 'src/fantay/styles/legacy-aliases.css');
const UPSTREAM_STYLES = resolve(WEB_ROOT, 'src/styles');

/** Upstream tokens §3.4 re-points (styles/tokens.css, base.css). */
const UPSTREAM_ALIASED = [
  '--bg', '--bg-app', '--bg-panel', '--bg-subtle', '--bg-muted', '--bg-elevated',
  '--bg-fill-tertiary', '--bg-fill-secondary', '--bg-fill',
  '--border', '--border-soft', '--border-strong', '--border-selected',
  '--text-strong', '--text', '--text-muted', '--text-soft', '--text-faint', '--select-ink',
  '--accent', '--accent-contrast', '--accent-strong', '--accent-soft', '--accent-tint', '--accent-hover',
  '--selected', '--selected-soft',
  '--brand-weak', '--brand-text', '--brand-surface',
  '--send-ink', '--send-ground', '--upgrade-ground', '--upgrade-ink',
  '--green', '--green-bg', '--green-border', '--blue', '--blue-bg', '--blue-border',
  '--purple', '--purple-bg', '--purple-border', '--red', '--red-bg', '--red-border', '--amber', '--amber-bg',
  '--sans', '--serif', '--mono',
];

/** Used upstream / in fork code, defined nowhere before Fantay (scan: ui-foundation/phantoms.py). */
const PHANTOMS = [
  '--text-primary', '--text-secondary', '--text-default', '--text-disabled', '--text-danger', '--text-success',
  '--text-warning', '--bg-primary', '--bg-secondary', '--bg-tertiary', '--bg-default', '--bg-hover',
  '--bg-panel-strong', '--border-color', '--border-subtle', '--surface-1', '--surface-2', '--surface-subtle',
  '--surface-strong', '--surface-hover', '--panel', '--subtle', '--foreground', '--background', '--fg-1', '--fg-2',
  '--accent-subtle', '--accent-text', '--danger-text', '--danger-fg', '--success-text', '--success-fg',
  '--success-bg', '--warning-text', '--warning-fg', '--warning-border', '--warning-surface',
];

function cssFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return cssFiles(path);
    return entry.name.endsWith('.css') ? [path] : [];
  });
}

/** Every custom property declared anywhere in apps/web/src/styles/**. */
function upstreamDefinitions(): Set<string> {
  const names = new Set<string>();
  for (const file of cssFiles(UPSTREAM_STYLES)) {
    postcss.parse(readFileSync(file, 'utf8')).walkDecls((declaration) => {
      if (declaration.prop.startsWith('--')) names.add(declaration.prop);
    });
  }
  return names;
}

const root = postcss.parse(readFileSync(ALIASES_PATH, 'utf8'));

function rulesWithSelector(selector: string, scope: 'top' | 'any' = 'top'): Rule[] {
  const rules: Rule[] = [];
  root.walkRules((rule) => {
    if (scope === 'top' && rule.parent?.type !== 'root') return;
    if (rule.selectors.map((part) => part.trim()).join(', ') === selector) rules.push(rule);
  });
  return rules;
}

function declarations(rule: Rule): Map<string, string> {
  const map = new Map<string, string>();
  rule.each((node) => {
    if (node.type === 'decl') map.set((node as Declaration).prop, (node as Declaration).value);
  });
  return map;
}

describe('legacy-aliases.css', () => {
  const [mainRule, ...extra] = rulesWithSelector(':root, [data-theme]');
  const main = mainRule ? declarations(mainRule) : new Map<string, string>();

  it('declares the aliases once, on `:root, [data-theme]`', () => {
    expect(mainRule).toBeDefined();
    expect(extra).toHaveLength(0);
  });

  it('aliases every upstream token §3.4 names, and each one really is an upstream token', () => {
    const upstream = upstreamDefinitions();
    for (const name of UPSTREAM_ALIASED) {
      expect(upstream.has(name), `${name} defined upstream`).toBe(true);
      expect(main.has(name), `${name} aliased`).toBe(true);
    }
  });

  it('defines every phantom token, none of which upstream defines', () => {
    const upstream = upstreamDefinitions();
    for (const name of PHANTOMS) {
      expect(upstream.has(name), `${name} is still a phantom upstream`).toBe(false);
      expect(main.has(name), `${name} aliased`).toBe(true);
    }
  });

  it('resolves aliases only through Fantay tokens, never through upstream names', () => {
    const fantay = new Set(listTokenNames().map((name) => `--${name}`));
    for (const [name, value] of main) {
      for (const reference of value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        expect(fantay.has(reference[1] ?? ''), `${name}: ${value}`).toBe(true);
      }
    }
  });

  it('references no upstream name anywhere: every modal scrim is the --scrim token with no backdrop, and no media / supports fallback re-points it', () => {
    const fantay = new Set(listTokenNames().map((name) => `--${name}`));
    const upstreamReferences: string[] = [];
    root.walkDecls((declaration) => {
      for (const reference of declaration.value.matchAll(/var\(\s*(--[\w-]+)/g)) {
        const name = reference[1] ?? '';
        if (fantay.has(name)) continue;
        const atRule = declaration.parent?.parent;
        const where = atRule && atRule.type === 'atrule' ? (atRule as AtRule).name : 'top';
        upstreamReferences.push(`${declaration.prop}=${name}@${where}`);
      }
    });
    expect(upstreamReferences).toEqual([]);

    // The scrim is declared once, on :root, and nothing (@media / @supports) overrides it.
    const scrimDeclarations: string[] = [];
    root.walkDecls(/^--scrim-(tint|backdrop)$/, (declaration) => {
      const parent = declaration.parent;
      const where = parent?.parent && parent.parent.type === 'atrule' ? (parent.parent as AtRule).name : 'top';
      scrimDeclarations.push(`${declaration.prop}=${declaration.value}@${where}`);
    });
    expect(scrimDeclarations.sort()).toEqual(['--scrim-backdrop=none@top', '--scrim-tint=var(--scrim)@top']);
  });

  it('carries a theme-specific tick mark for light and dark', () => {
    const light = rulesWithSelector(':root, [data-theme="light"]')[0];
    const dark = rulesWithSelector('[data-theme="dark"]')[0];
    expect(light && declarations(light).get('--tick-img')).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(dark && declarations(dark).get('--tick-img')).toMatch(/^url\("data:image\/svg\+xml,/);
    expect(light && declarations(light).get('--tick-img')).not.toBe(dark && declarations(dark).get('--tick-img'));
  });

  it('re-points --sans on every element where upstream re-declares it per language (zh, ko, rtl)', () => {
    // Upstream declares --sans on each element under these selectors, so the root alias cannot reach them.
    const upstreamLibrary = readFileSync(resolve(UPSTREAM_STYLES, 'viewer/library.css'), 'utf8');
    expect(upstreamLibrary).toMatch(/:lang\(zh\)[^{]*\{\s*--sans:/);
    expect(upstreamLibrary).toMatch(/\[dir="rtl"\]\s*\{\s*--sans:/);
    const perLanguage = rulesWithSelector(':lang(zh), :lang(ko), [dir="rtl"]')[0];
    expect(perLanguage && declarations(perLanguage).get('--sans')).toBe('var(--font-ui)');
  });

  it('defaults the accent to the theme ink (a custom accent is written inline by appearance.ts)', () => {
    expect(main.get('--accent')).toBe('var(--ink)');
    expect(main.get('--accent-contrast')).toBe('var(--paper)');
    expect(main.get('--sans')).toBe('var(--font-ui)');
    expect(main.get('--mono')).toBe('var(--font-mono)');
  });
});
