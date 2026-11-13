# Canvas dependencies and interchange

The design editor (`apps/canvas`) is built into `apps/web/public/canvas-editor`. That build
copies the licence of every bundled package into `canvas-editor/licenses/`. The copy step is
in `vite.config.ts`.

## OpenPencil

- **Engine.** `@open-pencil/core`, `@open-pencil/scene-graph`, `@open-pencil/vue` and
  `@open-pencil/dom-css` 0.16.0 — MIT, "Copyright (c) 2026 Danila Poyarkov and OpenPencil
  contributors". Source: <https://github.com/open-pencil/open-pencil>.
- **Vendored editor UI.** Copied from tag `v0.16.0`, commit
  `ffe2fc5798468988a5943c5f5737905c3c7a28b5`, into `src/vendor/open-pencil/` (189 files) — MIT.
  - `MANIFEST.json` lists each file with its upstream and vendored sha256.
  - Every file carries an SPDX header and its `Source:` URL.
  - The only edits are patches P1–P6. `src/vendor/open-pencil/README.md` lists them.
  - The licence text is `src/vendor/open-pencil/LICENSE`. It ships as
    `licenses/OpenPencil-app-MIT.txt`.
  - Upstream's Apache-2.0 cloud code is not used.
  - No OpenPencil branding is shown. The internal identifiers `open-pencil:tooltip-claim` and
    `[open-pencil] …` stay.
- **Files derived from the same tag.** These carry the MIT header with both copyright lines:
  - `src/fx/editor/FxCanvasStage.vue`, from `src/components/EditorCanvas.vue`
  - `src/fx/editor/FxToolbar.vue`, from `src/components/toolbar/Toolbar.vue`
  - `src/fx/editor/FxPagesPanel.vue`, from `src/components/PagesPanel.vue`
  - `src/fx/editor/FxDesignPanel.vue`, from `src/components/DesignPanel.vue`
  - `src/fx/editor/tool-labels.ts`, from `src/components/toolbar/labels.ts`
  - `src/fx/editor/export.ts`, from `src/app/document/export/{create,files}.ts`
  - `src/fx/editor/document.ts`, from `src/app/document/io/{imported-document,source}.ts`
  - `src/fx/editor/clipboard.ts`, from `src/app/editor/clipboard/**` and
    `src/app/shell/keyboard/clipboard.ts`
  - `src/theme/op-theme.css`: the custom variants and scrollbar utilities of
    `src/theme/tokens.css`. The theme values are Fantay's.

## Other runtime packages

- **ZSeven-W/openpencil `@zseven-w/op-web-sdk` 0.8.0** — MIT. This is the read-only `.op`
  viewer. Source: <https://github.com/ZSeven-W/openpencil>. The package ships no licence file,
  so the committed copy is `licenses/OpenPencil-ZSeven-MIT.txt`.
- **Bundled MIT packages**:
  - `reka-ui` 2.11.0
  - `@floating-ui/vue` 1.1.11 (with `vue-demi`)
  - `@vueuse/core` 14.4.0
  - `tailwind-variants` 3.3.1
  - `tailwind-merge` 3.7.0
  - `es-toolkit` 1.53.0
  - `fflate` 0.8.3
  - Vue 3.5.44
  - Tailwind CSS 4.3.3 (generated CSS)
  - `tw-animate-css` 1.4.0 (CSS)
- **Lucide icons**, through `@iconify-json/lucide` 1.2.144 — ISC, "Copyright (c) 2026 Lucide
  Icons and Contributors". Part of the set comes from Feather, under the MIT licence
  (Copyright (c) 2013-present Cole Bemis).
  - The licence is `licenses/Lucide-ISC.txt`. It is a verbatim copy of the `lucide-react@1.16.0`
    LICENSE, because `@iconify-json/lucide` ships no licence file.
  - The editor draws the icons with a 1.5 stroke (`icons.ts`).
- **CanvasKit 0.41.1** — BSD-3-Clause, with the Skia third-party notices.
- **Fonts**:
  - Inter, distributed by OpenPencil — OFL-1.1, see `licenses/Inter-OFL.txt`.
  - Noto Sans CJK SC Regular, bundled for offline Chinese canvas text — OFL-1.1. Source:
    `notofonts/noto-cjk`, `Sans/OTF/SimplifiedChinese/NotoSansCJKsc-Regular.otf`. See
    `licenses/NotoSansCJK-OFL.txt`.
  - Noto Naskh Arabic — OFL-1.1, see `licenses/NotoNaskhArabic-OFL.txt`.

The editor imports its colours from the shared Fantay tokens (`@fantay/tokens`, AGPL-3.0-only,
Fantay's own package). `src/theme/op-theme.css` maps OpenPencil's theme variables onto those
tokens.

## Interchange

Penpot SVG interchange and Doop canvas JSON (HTML frames) are format adapters in Fantay. Their
complete applications are not bundled here. Penpot's source is MPL-2.0 and Doop's source is
AGPL-3.0. Any later source integration must keep the applicable upstream notices and source
offers. The `.penpot` adapter is a disabled hook for a later phase.

This file records dependencies and boundaries. It is not a legal compatibility opinion.
