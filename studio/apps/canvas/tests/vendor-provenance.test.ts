// SPDX-License-Identifier: Apache-2.0
/**
 * Vendored OpenPencil UI (06 §3.3): every file carries the MIT provenance header, appears in
 * MANIFEST.json, and is byte-identical to upstream v0.16.0 after its header — except the six
 * patched files P1–P6, whose bodies match their recorded post-patch hashes. No vendored file
 * shows the OpenPencil name outside the header and the two allowed internal identifiers.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'src/vendor/open-pencil');
const TAG = 'v0.16.0';
const COMMIT = 'ffe2fc5798468988a5943c5f5737905c3c7a28b5';
const COPYRIGHT = 'SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors';
const PATCHES: Record<string, string> = {
  P1: 'theme/button/button.ts',
  P2: 'theme/overlay.ts',
  P3: 'components/toolbar/DesktopToolbar.vue',
  P4: 'theme/dialog/index.ts',
  P5: 'components/editor/ZoomDropdown.vue',
  P6: 'app/editor/toolbar/layout.ts',
};

interface ManifestEntry {
  path: string;
  upstreamSha256: string;
  vendoredSha256: string;
  patch: string | null;
}

const manifest = JSON.parse(readFileSync(path.join(vendorRoot, 'MANIFEST.json'), 'utf8')) as {
  upstream: string;
  tag: string;
  commit: string;
  license: string;
  files: ManifestEntry[];
};

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const vendored = walk(vendorRoot)
  .map((file) => path.relative(vendorRoot, file).split(path.sep).join('/'))
  .filter((file) => /\.(?:ts|vue)$/.test(file))
  .sort();

/** Splits a vendored file into its provenance header lines and the upstream body. */
function splitHeader(file: string, text: string): { header: string[]; body: string } {
  if (file.endsWith('.vue')) {
    const match = /^<!--\n((?: {2}.*\n){4})-->\n/.exec(text);
    if (!match) throw new Error(`${file}: missing the vendored header`);
    return { header: match[1]!.trimEnd().split('\n').map((line) => line.trim()), body: text.slice(match[0].length) };
  }
  const match = /^((?:\/\/ .*\n){4})/.exec(text);
  if (!match) throw new Error(`${file}: missing the vendored header`);
  return { header: match[1]!.trimEnd().split('\n').map((line) => line.replace(/^\/\/ /, '')), body: text.slice(match[0].length) };
}

const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

describe('vendored OpenPencil UI', () => {
  it('records the upstream tag, commit and licence', () => {
    expect(manifest).toMatchObject({ upstream: 'https://github.com/open-pencil/open-pencil', tag: TAG, commit: COMMIT, license: 'MIT' });
    expect(readFileSync(path.join(vendorRoot, 'LICENSE'), 'utf8')).toContain('Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors');
    expect(existsSync(path.join(vendorRoot, 'README.md'))).toBe(true);
  });

  it('lists exactly the vendored files (the 189-file closure of 06 §3.3)', () => {
    expect(manifest.files.map((entry) => entry.path).sort()).toEqual(vendored);
    expect(vendored).toHaveLength(189);
  });

  it.each(vendored)('%s carries the MIT header and its upstream bytes', (file) => {
    const entry = manifest.files.find((candidate) => candidate.path === file)!;
    const { header, body } = splitHeader(file, readFileSync(path.join(vendorRoot, file), 'utf8'));
    expect(header[0]).toBe('SPDX-License-Identifier: MIT');
    expect(header[1]).toBe(COPYRIGHT);
    expect(header[2]).toBe(`Source: https://github.com/open-pencil/open-pencil/blob/${TAG}/src/${file}`);
    expect(header[3]).toMatch(/^Modified by Fantay: /);
    const modified = header[3]!.slice('Modified by Fantay: '.length);
    expect(sha256(body)).toBe(entry.vendoredSha256);
    if (entry.patch === null) {
      expect(modified).toBe('no');
      expect(entry.vendoredSha256).toBe(entry.upstreamSha256);
    } else {
      expect(PATCHES[entry.patch]).toBe(file);
      expect(modified.startsWith(`${entry.patch} - `)).toBe(true);
      expect(entry.vendoredSha256).not.toBe(entry.upstreamSha256);
    }
  });

  it('patches exactly P1–P6', () => {
    const patched = Object.fromEntries(manifest.files.filter((entry) => entry.patch).map((entry) => [entry.patch, entry.path]));
    expect(patched).toEqual(PATCHES);
  });

  it('applies the patch edits', () => {
    const read = (file: string) => readFileSync(path.join(vendorRoot, file), 'utf8');
    expect(read(PATCHES.P1!)).toContain("class: { base: 'bg-surface text-panel hover:bg-surface/90' }");
    expect(read(PATCHES.P1!)).not.toContain('bg-primary text-on-primary');
    expect(read(PATCHES.P2!).match(/shadow-\[var\(--shadow-pop\)\]/g)).toHaveLength(2);
    expect(read(PATCHES.P3!)).toContain('shadow-[var(--shadow-float)]');
    expect(read(PATCHES.P4!)).toContain('shadow-[var(--shadow-modal)]');
    const zoom = read(PATCHES.P5!);
    for (const removed of ['toggleRemoteCursors', 'setCommentsOnCanvas', 'setDesignIssuesOnCanvas', 'appPreferences', 'multiplayerCursors', 'designIssues', 'view-comments']) {
      expect(zoom).not.toContain(removed);
    }
    expect(read(PATCHES.P6!)).toContain("export const TOOLBAR_ACTIONS = ['insert-icon', 'place-image'] as const");
  });

  it('shows no OpenPencil branding outside headers and allowed internal identifiers', () => {
    // 06 §3.3: the tooltip claim event name and an internal error prefix are not user-visible branding.
    const allowed = ['open-pencil:tooltip-claim', '[open-pencil] Invalid layer tree item'];
    for (const file of vendored) {
      const { body } = splitHeader(file, readFileSync(path.join(vendorRoot, file), 'utf8'));
      const stripped = allowed.reduce((text, identifier) => text.replaceAll(identifier, ''), body).replace(/@open-pencil\//g, '');
      expect(stripped, file).not.toMatch(/open-?pencil/i);
    }
  });
});
