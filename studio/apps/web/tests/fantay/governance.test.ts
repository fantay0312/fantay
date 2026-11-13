// SPDX-License-Identifier: Apache-2.0
// Governance for Fantay sources (plan §4 W1-primitives, spec 01 §6, plan R14/R17, amendments B1/B10).
//
// Under apps/web/src/fantay/**:
//   - outside ui/: no raw <button|select|textarea>, no raw <input> except type="file"/"color",
//     unless the file starts with `// fx-governance-allow-raw: <reason>`;
//   - no `text-[Npx]`, `rounded-[Npx]`, `font-bold|extrabold|black` in .ts/.tsx, no hex colours in .tsx;
//   - no import of @open-design/components;
//   - every source carries an SPDX header (AGPL-3.0-only, or MIT for infinite-canvas/OpenPencil ports);
//   - every ui/ file (except index.ts, fx.tsx, gallery/) starts with 'use client' + the AGPL SPDX header;
//   - ported files name their Doop source; the Doop name never appears outside comments.
// B1: every var(--x) in apps/web/src/fantay/**/*.module.css and apps/canvas/src/fx/**/*.css is defined.
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB_ROOT = resolve(__dirname, '../..');
const REPO_ROOT = resolve(WEB_ROOT, '../..');
const FANTAY_ROOT = join(WEB_ROOT, 'src/fantay');
const CANVAS_SRC = join(REPO_ROOT, 'apps/canvas/src');
const CANVAS_FX_ROOT = join(CANVAS_SRC, 'fx');
const TOKENS_CSS = join(REPO_ROOT, 'packages/fantay-tokens/tokens.css');
const LEGACY_ALIASES_CSS = join(FANTAY_ROOT, 'styles/legacy-aliases.css');
const UPSTREAM_TOKENS_CSS = join(WEB_ROOT, 'src/styles/tokens.css');

const DOOP_COMMIT = 'd261a85d3f9d87ac0653bb8512915f4e5bdff2b9';
const ALLOW_RAW_HEADER = /^\/\/ fx-governance-allow-raw: \S.*$/;
const ALLOWED_SPDX = new Set(['AGPL-3.0-only', 'MIT']);

/** Upstream variables (apps/web/src/styles/tokens.css) a Fantay module may read directly:
 *  the z ladder Fantay's own --z-fx-* steps are aligned with. Every entry must exist upstream. */
const UPSTREAM_ALLOWLIST = ['--z-menu', '--z-hint'] as const;
/** Set at runtime by a library on the element (never declared in a stylesheet). */
const RUNTIME_VARIABLE_PREFIXES = ['--radix-'] as const;

/** ui/ files ported from Doop and the Doop sources each must name (spec 01 §4.5, plan R14). */
const UI_PORT_MAP: Record<string, readonly string[]> = {
  'cn.ts': ['src/lib/utils.ts'],
  'icons.tsx': ['src/components/ui/icons.tsx'],
  'button.tsx': ['src/components/ui/button.tsx'],
  'icon-button.tsx': ['src/components/ui/icon-button.tsx'],
  'toolbar.tsx': ['src/components/ui/toolbar.tsx'],
  'segmented.tsx': ['src/components/ui/segmented.tsx'],
  'tabs.tsx': ['src/components/ui/panel.tsx', 'src/components/ui/tabs.tsx'],
  'menu.tsx': ['src/components/ui/menu.tsx'],
  'dropdown-menu.tsx': ['src/components/ui/dropdown-menu.tsx'],
  'context-menu.tsx': ['src/components/ui/context-menu.tsx'],
  'tooltip.tsx': ['src/components/ui/tooltip.tsx'],
  'kbd.tsx': ['src/components/ui/kbd.tsx'],
  'dialog.tsx': ['src/components/ui/modal.tsx', 'src/components/ui/alert-dialog.tsx'],
  'popover.tsx': ['src/components/ui/popover.tsx'],
  'input.tsx': ['src/components/ui/input.tsx', 'src/components/ui/search-field.tsx'],
  'textarea.tsx': ['src/components/ui/textarea.tsx'],
  'field.tsx': ['src/components/ui/field.tsx'],
  'select.tsx': ['src/components/ui/select.tsx'],
  'switch.tsx': ['src/components/ui/switch.tsx'],
  'checkbox.tsx': ['src/components/ui/checkbox.tsx'],
  'chip.tsx': ['src/components/ui/chip.tsx'],
  'avatar.tsx': ['src/components/ui/avatar.tsx'],
  'panel.tsx': ['src/components/ui/panel.tsx', 'src/components/ui/collapsible.tsx'],
  'spinner.tsx': ['src/components/ui/toast.tsx'],
  'skeleton.tsx': ['src/components/ui/skeleton.tsx'],
  'toast.tsx': ['src/components/ui/toast.tsx'],
  'dot.tsx': ['src/components/ui/dot.tsx'],
  'sheet.tsx': ['src/components/ui/sheet.tsx'],
  'collapsible.tsx': ['src/components/ui/collapsible.tsx'],
  'callout.tsx': ['src/components/ui/callout.tsx'],
  'empty-state.tsx': ['src/components/ui/empty-state.tsx', 'src/components/ui/card.tsx'],
  'tile.tsx': ['src/components/ui/tile.tsx'],
  'status-label.tsx': ['src/components/ui/status-label.tsx'],
  'search-field.tsx': ['src/components/ui/search-field.tsx'],
};

