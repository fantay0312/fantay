# Vendored OpenPencil app UI

Do not edit these files. Re-vendor instead.

- Upstream: <https://github.com/open-pencil/open-pencil>, tag `v0.16.0`,
  commit `ffe2fc5798468988a5943c5f5737905c3c7a28b5`.
- Licence: MIT, `Copyright (c) 2026 Danila Poyarkov and OpenPencil contributors`. The full text
  is in `LICENSE` next to this file. The build ships a copy as
  `canvas-editor/licenses/OpenPencil-app-MIT.txt`.
- Matching npm packages: `@open-pencil/core`, `@open-pencil/scene-graph`, `@open-pencil/vue` and
  `@open-pencil/dom-css` at exactly `0.16.0`.

## What is here

The set is the transitive `@/` import closure of the editor roots listed in the design-documents
spec (06 §3.3). The closure stops at the ten app modules that Fantay replaces with shims in
`src/fx/compat/` (the aliases are in `apps/canvas/aliases.ts`). It holds 189 files.

Upstream `src/<path>` is stored as `<path>` here, so upstream `@/…` imports resolve through the
`@/` alias unchanged. No branding, cloud, telemetry, collaboration, AI or app-shell module is
vendored.

## How the files were obtained

Each file was read with `git show v0.16.0:src/<path>` from a read-only clone. No script of the
clone was run. A header was added at the top of each file:

```
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Danila Poyarkov and OpenPencil contributors
Source: https://github.com/open-pencil/open-pencil/blob/v0.16.0/src/<path>
Modified by Fantay: no   (or the patch id and a one-line description)
```

`.ts` files use `//` lines. `.vue` files use an HTML comment.

`MANIFEST.json` lists every file with two hashes:

- `upstreamSha256`: the upstream bytes.
- `vendoredSha256`: the bytes after the header.

For unpatched files the two hashes are equal. `tests/vendor-provenance.test.ts` checks all of
this.

## Patches (the only edits)

| # | File | Edit |
|---|---|---|
| P1 | `theme/button/button.ts` | The filled primary button is ink (`bg-surface text-panel hover:bg-surface/90`) |
| P2 | `theme/overlay.ts` | Both floating surfaces use `shadow-[var(--shadow-pop)]` |
| P3 | `components/toolbar/DesktopToolbar.vue` | The toolbar shadow is `shadow-[var(--shadow-float)]` |
| P4 | `theme/dialog/index.ts` | The dialog shadow is `shadow-[var(--shadow-modal)]` |
| P5 | `components/editor/ZoomDropdown.vue` | Removes the multiplayer cursors, design issues and comments items and their now-unused code |
| P6 | `app/editor/toolbar/layout.ts` | `TOOLBAR_ACTIONS = ['insert-icon', 'place-image'] as const` |

## Re-vendoring (for example for 0.17)

1. Recompute the closure at the new tag.
2. Copy the files with headers, re-apply P1–P6 and regenerate `MANIFEST.json`.
3. Review the shims in `src/fx/compat/` against the new imports.
4. Review the type wrapper `src/fx/engine/open-pencil-vue.d.ts`.
5. Run `pnpm --filter @fantay/canvas typecheck`, `test` and `build`.
