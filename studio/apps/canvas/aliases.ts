// SPDX-License-Identifier: Apache-2.0
/**
 * Module aliases shared by vite.config.ts and vitest.config.ts (and mirrored by tsconfig.json
 * `paths`, which tests/store-shim.test.ts keeps in step).
 *
 * The vendored OpenPencil UI (src/vendor/open-pencil, 06 §3.3) imports its app modules through
 * `@/…`. Ten of those app modules are replaced by Fantay shims in src/fx/compat (06 §3.4); every
 * other `@/…` import resolves into the vendored tree. Order matters: the exact shim entries must
 * come before the generic `@/` prefix.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

export interface CanvasAlias {
  find: RegExp;
  replacement: string;
}

/** Upstream app module → shim file in src/fx/compat. */
export const SHIMMED_APP_MODULES = {
  '@/app/editor/active-store': 'active-store.ts',
  '@/app/editor/session': 'session.ts',
  '@/app/editor/fonts': 'fonts.ts',
  '@/app/editor/fonts/cache': 'fonts-cache.ts',
  '@/app/tauri/env': 'tauri-env.ts',
  '@/app/settings/preferences/store': 'preferences-store.ts',
  '@/app/settings/preferences/apply': 'preferences-apply.ts',
  '@/app/editor/design-check/layers': 'design-check-layers.ts',
  '@/app/editor/canvas/menu/actions': 'canvas-menu-actions.ts',
  '@/app/shell/menu/shortcut': 'menu-shortcut.ts',
} as const;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function canvasAliases(root: string): CanvasAlias[] {
  const require = createRequire(path.join(root, 'package.json'));
  const src = path.join(root, 'src');
  const vendor = path.join(src, 'vendor/open-pencil');
  const shim = (file: string) => path.join(src, 'fx/compat', file);
  return [
    // CSSOM's browser field points at a script-global build without ESM exports.
    {
      find: /^@acemir\/cssom$/,
      replacement: require.resolve('@acemir/cssom/lib/index.js', {
        paths: [path.join(root, 'node_modules/@open-pencil/dom-css')],
      }),
    },
    ...Object.entries(SHIMMED_APP_MODULES).map(([specifier, file]) => ({
      find: new RegExp(`^${escapeRegExp(specifier)}$`),
      replacement: shim(file),
    })),
    { find: /^@\/(.*)$/, replacement: `${vendor}/$1` },
  ];
}