/* ── file helpers ───────────────────────────────────────────────────────────────────────── */

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(full));
    else if (entry.isFile()) files.push(full);
  }
  return files.sort();
}

function repoPath(file: string): string {
  return relative(REPO_ROOT, file).split(sep).join('/');
}

function lineOf(source: string, index: number): number {
  return source.slice(0, index).split('\n').length;
}

/** Removes // and /* *\/ comments outside string and template literals, keeping newlines. */
function stripTsComments(source: string): string {
  type Mode = 'code' | 'line' | 'block' | 'single' | 'double' | 'template';
  let mode: Mode = 'code';
  const stack: Array<'brace' | 'template'> = [];
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] ?? '';
    const next = source[i + 1] ?? '';
    if (mode === 'line') {
      if (c === '\n') {
        mode = 'code';
        out += c;
      }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && next === '/') {
        mode = 'code';
        i += 1;
      } else if (c === '\n') {
        out += c;
      }
      continue;
    }
    if (mode === 'code') {
      if (c === '/' && next === '/') {
        mode = 'line';
        i += 1;
        continue;
      }
      if (c === '/' && next === '*') {
        mode = 'block';
        i += 1;
        continue;
      }
      if (c === "'") mode = 'single';
      else if (c === '"') mode = 'double';
      else if (c === '`') mode = 'template';
      else if (c === '{') stack.push('brace');
      else if (c === '}' && stack.pop() === 'template') mode = 'template';
      out += c;
      continue;
    }
    // inside a string or template literal
    if (c === '\\') {
      out += c + next;
      i += 1;
      continue;
    }
    if ((mode === 'single' && c === "'") || (mode === 'double' && c === '"') || (mode === 'template' && c === '`')) {
      mode = 'code';
    } else if (mode === 'template' && c === '$' && next === '{') {
      stack.push('template');
      mode = 'code';
      out += '${';
      i += 1;
      continue;
    }
    out += c;
  }
  return out;
}

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ''));
}

