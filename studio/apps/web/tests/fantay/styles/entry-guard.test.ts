/* SPDX-License-Identifier: Apache-2.0 */
/**
 * One global CSS entry (01 §2.3–§2.4): app/layout.tsx imports only src/fantay/styles/app.css, which owns the
 * cascade layers. Shipped plan: A (Excalidraw CSS layered inside app.css). If the Excalidraw-only fallback or
 * Plan B ever ships, update this guard together with app.css and FANTAY.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const LAYOUT = resolve(WEB_ROOT, 'app/layout.tsx');
const ENTRY_SPECIFIER = '../src/fantay/styles/app.css';
const SKIPPED_DIRECTORIES = new Set(['node_modules', '.next', 'out', 'dist']);

/** `import 'x.css'`, `import x from 'x.css'`, `import('x.css')` specifiers in a TS source. */
function cssImports(source: string): string[] {
  const pattern = /(?:\bimport\s+(?:[^'";]*?\bfrom\s+)?|\bimport\s*\(\s*)['"]([^'"]+\.css)['"]/g;
  return [...source.matchAll(pattern)].map((match) => match[1] ?? '');
}

function isModuleCss(specifier: string): boolean {
  return /\.module\.css$/.test(specifier);
}

function walk(directory: string, extensions: readonly string[]): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRECTORIES.has(entry.name)) files.push(...walk(join(directory, entry.name), extensions));
    } else if (extensions.some((extension) => entry.name.endsWith(extension))) {
      files.push(join(directory, entry.name));
    }
  }
  return files;
}

const SOURCE_DIRECTORIES = [resolve(WEB_ROOT, 'src'), resolve(WEB_ROOT, 'app')];

/**
 * The vendored Stageshow kit (src/vendor/stageshow, MIT, kept close to upstream so an update can be redone by
 * hand) ships one plain stylesheet per component, imported by that component and wrapped in its own
 * `@layer stageshow`; the Fantay demos built on it (src/fantay/stageshow) follow the kit with sibling sheets
 * scoped under their own class prefixes. Only those sibling imports are exempt.
 */
const STAGESHOW_DIRECTORIES = [resolve(WEB_ROOT, 'src/vendor/stageshow'), resolve(WEB_ROOT, 'src/fantay/stageshow')];

function isStageshowSiblingSheet(file: string, specifier: string): boolean {
  return (
    STAGESHOW_DIRECTORIES.some((directory) => file.startsWith(`${directory}${sep}`)) &&
    /^\.\/[^/]+\.css$/.test(specifier)
  );
}

describe('global CSS entry guard', () => {
  it('app/layout.tsx imports exactly one global stylesheet: the Fantay entry', () => {
    const globals = cssImports(readFileSync(LAYOUT, 'utf8')).filter((specifier) => !isModuleCss(specifier));
    expect(globals).toEqual([ENTRY_SPECIFIER]);
  });

  it('app/layout.tsx no longer imports the Excalidraw stylesheet directly (Plan A)', () => {
    expect(readFileSync(LAYOUT, 'utf8')).not.toContain('@excalidraw/excalidraw/index.css');
  });

  it('no other web source imports a global (non-module) stylesheet', () => {
    const offenders: string[] = [];
    for (const file of SOURCE_DIRECTORIES.flatMap((directory) => walk(directory, ['.ts', '.tsx']))) {
      if (file === LAYOUT) continue;
      for (const specifier of cssImports(readFileSync(file, 'utf8'))) {
        if (!isModuleCss(specifier) && !isStageshowSiblingSheet(file, specifier)) {
          offenders.push(`${relative(WEB_ROOT, file)} → ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('keeps src/index.css import-only and unlayered (app.css layers it as one unit)', () => {
    const source = readFileSync(resolve(WEB_ROOT, 'src/index.css'), 'utf8');
    expect(source).not.toContain('layer(');
  });

  it('never imports Tailwind theme, preflight or the bare tailwindcss bundle', () => {
    const forbidden = /@import\s+(?:url\()?\s*['"]tailwindcss(?:\/(?:theme|preflight)(?:\.css)?)?['"]/;
    const offenders: string[] = [];
    for (const file of SOURCE_DIRECTORIES.flatMap((directory) => walk(directory, ['.css']))) {
      if (forbidden.test(readFileSync(file, 'utf8'))) offenders.push(relative(WEB_ROOT, file));
    }
    for (const file of SOURCE_DIRECTORIES.flatMap((directory) => walk(directory, ['.ts', '.tsx']))) {
      const specifiers = cssImports(readFileSync(file, 'utf8'));
      if (specifiers.some((specifier) => /^tailwindcss(?:\/(?:theme|preflight)\.css)?$/.test(specifier))) {
        offenders.push(relative(WEB_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('declares the layer order once, before any import, in the entry', () => {
    const entry = readFileSync(resolve(WEB_ROOT, 'src/fantay/styles/app.css'), 'utf8');
    const statements = entry.match(/^@layer [^;{]+;/gm) ?? [];
    expect(statements).toEqual(['@layer legacy, legacy-fixes, theme, base, components, utilities;']);
    expect(entry.indexOf(statements[0] ?? '')).toBeLessThan(entry.indexOf('@import'));
    // String imports only: Tailwind skips url() imports and Turbopack cannot layer them.
    expect(entry).not.toMatch(/@import\s+url\(/);
  });
});
