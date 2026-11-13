// SPDX-License-Identifier: Apache-2.0
// @vitest-environment jsdom
/**
 * Compat shims and the editor store (06 §3.4, §3.5): the shims export every name the vendored
 * files import from the modules they replace, the aliases and tsconfig paths agree, and the
 * store exposes the members and state fields the vendored UI uses.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import { SHIMMED_APP_MODULES, canvasAliases } from '../aliases';
import { FX_STATE_EXTENSION_FIELDS, FX_STORE_EXTENSION_MEMBERS, createFxEditorStore } from '../src/fx/store/create-store';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const vendorRoot = path.join(root, 'src/vendor/open-pencil');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const vendored = walk(vendorRoot).filter((file) => /\.(?:ts|vue)$/.test(file));

interface ImportedName {
  name: string;
  typeOnly: boolean;
  file: string;
}

/** Names the vendored files import from one shimmed module. */
function importsOf(specifier: string): ImportedName[] {
  const escaped = specifier.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s+from\\s+['"]${escaped}['"]`, 'g');
  const names: ImportedName[] = [];
  for (const file of vendored) {
    for (const match of readFileSync(file, 'utf8').matchAll(pattern)) {
      for (const raw of match[2]!.split(',')) {
        const part = raw.trim();
        if (!part) continue;
        const typeOnly = !!match[1] || part.startsWith('type ');
        const name = part.replace(/^type\s+/, '').split(/\s+as\s+/)[0]!.trim();
        names.push({ name, typeOnly, file: path.relative(root, file) });
      }
    }
  }
  return names;
}

function exportedNames(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)) names.add(match[1]!);
  for (const match of source.matchAll(/export\s+(?:type\s+)?\{([^}]*)\}/g)) {
    for (const raw of match[1]!.split(',')) {
      const part = raw.trim().replace(/^type\s+/, '');
      if (part) names.add(part.split(/\s+as\s+/).pop()!.trim());
    }
  }
  return names;
}

describe('compat shims', () => {
  it('cover every app module the vendored files import (and nothing else)', () => {
    const appImports = new Set<string>();
    for (const file of vendored) {
      for (const match of readFileSync(file, 'utf8').matchAll(/from\s+['"](@\/app\/[^'"]+)['"]/g)) appImports.add(match[1]!);
    }
    const vendoredModules = new Set(
      [...appImports].filter((specifier) =>
        ['.ts', '/index.ts'].some((suffix) => {
          try {
            return statSync(path.join(vendorRoot, `${specifier.slice(2)}${suffix}`)).isFile();
          } catch {
            return false;
          }
        }),
      ),
    );
    const shimmed = [...appImports].filter((specifier) => !vendoredModules.has(specifier)).sort();
    expect(shimmed).toEqual(Object.keys(SHIMMED_APP_MODULES).sort());
  });

  it.each(Object.entries(SHIMMED_APP_MODULES))('%s exports what the vendored files import', async (specifier, file) => {
    const source = readFileSync(path.join(root, 'src/fx/compat', file), 'utf8');
    const exported = exportedNames(source);
    const imported = importsOf(specifier);
    expect(imported.length).toBeGreaterThan(0);
    const missing = imported.filter(({ name }) => !exported.has(name)).map(({ name, file: from }) => `${name} (${from})`);
    expect(missing).toEqual([]);
    const module = (await import(/* @vite-ignore */ `../src/fx/compat/${file}`)) as Record<string, unknown>;
    for (const { name, typeOnly } of imported) {
      if (!typeOnly) expect(module[name], name).toBeDefined();
    }
  });

  it('keeps the Vite aliases and the tsconfig paths in step', () => {
    const tsconfig = JSON.parse(readFileSync(path.join(root, 'tsconfig.json'), 'utf8')) as { compilerOptions: { paths: Record<string, string[]> } };
    for (const [specifier, file] of Object.entries(SHIMMED_APP_MODULES)) {
      expect(tsconfig.compilerOptions.paths[specifier]).toEqual([`./src/fx/compat/${file}`]);
    }
    expect(tsconfig.compilerOptions.paths['@/*']).toEqual(['./src/vendor/open-pencil/*']);
    const aliases = canvasAliases(root);
    // Exact shims come before the generic vendor prefix.
    const generic = aliases.findIndex((alias) => alias.find.source === '^@\\/(.*)$');
    expect(generic).toBe(aliases.length - 1);
    for (const [specifier, file] of Object.entries(SHIMMED_APP_MODULES)) {
      const alias = aliases.find((candidate) => candidate.find.test(specifier));
      expect(alias?.replacement).toBe(path.join(root, 'src/fx/compat', file));
      expect(alias?.find.test(`${specifier}/more`)).toBe(false);
    }
    expect(aliases.at(-1)!.replacement).toBe(`${vendorRoot}/$1`);
  });
});

describe('createFxEditorStore', () => {
  const store = createFxEditorStore({ getViewportElement: () => null, downloadFile: () => undefined });

  it('exposes the extension members', () => {
    for (const member of FX_STORE_EXTENSION_MEMBERS) expect(member in store, member).toBe(true);
    expect(store.readOnly.value).toBe(false);
    expect(store.designCheck.snapshot.value).toBeNull();
    expect(store.designCheck.pages.counts.value.size).toBe(0);
  });

  it('keeps the SDK members the vendored UI calls', () => {
    const members = [
      'graph', 'state', 'renderer', 'textEditor', 'requestRepaint', 'requestRender', 'zoomToLevel', 'zoomToFit', 'applyZoom',
      'select', 'clearSelection', 'selectAtPoint', 'screenToCanvas', 'setSelectedGuide', 'removeGuide', 'renameNode', 'storeImage',
      'getImage', 'setShaderPaint', 'getNode', 'setPageColor', 'placeFiles', 'pasteSVG', 'prepareCopy', 'pasteFromHTML',
      'pasteSnapshot', 'deleteSelected', 'replaceGraph', 'undo', 'onEditorEvent', 'switchPage', 'getPages', 'getSelectedNodes',
      'nudgeSelected', 'flushNudge', 'setTool', 'startTextEditing',
    ];
    for (const member of members) expect(member in store, member).toBe(true);
  });

  it('extends the editor state with the Fantay fields', () => {
    for (const field of FX_STATE_EXTENSION_FIELDS) expect(field in store.state, field).toBe(true);
    expect(store.state).toMatchObject({ showRulers: false, numberFieldFocused: false, renameNodeId: null, showRemoteCursors: false, theme: 'dark' });
    for (const field of ['snappingPreferences', 'selectedIds', 'guides', 'currentPageId', 'zoom', 'panX', 'panY', 'sceneVersion']) {
      expect(field in store.state, field).toBe(true);
    }
  });

  it('centres on the viewport and keeps the canvas size it is told', () => {
    store.setViewportSize(800, 600);
    expect(store.viewportScreenCenter()).toEqual({ x: 400, y: 300 });
    store.state.zoom = 2;
    store.state.panX = 0;
    store.state.panY = 0;
    expect(store.viewportCanvasCenter()).toEqual({ x: 200, y: 150 });
  });

  it('warns once about members the vendored UI reads but Fantay lacks (dev builds)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    void (store as unknown as Record<string, unknown>).panes;
    void (store as unknown as Record<string, unknown>).panes;
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toBe('[fantay-design] missing store member panes');
    warn.mockRestore();
  });
});