/** The comment block(s) before the first statement (after an optional 'use client'). */
function leadingComment(source: string): string {
  const match = /^(?:\s*['"]use client['"];?)?((?:\s*(?:\/\*[\s\S]*?\*\/|\/\/[^\n]*))*)/.exec(source);
  return match?.[1] ?? '';
}

/** Reads a JSX opening tag from `<` to its closing `>` (skipping `>` inside braces and quotes). */
function readOpeningTag(source: string, start: number): string {
  let depth = 0;
  let quote: string | null = null;
  for (let i = start + 1; i < source.length; i += 1) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (c === '{') depth += 1;
    else if (c === '}') depth -= 1;
    else if (c === '>' && depth === 0) return source.slice(start, i + 1);
  }
  return source.slice(start);
}

/* ── rules (pure: repository path + source → violations) ────────────────────────────────── */

function rawElementViolations(path: string, source: string): string[] {
  if (!path.endsWith('.tsx') || path.includes('/fantay/ui/')) return [];
  const firstLine = source.split('\n', 1)[0] ?? '';
  if (ALLOW_RAW_HEADER.test(firstLine)) return [];
  const code = stripTsComments(source);
  const violations: string[] = [];
  for (const match of code.matchAll(/<(button|select|textarea)(?=[\s>/])/g)) {
    violations.push(`${path}:${lineOf(code, match.index ?? 0)} raw <${match[1]}> — use the Fantay primitive`);
  }
  for (const match of code.matchAll(/<input(?=[\s>/])/g)) {
    const tag = readOpeningTag(code, match.index ?? 0);
    if (/\btype\s*=\s*(?:\{\s*)?['"](?:file|color)['"]/.test(tag)) continue;
    violations.push(`${path}:${lineOf(code, match.index ?? 0)} raw <input> — use Input/Checkbox (only type="file"/"color" may stay raw)`);
  }
  for (const match of code.matchAll(/createElement\(\s*['"](button|select|textarea|input)['"]/g)) {
    violations.push(`${path}:${lineOf(code, match.index ?? 0)} raw ${match[1]} via createElement`);
  }
  return violations;
}

function classLiteralViolations(path: string, source: string): string[] {
  const ext = extname(path);
  if (ext !== '.ts' && ext !== '.tsx') return [];
  const code = stripTsComments(source);
  const violations: string[] = [];
  const rules: Array<[RegExp, string]> = [
    [/(?<![\w-])text-\[\d+(?:\.\d+)?px\]/g, 'pixel text size — use the text-* type scale'],
    [/(?<![\w-])rounded(?:-(?:t|r|b|l|s|e|tl|tr|bl|br|ss|se|es|ee))?-\[\d+(?:\.\d+)?px\]/g, 'pixel radius — use the rounded-* shapes'],
    [/(?<![\w-])font-(?:bold|extrabold|black)(?![\w-])/g, 'weight above semibold'],
  ];
  if (ext === '.tsx') {
    rules.push([/(?<![&\w])#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g, 'hex colour — use a token']);
  }
  for (const [pattern, message] of rules) {
    for (const match of code.matchAll(pattern)) {
      violations.push(`${path}:${lineOf(code, match.index ?? 0)} \`${match[0]}\` ${message}`);
    }
  }
  return violations;
}

function componentsImportViolations(path: string, source: string): string[] {
  const code = path.endsWith('.css') ? stripCssComments(source) : stripTsComments(source);
  const pattern =
    /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\(\s*|@import\s+(?:url\()?)['"]@open-design\/components(?:\/[^'"]*)?['"]/g;
  return [...code.matchAll(pattern)].map(
    (match) => `${path}:${lineOf(code, match.index ?? 0)} imports @open-design/components (use apps/web/src/fantay/ui)`,
  );
}

function spdxViolations(path: string, source: string): string[] {
  const header = source.split('\n').slice(0, 15).join('\n');
  const match = /SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+(?:\s+(?:AND|OR)\s+[A-Za-z0-9.+-]+)*)/.exec(header);
  if (!match) return [`${path} has no SPDX-License-Identifier header (R17)`];
  const id = (match[1] ?? '').trim();
  return ALLOWED_SPDX.has(id) ? [] : [`${path} SPDX "${id}" — Fantay sources are AGPL-3.0-only (MIT for IC/OpenPencil ports)`];
}

function uiHeaderViolations(path: string, source: string): string[] {
  const inUi = /\/fantay\/ui\//.test(path);
  if (!inUi || /\/fantay\/ui\/(?:index\.ts|fx\.tsx|gallery\/)/.test(path)) return [];
  if (path.endsWith('.css')) {
    return /^\s*\/\*[\s\S]*?SPDX-License-Identifier: AGPL-3\.0-only/.test(source)
      ? []
      : [`${path} must start with the AGPL-3.0-only SPDX header`];
  }
  if (!/\.tsx?$/.test(path)) return [];
  const violations: string[] = [];
  if (!/^['"]use client['"];?\s*(?:\r?\n|$)/.test(source)) violations.push(`${path} must start with 'use client'`);
  if (!/SPDX-License-Identifier: AGPL-3\.0-only/.test(leadingComment(source))) {
    violations.push(`${path} must carry the AGPL-3.0-only SPDX header right after 'use client'`);
  }
  return violations;
}

function doopSourceViolations(path: string, source: string): string[] {
  const header = leadingComment(path.endsWith('.css') ? `${source}` : source) || source.slice(0, 1200);
  if (!/doop/i.test(header)) return [];
  const violations: string[] = [];
  if (!/SPDX-License-Identifier: AGPL-3\.0-only/.test(header)) violations.push(`${path} is derived from Doop but is not AGPL-3.0-only`);
  if (!/\bsrc\/[\w./-]+\.(?:tsx?|css)\b/.test(header)) violations.push(`${path} is derived from Doop but does not name its Doop source path`);
  return violations;
}

function portMapViolations(path: string, source: string, sources: readonly string[]): string[] {
  const header = leadingComment(source);
  return sources
    .filter((doopPath) => !header.includes(`source: ${doopPath} @ ${DOOP_COMMIT}`))
    .map((doopPath) => `${path} must name its Doop source "source: ${doopPath} @ ${DOOP_COMMIT}"`);
}

function doopBrandingViolations(path: string, source: string): string[] {
  const code = path.endsWith('.css') ? stripCssComments(source) : stripTsComments(source);
  return [...code.matchAll(/\bdoop\b/gi)].map(
    (match) => `${path}:${lineOf(code, match.index ?? 0)} the Doop name outside a licence comment (no Doop branding)`,
  );
}

/* ── B1: CSS custom properties ──────────────────────────────────────────────────────────── */

function cssDefinitions(source: string): Set<string> {
  // `@theme` keys are Tailwind theme entries, not emitted custom properties (theme.css is `inline reference`)
  const code = stripCssComments(source).replace(/@theme\b[^{]*\{[^}]*\}/g, '');
  return new Set([...code.matchAll(/(?:^|[\s;{(])(--[A-Za-z0-9_-]+)\s*:/g)].map((match) => match[1] ?? ''));
}

function inlineDefinitions(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/['"](--[A-Za-z0-9_-]+)['"]\s*:/g)) names.add(match[1] ?? '');
  for (const match of source.matchAll(/setProperty\(\s*['"](--[A-Za-z0-9_-]+)['"]/g)) names.add(match[1] ?? '');
  return names;
}

function cssVariableUses(source: string): Array<{ name: string; index: number }> {
  const code = stripCssComments(source);
  return [...code.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)].map((match) => ({ name: match[1] ?? '', index: match.index ?? 0 }));
}

function undefinedVariableViolations(path: string, source: string, defined: ReadonlySet<string>): string[] {
  const local = cssDefinitions(source);
  const code = stripCssComments(source);
  return cssVariableUses(source)
    .filter(({ name }) => !defined.has(name) && !local.has(name) && !RUNTIME_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix)))
    .map(
      ({ name, index }) =>
        `${path}:${lineOf(code, index)} var(${name}) is defined nowhere — use a token from packages/fantay-tokens/tokens.css or legacy-aliases.css (spec 01 names, amendment B1), declare it, or allowlist an upstream token`,
    );
}

function readIfExists(file: string): string {
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

/* ── tree scan ──────────────────────────────────────────────────────────────────────────── */

const FANTAY_FILE_ENTRIES = walk(FANTAY_ROOT)
  .filter((file) => /\.(?:tsx?|css)$/.test(file))
  .map((file) => ({ file, rel: repoPath(file), source: readFileSync(file, 'utf8') }));
const FANTAY_SOURCES = FANTAY_FILE_ENTRIES.map((entry) => entry.file);
const FANTAY_SOURCE_BY_FILE = new Map(FANTAY_FILE_ENTRIES.map((entry) => [entry.file, entry.source]));

/** Every custom property a Fantay web module may read: tokens, legacy aliases, the allowlisted upstream
 *  z steps, and properties Fantay itself declares (any Fantay stylesheet outside @theme, or an inline
 *  `style={{ '--x': … }}` / `setProperty('--x', …)` in Fantay code). */
function webDefinitions(): Set<string> {
  const defined = new Set<string>([...cssDefinitions(readIfExists(TOKENS_CSS)), ...cssDefinitions(readIfExists(LEGACY_ALIASES_CSS))]);
  for (const name of UPSTREAM_ALLOWLIST) defined.add(name);
  for (const { file, source } of FANTAY_FILE_ENTRIES) {
    if (file.endsWith('.css')) for (const name of cssDefinitions(source)) defined.add(name);
    else if (/\.tsx?$/.test(file)) for (const name of inlineDefinitions(source)) defined.add(name);
  }
  return defined;
}

/** The canvas (06) adds its own theme layer (apps/canvas/src/theme/**, R12) and fx-declared properties. */
function canvasDefinitions(): Set<string> {
  const defined = new Set<string>([...cssDefinitions(readIfExists(TOKENS_CSS))]);
  for (const name of UPSTREAM_ALLOWLIST) defined.add(name);
  for (const file of [...walk(join(CANVAS_SRC, 'theme')), ...walk(CANVAS_FX_ROOT)]) {
    const source = readFileSync(file, 'utf8');
    if (file.endsWith('.css')) {
      for (const name of cssDefinitions(source)) defined.add(name);
      for (const block of source.matchAll(/@theme\s+static[^{]*\{([^}]*)\}/g)) {
        for (const name of cssDefinitions(block[1] ?? '')) defined.add(name);
      }
    } else if (/\.(?:tsx?|vue)$/.test(file)) {
      for (const name of inlineDefinitions(source)) defined.add(name);
    }
  }
  return defined;
}

function collect(rule: (path: string, source: string) => string[]): string[] {
  return FANTAY_FILE_ENTRIES.flatMap(({ rel, source }) => rule(rel, source));
}

/* ── self-tests: each rule catches a seeded violation and accepts compliant code ──────── */

describe('governance rules (self-test)', () => {
  const outside = 'apps/web/src/fantay/board/Example.tsx';
  const inside = 'apps/web/src/fantay/ui/example.tsx';

  it('flags raw controls outside ui/ unless allowed', () => {
    expect(rawElementViolations(outside, 'export const A = () => <button onClick={() => 1}>x</button>;')).toHaveLength(1);
    expect(rawElementViolations(outside, 'const A = () => <select><option /></select>;')).toHaveLength(1);
    expect(rawElementViolations(outside, 'const A = () => <textarea />;')).toHaveLength(1);
    expect(rawElementViolations(outside, 'const A = () => <input value={a > b ? 1 : 2} />;')).toHaveLength(1);
    expect(rawElementViolations(outside, "const A = () => <input onChange={(e) => e} type='file' hidden />;")).toEqual([]);
    expect(rawElementViolations(outside, 'const A = () => <input type={"color"} />;')).toEqual([]);
    expect(rawElementViolations(outside, "React.createElement('button')")).toHaveLength(1);
    expect(rawElementViolations(outside, '// a <button> in a comment\nconst A = () => <Button />;')).toEqual([]);
    expect(rawElementViolations(outside, '// fx-governance-allow-raw: native picker\nconst A = () => <select />;')).toEqual([]);
    expect(rawElementViolations(outside, '// fx-governance-allow-raw:\nconst A = () => <select />;')).toHaveLength(1);
    expect(rawElementViolations(inside, 'const A = () => <button />;')).toEqual([]);
  });

  it('flags pixel type/radius, heavy weights and tsx hex colours', () => {
    expect(classLiteralViolations(outside, "cn('text-[13px] md:rounded-[6px]', 'font-bold')")).toHaveLength(3);
    expect(classLiteralViolations(outside, "const c = 'rounded-tl-[4px] text-body rounded-card font-semibold';")).toHaveLength(1);
    expect(classLiteralViolations(outside, "<div style={{ color: '#fff', background: '#1a1a1aff' }} />")).toHaveLength(2);
    expect(classLiteralViolations('apps/web/src/fantay/x.ts', "const accent = '#353535';")).toEqual([]);
    expect(classLiteralViolations(outside, '<a href="#docs">x</a>; const e = "&#8203;"; // #fff')).toEqual([]);
    expect(classLiteralViolations(outside, "cn('size-[18px] text-[length:inherit] font-black-ish')")).toEqual([]);
  });

  it('flags @open-design/components imports in any form', () => {
    expect(componentsImportViolations(outside, "import { Button } from '@open-design/components';")).toHaveLength(1);
    expect(componentsImportViolations(outside, "import '@open-design/components/styles.css';")).toHaveLength(1);
    expect(componentsImportViolations(outside, "const m = await import('@open-design/components');")).toHaveLength(1);
    expect(componentsImportViolations('apps/web/src/fantay/x.module.css', "@import '@open-design/components/x.css';")).toHaveLength(1);
    expect(componentsImportViolations(outside, "import { Button } from '../ui/button';")).toEqual([]);
  });

  it('requires an allowed SPDX header and the ui/ client header', () => {
    expect(spdxViolations(outside, '/* SPDX-License-Identifier: AGPL-3.0-only */\nexport {};')).toEqual([]);
    expect(spdxViolations(outside, '// SPDX-License-Identifier: MIT\nexport {};')).toEqual([]);
    expect(spdxViolations(outside, '// SPDX-License-Identifier: Apache-2.0\nexport {};')).toHaveLength(1);
    expect(spdxViolations(outside, 'export {};')).toHaveLength(1);
    expect(uiHeaderViolations(inside, "'use client';\n/* SPDX-License-Identifier: AGPL-3.0-only */\nexport {};")).toEqual([]);
    expect(uiHeaderViolations(inside, "/* SPDX-License-Identifier: AGPL-3.0-only */\n'use client';\nexport {};")).toHaveLength(1);
    expect(uiHeaderViolations(inside, "'use client';\nexport {};")).toHaveLength(1);
    expect(uiHeaderViolations('apps/web/src/fantay/ui/index.ts', 'export * from "./x";')).toEqual([]);
    expect(uiHeaderViolations('apps/web/src/fantay/ui/gallery/Gallery.tsx', 'export {};')).toEqual([]);
    expect(uiHeaderViolations('apps/web/src/fantay/ui/x.module.css', '.a { color: red; }')).toHaveLength(1);
  });

  it('requires Doop ports to be AGPL and to name their source; no Doop name outside comments', () => {
    const port = `'use client';\n/*\n * SPDX-License-Identifier: AGPL-3.0-only\n * Fantay — derived from Doop\n *   source: src/components/ui/chip.tsx @ ${DOOP_COMMIT}\n */\nexport {};`;
    expect(doopSourceViolations(inside, port)).toEqual([]);
    expect(portMapViolations(inside, port, ['src/components/ui/chip.tsx'])).toEqual([]);
    expect(portMapViolations(inside, port, ['src/components/ui/button.tsx'])).toHaveLength(1);
    expect(doopSourceViolations(inside, "'use client';\n/* SPDX-License-Identifier: AGPL-3.0-only\n * ported from Doop */")).toHaveLength(1);
    expect(doopSourceViolations(inside, "'use client';\n/* SPDX-License-Identifier: MIT\n * Doop src/components/ui/x.tsx */")).toHaveLength(1);
    expect(doopBrandingViolations(inside, `${port}\nconst title = 'Doop UI';`)).toHaveLength(1);
    expect(doopBrandingViolations(inside, port)).toEqual([]);
  });

  it('B1: flags custom properties defined nowhere, accepts tokens, local, inline and runtime ones', () => {
    const defined = new Set(['--paper', '--z-menu']);
    const css = [
      '.a { color: var(--paper); z-index: var(--z-menu); }',
      '.b { --local-gap: 4px; gap: var(--local-gap); max-height: var(--radix-popover-content-available-height); }',
      '/* var(--in-comment) */',
      '.c { font: var(--text-lead); width: var(--fx-missing, 10px); }',
    ].join('\n');
    const violations = undefinedVariableViolations('apps/web/src/fantay/x.module.css', css, defined);
    expect(violations).toHaveLength(2);
    expect(violations[0]).toContain('var(--text-lead)');
    expect(violations[1]).toContain('var(--fx-missing)');
    expect(cssDefinitions('@theme inline reference { --color-paper: var(--paper); }\n:root { --paper: #fff; }')).toEqual(new Set(['--paper']));
    expect(inlineDefinitions("<div style={{ '--inv-zoom': 1 }} />; el.style.setProperty('--zoom', '2');")).toEqual(
      new Set(['--inv-zoom', '--zoom']),
    );
  });
});

/* ── the current tree ───────────────────────────────────────────────────────────────────── */

describe('apps/web/src/fantay/** governance', () => {
  it('finds the Fantay sources', () => {
    expect(FANTAY_SOURCES.some((file) => file.endsWith(`${sep}ui${sep}button.tsx`))).toBe(true);
  });

  it('uses primitives instead of raw controls outside ui/', () => {
    expect(collect(rawElementViolations)).toEqual([]);
  });

  it('uses the type, radius and colour tokens', () => {
    expect(collect(classLiteralViolations)).toEqual([]);
  });

  it('never imports @open-design/components', () => {
    expect(collect(componentsImportViolations)).toEqual([]);
  });

  it('carries SPDX headers (R17/B10)', () => {
    expect(collect(spdxViolations)).toEqual([]);
  });

  it("starts every ui/ file with 'use client' and the AGPL header", () => {
    expect(collect(uiHeaderViolations)).toEqual([]);
  });

  it('names the Doop source of every port and keeps the Doop name out of code', () => {
    expect(collect(doopSourceViolations)).toEqual([]);
    expect(collect(doopBrandingViolations)).toEqual([]);
    const violations = Object.entries(UI_PORT_MAP).flatMap(([file, sources]) => {
      const full = join(FANTAY_ROOT, 'ui', file);
      const source = FANTAY_SOURCE_BY_FILE.get(full);
      if (source === undefined) return [`apps/web/src/fantay/ui/${file} is missing (UI_PORT_MAP)`];
      return portMapViolations(repoPath(full), source, sources);
    });
    expect(violations).toEqual([]);
  });
});

describe('B1 — CSS custom properties are defined', () => {
  it('keeps the upstream allowlist real (each entry exists in apps/web/src/styles/tokens.css)', () => {
    const upstream = cssDefinitions(readFileSync(UPSTREAM_TOKENS_CSS, 'utf8'));
    expect(UPSTREAM_ALLOWLIST.filter((name) => !upstream.has(name))).toEqual([]);
  });

  it('every var(--x) in apps/web/src/fantay/**/*.module.css is defined', () => {
    const modules = FANTAY_FILE_ENTRIES.filter((entry) => entry.file.endsWith('.module.css'));
    if (modules.length > 0) {
      expect(existsSync(TOKENS_CSS), 'packages/fantay-tokens/tokens.css is missing').toBe(true);
      expect(existsSync(LEGACY_ALIASES_CSS), 'apps/web/src/fantay/styles/legacy-aliases.css is missing').toBe(true);
    }
    const defined = webDefinitions();
    const violations = modules.flatMap(({ rel, source }) =>
      undefinedVariableViolations(rel, source, defined),
    );
    expect(violations).toEqual([]);
  });

  it('every var(--x) in apps/canvas/src/fx/**/*.css is defined', () => {
    const sheets = walk(CANVAS_FX_ROOT).filter((file) => file.endsWith('.css'));
    const defined = canvasDefinitions();
    const violations = sheets.flatMap((file) =>
      undefinedVariableViolations(repoPath(file), readFileSync(file, 'utf8'), defined),
    );
    expect(violations).toEqual([]);
  });
});
