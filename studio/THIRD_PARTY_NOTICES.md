# Third-party notices

This file records third-party code, data and assets that Fantaydesign derives from or bundles, with
their licences. Canvas-specific dependencies (OpenPencil, CanvasKit, Noto, Inter files shipped by
OpenPencil) are listed in [`apps/canvas/THIRD_PARTY.md`](apps/canvas/THIRD_PARTY.md).

## Licensing of this distribution (GNU AGPL v3)

- Files inherited from upstream Open Design stay under the Apache License 2.0 (see [`LICENSE`](LICENSE)).
- Files derived from Doop (listed below) are licensed under the GNU Affero General Public License v3.0
  only (`SPDX-License-Identifier: AGPL-3.0-only`); the full text is in
  [`licenses/doop-AGPL-3.0.txt`](licenses/doop-AGPL-3.0.txt). Fantaydesign-original files under
  `apps/web/src/fantay/**` and `packages/fantay-tokens/**` carry the same identifier.
- Because the program includes AGPL-3.0-only code, the combined Fantaydesign distribution is offered
  under AGPL-3.0-only. Each source file states its own licence in its SPDX header.
- **Source offer (AGPL §13).** Users who interact with a modified version of Fantaydesign over a
  network are entitled to its Corresponding Source. The complete source of this distribution is
  available at: `<public Fantaydesign repository URL — fill in when published>`.

## DS Bot IM

- Source: [DS Bot at a66cc737](https://github.com/Fei2411/DS-Bot/tree/a66cc737cfb6c3d8a2597e748cded6cab1206dd3/ds-bot/src/host/im).
- Copyright 2026 Fei2411 and the DS Bot contributors. License: Apache 2.0.
- Fantay uses the DingTalk, Discord, QQ, Slack, Telegram and WeCom protocol adapters and their formatting and retry helpers. The adapters are adapted for Fantay's authorization, receipt and delivery rules.
- [Upstream notices](licenses/ds-bot-im-NOTICE.txt), including the MIT-attributed protocol implementations, are retained.
- The WeCom adapter also follows the [WeCom Team SDK protocol](https://github.com/WecomTeam/aibot-node-sdk), published as MIT.

## Personal Agent channel documents, audio and views

- [PDF.js](https://github.com/mozilla/pdf.js) (`pdfjs-dist@6.5.438`, Apache-2.0) reads attached PDF text and renders images from scanned pages.
- [yauzl](https://github.com/thejoshwolfe/yauzl) (MIT) and [saxes](https://github.com/lddubeau/saxes) (ISC) read Office archives and XML without extracting files into the workspace.
- [silk-wasm](https://www.npmjs.com/package/silk-wasm/v/3.7.1) (MIT) decodes WeChat SILK audio for local transcription.
- [Deep View](https://github.com/Fei2411/deep-view) (`deep-view@0.1.2`, Apache-2.0) validates and displays declarative cards using its standalone core and React entries.

## Fantay Memory: local models and distiller rules

- [onnxruntime-node](https://github.com/microsoft/onnxruntime) (`onnxruntime-node@1.21.1`, MIT, Copyright Microsoft Corporation) runs the local memory models on the CPU (`apps/daemon/src/services/memory/local-models.ts`). The same version was already shipped through `hyperframes`.
- [Tokenizers.js](https://github.com/huggingface/tokenizers.js) (`@huggingface/tokenizers@0.2.0`, Apache-2.0, Copyright Hugging Face) tokenizes text for those models.
- The models are not bundled; the app downloads them on request into the daemon data folder and verifies each file's sha256:
  - [Qwen3-Embedding-0.6B](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B) (Apache-2.0, Alibaba Qwen team), int8 ONNX export [`onnx-community/Qwen3-Embedding-0.6B-ONNX`](https://huggingface.co/onnx-community/Qwen3-Embedding-0.6B-ONNX) at revision `c25a394dd583836952667c12f008335071b3f43d`.
  - [gte-multilingual-reranker-base](https://huggingface.co/Alibaba-NLP/gte-multilingual-reranker-base) (Apache-2.0, Alibaba-NLP), int8 ONNX export [`onnx-community/gte-multilingual-reranker-base`](https://huggingface.co/onnx-community/gte-multilingual-reranker-base) at revision `ee64367e35a2db0da46bb6497e13a18f8bd585cb`.
- The memory distiller's rules for checking memories against the transcript, keeping exact identifiers and values, plain present-tense wording, never copying secrets or instructions, and marking disagreements as `CONFLICT` instead of guessing (`apps/daemon/src/services/memory/distill.ts`) are adapted from the memory analyzer and organizer prompts of [anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks) (`managed_agents/example_data/memory_distill/prompts/analyzer_system.md`, `organizer_system.md`). MIT License, Copyright (c) 2023 Anthropic.

## pi

- Runtime: pi 1.5.0 (`@earendil-works/pi-coding-agent`), the official standalone release from
  <https://github.com/earendil-works/pi/releases/tag/v1.5.0>, pinned by archive sha256 in
  `tools/pack/resources/pi-runtime.json`.
- Copyright (c) 2025 Mario Zechner.
- License: MIT; the full notice is included in `licenses/pi-MIT.txt`.
- The executable and its adjacent runtime files (the release archive's `pi/` directory) are packaged
  under `bin/libexec/pi`.

## dsh-media-desk (自媒体工作台)

- Source: <https://github.com/woniuniuniu/dsh-media-desk> (v2.7.0), the DeepSeek Harness creator-desk plugin.
- Copyright (c) 2026 woniuniuniu (蜗牛的科技笔记).
- License: MIT; the full notice is included in `licenses/dsh-media-desk-MIT.txt`.
- Fantay's 工作台 is adapted from it: the daemon domain under `apps/daemon/src/workbench/` and
  `apps/daemon/src/routes/workbench.ts` (state store, ops, prompts, production pipeline, style presets,
  sample data), the bundled sample images/videos in `assets/workbench/` (drawn by the original author's
  generator script), and the renderer under `apps/web/src/fantay/workbench/`.
  Model calls, image generation and social-account import were rewritten for TokenToSea; Monid is not used.
  Ported files carry a header naming the original.

## Doop

- Project: Doop — <https://github.com/kgoedecke/doop>
- Revision used: `d261a85d3f9d87ac0653bb8512915f4e5bdff2b9`
- Copyright (c) the Doop contributors.
- Licence: GNU Affero General Public License v3.0 (no "or later" grant), copied verbatim to
  [`licenses/doop-AGPL-3.0.txt`](licenses/doop-AGPL-3.0.txt).
- Trademark: per Doop's README ("License"), the Doop name and logo are trademarks and are not covered
  by the code licence. Fantaydesign does not use the Doop name, logo or wordmark to brand anything;
  the name appears only in licence headers and in this notice.
- Every derived file starts with an `AGPL-3.0-only` SPDX header that names its Doop source path and
  revision and summarises the Fantaydesign modifications.

Derived files (paths in this repository → source paths in Doop at the revision above):

| File | Doop source |
|---|---|
| `apps/web/src/fantay/ui/cn.ts` | `src/lib/utils.ts` |
| `apps/web/src/fantay/ui/icons.tsx` | `src/components/ui/icons.tsx` (icon wrapper) |
| `apps/web/src/fantay/ui/button.tsx` | `src/components/ui/button.tsx` |
| `apps/web/src/fantay/ui/icon-button.tsx` | `src/components/ui/icon-button.tsx` |
| `apps/web/src/fantay/ui/toolbar.tsx` | `src/components/ui/toolbar.tsx` |
| `apps/web/src/fantay/ui/segmented.tsx` | `src/components/ui/segmented.tsx` |
| `apps/web/src/fantay/ui/tabs.tsx` | `src/components/ui/panel.tsx` (tab parts), `src/components/ui/tabs.tsx` |
| `apps/web/src/fantay/ui/menu.tsx` | `src/components/ui/menu.tsx` |
| `apps/web/src/fantay/ui/dropdown-menu.tsx` | `src/components/ui/dropdown-menu.tsx` |
| `apps/web/src/fantay/ui/context-menu.tsx` | `src/components/ui/context-menu.tsx` |
| `apps/web/src/fantay/ui/tooltip.tsx` | `src/components/ui/tooltip.tsx` |
| `apps/web/src/fantay/ui/kbd.tsx` | `src/components/ui/kbd.tsx` |
| `apps/web/src/fantay/ui/dialog.tsx` | `src/components/ui/modal.tsx`, `src/components/ui/alert-dialog.tsx` |
| `apps/web/src/fantay/ui/popover.tsx` | `src/components/ui/popover.tsx` |
| `apps/web/src/fantay/ui/input.tsx` | `src/components/ui/input.tsx`, `src/components/ui/search-field.tsx` |
| `apps/web/src/fantay/ui/textarea.tsx` | `src/components/ui/textarea.tsx` |
| `apps/web/src/fantay/ui/field.tsx` | `src/components/ui/field.tsx` |
| `apps/web/src/fantay/ui/select.tsx` | `src/components/ui/select.tsx` |
| `apps/web/src/fantay/ui/switch.tsx` | `src/components/ui/switch.tsx` |
| `apps/web/src/fantay/ui/checkbox.tsx` | `src/components/ui/checkbox.tsx` |
| `apps/web/src/fantay/ui/chip.tsx` | `src/components/ui/chip.tsx` |
| `apps/web/src/fantay/ui/avatar.tsx` | `src/components/ui/avatar.tsx` |
| `apps/web/src/fantay/ui/panel.tsx` | `src/components/ui/panel.tsx`, `src/components/ui/collapsible.tsx` |
| `apps/web/src/fantay/ui/spinner.tsx` | `src/components/ui/toast.tsx` (spinner recipe) |
| `apps/web/src/fantay/ui/skeleton.tsx` | `src/components/ui/skeleton.tsx` |
| `apps/web/src/fantay/ui/toast.tsx` | `src/components/ui/toast.tsx` |
| `apps/web/src/fantay/ui/dot.tsx` | `src/components/ui/dot.tsx` |
| `apps/web/src/fantay/ui/sheet.tsx` | `src/components/ui/sheet.tsx` |
| `apps/web/src/fantay/ui/collapsible.tsx` | `src/components/ui/collapsible.tsx` |
| `apps/web/src/fantay/ui/callout.tsx` | `src/components/ui/callout.tsx` |
| `apps/web/src/fantay/ui/empty-state.tsx` | `src/components/ui/empty-state.tsx`, `src/components/ui/card.tsx` |
| `apps/web/src/fantay/ui/tile.tsx` | `src/components/ui/tile.tsx` |
| `apps/web/src/fantay/ui/status-label.tsx` | `src/components/ui/status-label.tsx` |
| `apps/web/src/fantay/ui/search-field.tsx` | `src/components/ui/search-field.tsx` |
| `apps/web/src/fantay/theme/theme.ts` | `src/lib/theme.ts` |
| `apps/web/src/fantay/styles/theme.css`, `apps/web/src/fantay/styles/motion.css` | `src/styles.css` (`@theme`, `@utility`, keyframes) |
| `packages/fantay-tokens/src/tokens.ts`, generated `packages/fantay-tokens/tokens.css` | `src/styles.css` (token values) |

The governance test `apps/web/tests/fantay/governance.test.ts` keeps this list honest: every ported
file must name its Doop source and revision in its header, and the Doop name may not appear outside
licence comments.

### Additional Doop-derived workspace and board code

These files use the same Doop revision and AGPL-3.0-only terms listed above.
Paths below are relative to apps/web/.

| Local file(s) | Source at the Doop revision above |
|---|---|
| src/fantay/shell/sidebar/dash.tsx | src/components/ui/dash.tsx |
| src/fantay/shell/sidebar/Sidebar.tsx, SidebarRail.tsx | src/components/AppRail.tsx |
| src/fantay/board/camera/layout-zoom.ts | src/lib/layoutZoom.ts |
| src/fantay/board/camera/camera.ts, camera-controller.ts | src/components/Stage.tsx |
| src/fantay/board/interaction/snap.ts | src/lib/snap.ts |
| src/fantay/board/interaction/tools.ts | src/lib/tools.ts |
| src/fantay/board/interaction/pointer.ts | src/components/Stage.tsx |
| src/fantay/board/layers/BoardStage.tsx, GridLayer.tsx, WorldLayer.tsx | src/components/Stage.tsx |
| src/fantay/board/layers/LabelLayer.tsx | src/components/FrameLabelLayer.ts |
| src/fantay/board/nodes/NodeShell.tsx, NodeShell.module.css, NodeLabel.tsx, NodeLabel.module.css | src/components/FrameView.tsx |
| src/fantay/board/nodes/common/PendingFace.tsx, faces.module.css | src/components/GhostFrames.tsx |
| src/fantay/board/nodes/frame/FrameSurface.tsx | src/components/FrameView.tsx |
| src/fantay/board/chrome/BottomToolbar.tsx | src/components/Stage.tsx |
| src/fantay/board/BoardView.module.css | src/styles.css |
| tests/fantay/board/layout-zoom.test.ts | tests/frameRasterZoom.test.ts |
| tests/fantay/board/snap.test.ts | tests/snapGuides.test.ts |
| tests/fantay/board/tools.test.ts | tests/tools.test.ts |

## infinite-canvas

Source: https://github.com/basketikun/infinite-canvas
Revision: 9cd3deacbcc598361807afc16c059a80dd18b6f9 (MIT-licensed HEAD).
No code was imported from the AGPL v0.0.7 snapshot.
Local paths are relative to apps/web/; source paths are relative to that revision.

| Local file | Source |
|---|---|
| src/fantay/board/camera/focus-viewport.ts | web/src/lib/canvas/canvas-node-geometry.ts |
| src/fantay/board/engine/culling.ts | web/src/pages/canvas/project.tsx |
| src/fantay/board/interaction/resize.ts | web/src/components/canvas/canvas-node.tsx |
| src/fantay/board/layers/EdgeLayer.tsx | web/src/components/canvas/canvas-connections.tsx |
| src/fantay/board/layers/SelectionOverlay.tsx | web/src/components/canvas/canvas-selection-toolbar.tsx |
| src/fantay/board/chrome/Minimap.tsx | web/src/components/canvas/canvas-mini-map.tsx |
| src/fantay/board/nodes/media/image-source.ts | web/src/lib/image-thumbnail.ts |
| src/fantay/generation/keyboard.ts | web/src/lib/keyboard-event.ts |
| tests/fantay/board/focus-viewport.test.ts | web/tests/canvas-focus-viewport.test.ts |
| tests/fantay/board/image-source.test.ts | web/tests/image-thumbnail.test.ts |

MIT License

Copyright (c) 2026 basketikun

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Tailwind CSS preflight

`apps/web/src/fantay/styles/preflight.css` adapts portions of Tailwind CSS v4.3.0 `preflight.css`.
MIT License, Copyright (c) Tailwind Labs, Inc.

## Radix Colors

The violet brand scale in `packages/fantay-tokens` and the dark step-11 project-tag hues in
`apps/web/src/fantay/styles/legacy-fixes.css` are values from Radix Colors. MIT License,
Copyright (c) 2021 Radix.

## Bundled npm packages (web UI foundation)

| Package | Version | Licence | Copyright |
|---|---|---|---|
| `@radix-ui/react-slot`, `react-dialog`, `react-alert-dialog`, `react-dropdown-menu`, `react-context-menu`, `react-popover`, `react-tooltip`, `react-select`, `react-switch`, `react-tabs`, `react-toggle-group`, `react-collapsible` | 1.5.0, 1.3.1, 1.2.1, 2.2.1, 2.4.1, 1.3.1, 1.4.1, 2.4.1, 1.4.1, 1.2.1, 1.2.1, 1.2.1 | MIT | Copyright (c) 2022 WorkOS |
| `class-variance-authority` | 0.7.1 | Apache-2.0 | Copyright 2022 Joe Bell |
| `clsx` | 2.1.1 | MIT | Copyright (c) Luke Edwards |
| `tailwind-merge` | 3.7.0 | MIT | Copyright (c) 2021 Dany Castillo |
| `lucide-react` | 1.16.0 | ISC | Copyright (c) Lucide Icons and Contributors |
| `@fontsource-variable/inter` (Inter typeface) | 5.3.0 | SIL Open Font License 1.1 | Copyright (c) 2016 The Inter Project Authors — licence text: [`apps/canvas/licenses/Inter-OFL.txt`](apps/canvas/licenses/Inter-OFL.txt) |
| `@codemirror/state`, `view`, `language`, `commands`, `search`, `merge`, `language-data`, `@lezer/highlight` (side workspace code viewer) | 6.7.6, 6.43.15, 6.13.1, 6.11.1, 6.7.2, 6.12.3, 6.5.2, 1.2.5 | MIT | Copyright (C) 2018-2021 by Marijn Haverbeke and others |
| `@tanstack/react-virtual` (side workspace file tree, data grids and archive listings) | 3.14.26 | MIT | Copyright (c) 2021-present Tanner Linsley |
| `cmdk` (side workspace start page) | 1.1.1 | MIT | Copyright (c) 2022 Paco Coursey |
| `diff` (turn change counts and patch reading) | 8.0.4 | BSD-3-Clause | Copyright (c) 2009-2015, Kevin Decker |
| `pdfjs-dist` (artifact PDF viewer and self-hosted worker/cMaps/standard fonts/codecs under `apps/web/public/artifact/pdfjs/`, with `LICENSE` kept beside them) | 6.5.438 | Apache-2.0 | Copyright Mozilla Foundation and contributors |
| `docx-preview` (artifact Word `.docx` page renderer) | 0.4.1 | Apache-2.0 | Copyright Volodymyr Baydalka |
| `papaparse` (artifact CSV/TSV streaming parser) | 5.7.1 | MIT | Copyright (c) 2015 Matthew Holt |
| `@e965/xlsx` (SheetJS Community Edition mirror for workbook reading) | 0.20.3 | Apache-2.0 | Copyright (C) 2012-present SheetJS LLC |
| `@office-kit/pptx-preview` (and peer `@office-kit/pptx`, PowerPoint slide model and SVG renderer) | 0.21.0 | MIT | Copyright (c) @office-kit contributors |
| `heic-to` (HEIC/HEIF image decoder in worker) | 1.6.7 | LGPL-3.0 | Copyright Hopper Gee |
| `tiff` (TIFF image decoder in worker) | 7.1.3 | MIT | Copyright (c) Michaël Zasso |
| `ag-psd` (Photoshop `.psd` composite reader in worker) | 34.2.0 | MIT | Copyright (c) Agamnentzar |
| `fflate` (ZIP/GZIP streaming reader for archives, EPUB and OpenDocument) | 0.8.3 | MIT | Copyright (c) 2020 Arjun Barrett |
| `sql.js` (read-only SQLite WebAssembly viewer) | 1.16.0 | MIT | Copyright (c) sql.js authors |
| `fast-xml-parser` (XML package/navigation parser) | 5.12.1 | MIT | Copyright (c) Natural Intelligence / Amit Gupta |
| `three` (3D model stage and loaders) | 0.185.1 | MIT | Copyright © 2010-2026 three.js authors |
| `dompurify` (HTML allow-list sanitiser for converted documents and notebooks) | 3.4.2 | MPL-2.0 OR Apache-2.0 | Copyright 2015 Mario Heiderich, Cure53 |
| `shiki` (code cell and Markdown syntax highlighting) | 4.1.0 | MIT | Copyright (c) 2021 Pine Wu, Copyright (c) 2023-PRESENT Anthony Fu |
| `micromark`, `micromark-extension-gfm` (CommonMark + GFM prose rendering) | 4.0.2, 3.0.0 | MIT | Copyright (c) Titus Wormer |
| `pele` (Mermaid diagram renderer for the artifact diagram viewer and for Mermaid blocks in Markdown documents and chat messages) | 1.13.0 | MIT | Copyright (c) 2026 kepano |
| `postal-mime` (MIME parser for the artifact e-mail viewer, run in a worker) | 4.2.0 | MIT-0 | Copyright (c) 2021-2025 Andris Reinman |
| `katex` (formula typesetting in notebooks, Markdown documents, chat messages and Mermaid labels; its stylesheet and the KaTeX fonts it ships are bundled with the app, and an exported diagram that holds formulas carries the fonts it uses) | 0.19.1 | MIT | Copyright (c) 2013-2020 Khan Academy and other contributors |

The TokenToSea tool catalog also bundles static Lucide geometry in
`apps/web/src/components/tokentosea/tool-icons/nodes.json`. Full ISC/MIT notices
are retained next to the source and shipped in `apps/web/public/tool-purpose-icons/LICENSE.txt`.

## 京華老宋体 (KingHwa OldSong)

`apps/web/public/fonts/KingHwaOldSong-hero.woff2` and `apps/web/public/fonts/KingHwaOldSong-manga.woff2` are
glyph subsets of 京華老宋体 v2.002, Font © Copyright 2022 TerryWang, used for the Home headline and the
changelog manga display lettering. The author's terms allow free commercial use and embedding in software; they
forbid altering the glyphs, distributing altered versions, or selling the font file on its own. The subsets keep
the original outlines and name records unchanged.

## 霞鹜文楷 (LXGW WenKai)

`apps/web/public/fonts/LXGWWenKai-manga.woff2` is a glyph subset of LXGW WenKai Medium v1.522 from
[lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai), derived from Fontworks Klee, used for the changelog manga
dialogue and narration lettering. SIL Open Font License 1.1, Copyright 2021-2026 LXGW and Copyright 2020 The
Klee Project Authors — licence text: [`licenses/LXGWWenKai-OFL.txt`](licenses/LXGWWenKai-OFL.txt).

## IM FELL English

`apps/web/public/fonts/IMFellEnglish-Regular.ttf` and `IMFellEnglish-Italic.ttf` are the unmodified IM FELL
English roman and italic from [google/fonts](https://github.com/google/fonts/tree/main/ofl/imfellenglish), used
for the Latin text of the Home headline and changelog manga display lettering. SIL Open Font License 1.1,
Copyright (c) 2010 Igino Marini — licence text: [`licenses/IMFellEnglish-OFL.txt`](licenses/IMFellEnglish-OFL.txt).

## Stageshow

`apps/web/src/vendor/stageshow/` is the kit from [benjitaylor/skills](https://github.com/benjitaylor/skills) (`stageshow/kit`),
MIT, Copyright (c) Benji Taylor; the licence text is kept beside it as `LICENSE`. The bundled third-party brand marks
(`kit/brands`, `BrandMark`) are removed. The demos built on it live in `apps/web/src/fantay/stageshow/`.

## Kubai Icons

`apps/web/src/vendor/kubai-icons/runtime.ts` carries the engine and 17 example icons of
[kubai087/kubai-icons](https://github.com/kubai087/kubai-icons), Copyright (c) 2026 Kubai087, under the Kubai Icons
License (source-available, not open source); the licence text is kept beside it as `LICENSE`. The file is generated
from the workspace's `tools/feature-icons` and also holds eight icons drawn for Fantay. The licence permits shipping
the engine and icons inside the product with the notice kept; it does not permit redistributing the example icons on
their own as an icon set.

## Side workspace: start page, code surface and surface router

The side workspace under `apps/web/src/fantay/workspace/{start,code,surfaces}/` adapts code from three
projects. Every receiving file names its source path, commit and licence in its header and is distributed
under AGPL-3.0-only together with the upstream notice.

- [eta](https://github.com/0xfe-project/eta) at `793ded7cd96f9cafb713715b2301adeab2f9b046`, MIT,
  Copyright (c) 2026 eta contributors — licence text: [`licenses/eta-MIT.txt`](licenses/eta-MIT.txt).
  - `apps/web/src/lib/tool-shape.ts` → `surfaces/tool-shape.ts`: reading a tool call by the shape of its
    input, the edit-pair reader and the Codex file-change reader.
  - `apps/web/src/components/workspace/pane.ts` → `code/use-pane-width.ts`: the resizable pane hook.
- [t3code](https://github.com/pingdotgg/t3code) at `c5e6b24ff5e1b752d91a75fa425322f5c90bf5cf`, MIT,
  Copyright (c) 2026 T3 Tools Inc. — licence text: [`licenses/t3code-MIT.txt`](licenses/t3code-MIT.txt).
  - `apps/web/src/components/files/FileBreadcrumbs.tsx` and `filePath.ts` → `code/Breadcrumb.tsx`.
  - `apps/web/src/components/RightPanelTabs.tsx` (`RightPanelEmptyState`) → `start/WorkspaceStart.tsx`
    and its stylesheet: the card-less column of rows (structure only).
- [cindy](https://github.com/makecindy/cindy) at `88941ba77f2e2f30b3e6936102053ccd0d66c2f9`, Apache-2.0,
  Copyright 2026 XD Inc. The upstream NOTICE is retained as
  [`licenses/cindy-NOTICE.txt`](licenses/cindy-NOTICE.txt); the Apache-2.0 text is [`LICENSE`](LICENSE).
  The files below are modified from the originals (Fantay tokens, typed for this renderer, hidden-tab handling).
  - `apps/desktop/src/renderer/features/cc-agent/workdir-browse/lib/treeRows.ts` and `FileTreeView.tsx`
    → `code/file-tree.ts`, `code/FileTree.tsx`: flat row model and the virtualised tree wiring.
  - `packages/maker-shared/src/filePresentation.ts` and `apps/desktop/src/renderer/components/ui/file-type-icon.tsx`
    → `code/file-visual.ts`.
  - `apps/desktop/src/renderer/lib/textPreview.ts` and `packages/file-browser-core/src/textFileExts.ts`
    → `code/text-preview.ts`.
  - `apps/desktop/src/renderer/components/markdown/codemirrorGithubTheme.ts`, `PlaintextEditor.tsx`,
    `useIsDarkMode.ts` and `features/cc-agent/workdir-browse/FileBodyView.tsx`
    → `code/codemirror-theme.ts`, `code/codemirror-runtime.ts`, `code/CodeEditor.tsx`.
  - `apps/desktop/src/renderer/features/right-sidebar/plugins/file-browser/FileBrowserBody.tsx` and
    `FileBrowserBody.css`, `features/cc-agent/workdir-browse/FileFilterInput.tsx`
    → `code/CodeSurface.tsx`, `code/CodeSurface.module.css`, `code/FileRail.tsx`.
  - `apps/desktop/src/renderer/features/right-sidebar/EmptyState.tsx` → `start/WorkspaceStart.tsx` and its
    stylesheet: row anatomy and the narrow-panel degradation (structure only).
  - `apps/desktop/src/renderer/features/right-sidebar/lib/lastTurnChangedFiles.ts`
    → `surfaces/turn-changes.ts`, `surfaces/tool-shape.ts`: path normalisation and per-runtime path fields.
- [opencodex](https://github.com/lidge-jun/opencodex) at `c155cc7923dbc0102e27d79185505a85d4357b2c`, MIT,
  Copyright (c) 2026 opencodex contributors — licence text: [`licenses/opencodex-MIT.txt`](licenses/opencodex-MIT.txt).
  Reached through cindy's vendored copy (`packages/model-compat/src/upstream/responses/apply-patch-envelope.ts`):
  the patch-operation line pattern and the freeform-input unwrapping in `surfaces/tool-shape.ts`.

## Artifact viewers, files library and chat product cards

The artifact viewers under `apps/web/src/fantay/artifact/` and the files library under
`apps/web/src/fantay/workspace/files/` adapt bounded readers, layout models and UI patterns from the
following projects. Every receiving file carries its `SPDX-License-Identifier: AGPL-3.0-only` header
naming the upstream path, revision, licence and local changes.

- [t3code](https://github.com/pingdotgg/t3code) at `c5e6b24ff5e1b752d91a75fa425322f5c90bf5cf`, MIT,
  Copyright (c) 2026 T3 Tools Inc. — licence text: [`licenses/t3code-MIT.txt`](licenses/t3code-MIT.txt).
  - `apps/web/src/components/files/PdfViewer.tsx`, `pdfDocument.ts`, `pdfLayout.ts`
    → `artifact/viewers/PdfViewer.tsx`, `pdf/PdfPage.tsx`, `pdf/pdf-document.ts`, `pdf/pdf-layout.ts`,
    `pdf/pdf-find.ts`.
  - `apps/web/src/components/files/imageDecode.worker.ts` → `artifact/viewers/image/decode.worker.ts`
    (bounded HEIF/TIFF decoders, extended with PSD).
  - `apps/web/src/components/files/extendedDocumentPreview.ts` and `packages/shared/src/imageDimensions.ts`
    → `artifact/viewers/document/xml.ts`, `document/images.ts`, `document/odt.ts`, `document/rtf.ts`,
    `ebook/epub.ts`, `slides/odp-outline.ts`, `notebook/parse-notebook.ts`.
  - `apps/web/src/components/files/DocumentPages.tsx` and `NotebookPreview.tsx`
    → `artifact/viewers/notebook/notebook-html.ts`, `notebook/NotebookPage.tsx`.
  - `apps/web/src/components/files/VirtualTablePreview.tsx`
    → `artifact/viewers/parts/DataGrid.tsx`, `sheet/use-row-windows.ts`.
  - `apps/web/src/components/files/office/sheet-cells.ts` (MIT, adapted from opencode, Copyright (c) 2025
    opencode) → `artifact/viewers/sheet/grid-model.ts`.
  - `apps/web/src/components/files/binaryPreview.worker.ts` and
    `packages/client-runtime/src/zip/{zipDirectory,boundedZip}.ts`
    → `artifact/viewers/database/read-database.ts`, `archive/archive-reader.ts`.
  - `apps/web/src/components/files/AudioPreview.tsx` and `components/media/MediaVideoPlayer.tsx`
    → `artifact/viewers/AudioViewer.tsx`, `VideoViewer.tsx`, `media/media-time.ts`,
    `media/use-media-playback.ts`.
- [cindy](https://github.com/makecindy/cindy) at `88941ba77f2e2f30b3e6936102053ccd0d66c2f9`, Apache-2.0,
  Copyright 2026 XD Inc. — upstream NOTICE: [`licenses/cindy-NOTICE.txt`](licenses/cindy-NOTICE.txt).
  - `apps/desktop/src/renderer/features/cc-agent/workdir-browse/FileTreeView.tsx`
    → `artifact/viewers/archive/ArchiveTree.tsx` (modified to add archive size/date columns and folder totals).
  - `apps/desktop/src/renderer/components/chat/GeneratedFilesCard.tsx`
    → `artifact/cards/ArtifactCards.tsx` (group layout and existence rule; rewritten for Fantay tokens,
    live page covers, anchored share/export menus and active-tab selection).
  - `packages/maker-shared/src/mermaidAutofix.ts`
    → `artifact/viewers/diagram/problems.ts` (its list of common mistakes in AI-written Mermaid and its
    arrow characters; modified so that nothing is rewritten: each case becomes a hint shown with the
    parser's error, and full-width punctuation and unquoted CJK names were added).
- [PDF.js](https://github.com/mozilla/pdf.js) at `v6.5.438`, Apache-2.0, Mozilla Foundation.
  - `web/text_layer_builder.js` (`#bindMouse`, `#enableGlobalSelectionListener`)
    → `artifact/viewers/pdf/text-selection.ts`.

### Excalidraw fonts served with the app

`apps/web/public/artifact/excalidraw/fonts/` is a byte-identical copy of
`@excalidraw/excalidraw@0.18.1/dist/prod/fonts/` (234 files; the package itself is MIT, Copyright (c) 2020
Excalidraw). The sketch editor and the artifact drawing viewer load these fonts from the app instead of the
library's public CDN, and a drawing saved as SVG embeds the glyphs it uses. Each family keeps its own
licence, as stated in the font file's name table, in Excalidraw's source, or by its upstream project:

| Family (folder) | Licence | Copyright |
| --- | --- | --- |
| Excalifont | SIL OFL 1.1 | Copyright (c) 2024 by Excalidraw |
| Virgil | SIL OFL 1.1 | Copyright (c) 2011 by Your Own Font Foundry |
| Xiaolai SC (`Xiaolai`, 209 subset files) | SIL OFL 1.1 ([lxgw/kose-font](https://github.com/lxgw/kose-font)) | Copyright © 2020 LXGW |
| Nunito | SIL OFL 1.1 | Copyright 2014 The Nunito Project Authors |
| Lilita One (`Lilita`) | SIL OFL 1.1 | Copyright (c) 2011 Juan Montoreano, with Reserved Font Name "Lilita One" |
| Assistant | SIL OFL 1.1 | Copyright 2020 The Assistant Project Authors; Copyright 2010 The Source Sans Pro Authors, with Reserved Font Name 'Source' |
| Cascadia Code (`Cascadia`) | SIL OFL 1.1 ([microsoft/cascadia-code](https://github.com/microsoft/cascadia-code)) | Copyright (c) 2019 - Present, Microsoft Corporation, with Reserved Font Name Cascadia Code |
| Comic Shanns (`ComicShanns`) | MIT | Copyright (c) 2018 Shannon Miwa, (c) 2023 Jesus Gonzalez, (c) 2023 Rodrigo Batista de Moraes, (c) 2024 Fini Jastrow, (c) 2024 Kyle Beechly |
| Liberation Sans 1.05 (`Liberation`) | See note | Digitized data © 2007 Ascender Corporation |

Note on Liberation Sans: the file Excalidraw ships (version 1.05) carries the wording of the original Liberation release
("subject to the license agreement under which you accepted the Liberation font software"), not the SIL OFL
1.1 text that current [Liberation Fonts](https://github.com/liberationfonts/liberation-fonts) releases use.
It is redistributed here unmodified, exactly as the Excalidraw package distributes it; review this entry
before a public release.

## Design references (no code)

- Wonder (wonder.design): no code or assets used; layout patterns re-implemented clean-room.
- [Ryugi](https://github.com/Innei/ryugi): no code or assets copied. Interaction principles (reader place
  preserved across rewrites, structural text/page thumbnails without per-card iframes, and the `<od-focus>`
  tool marker) were informed by studying product behaviour and the public `v1.51.2` `artifacts/` release
  (AGPL-3.0-only), implemented here from scratch for React 18.
- OpenAI Codex desktop app (right-hand panel): no code or assets used; the file-tab, breadcrumb and
  tree-on-the-right arrangement was observed from screenshots.

## Palmier Pro — GPL-3.0-only source adaptation

Copyright (C) 2026 Palmier, Inc.

`apps/web/src/components/movie/palmier/palmier-core.ts` adapts the integer-frame
snap engine, time formatting, and layout constants from Palmier Pro commit
`8805801fa4df8bc2dbc57cb0a854a1f5108f95c6`. The compact inspector in `apps/web/src/components/movie/MovieCompactInspector.tsx`
and the editor/timeline CSS adapt the row structure and geometry from
`Inspector/Components/InspectorRow.swift`, `Editor/EditorView.swift`,
`Timeline/TimelineGeometry.swift`, and `UI/TimelineClipColors.swift`.
The Swift originals for the algorithm port are
`Timeline/SnapEngine.swift`, `Utilities/TimeFormatting.swift`,
`Utilities/Constants.swift`, and `UI/AppTheme.swift` under `Sources/PalmierPro`.
The 2026-10-29 TypeScript port omits AppKit haptic calls and connects to
Fantaydesign's sequential movie model. The port is GPL-3.0-only, without
warranty; see `licenses/palmier-pro-GPL-3.0.txt`. Corresponding modified source
is in this workspace. This entry does not relicense upstream code as Apache
or establish permission to distribute a combined proprietary application.

## Archived native video editor source

The retired macOS companion was derived from the complete public GPL-3.0-only
Palmier Pro source at commit `8805801fa4df8bc2dbc57cb0a854a1f5108f95c6`.
Copyright (C) 2026 Palmier, Inc. Its modified Swift source, tests, resources,
original license and build script were archived together on 2026-11-07.

The preserved [source and GPL license](../doc/achieve/studio-retirement-20261107/files/native/palmier/)
include the app identity, MCP endpoint, host bridge, TokenToSea account interface,
color pipeline and packaging modifications. The [color-management notices](../doc/achieve/studio-retirement-20261107/files/native/palmier/COLOR-MANAGEMENT-NOTICES.md)
and [OpenColorIO license](../doc/achieve/studio-retirement-20261107/files/native/palmier/OpenColorIO-LICENSE.txt)
remain with that source snapshot. The active TypeScript adaptation is documented
in the preceding section.

## Anthropic Artifact-type and dataviz skill text (via JimLiu/baoyu-design) — no licence granted

Agent content adapted from [JimLiu/baoyu-design](https://github.com/JimLiu/baoyu-design), which
carries Anthropic's claude.ai Artifact types (Slides, Dashboard, Design System) and Anthropic's
dataviz skill to local agents. The adapted text remains Anthropic's material. Anthropic has
published no licence for it, and neither this repository nor baoyu-design grants one: the licence
terms stated for this distribution above do not cover this text, and the MIT licence in
baoyu-design covers only that project's own tooling. The complete terms are in
[baoyu-design's NOTICE.md](https://github.com/JimLiu/baoyu-design/blob/main/NOTICE.md). This project
is independent and is not affiliated with or endorsed by Anthropic. Review these terms before any
public redistribution of the files below.

- `skills/dataviz/` — `SKILL.md` adapted; `references/*.md` carried over with path edits;
  `scripts/validate_palette.js` and `scripts/validate_palette.py` as shipped by baoyu-design, which
  include code from Color.js (MIT, Lea Verou and Chris Lilley, credited in the file headers).
- `skills/claude-design-system/` — `SKILL.md` and `references/*.md` adapted from the Design System
  Artifact type.
- `design-templates/claude-slides/` — `SKILL.md` and `references/*.md` adapted from the Slides
  Artifact type; `example.html` is original to this repository.
- `design-templates/claude-dashboard/` — `SKILL.md` and `references/*.md` adapted from the Dashboard
  Artifact type; `example.html` and `data/` are original to this repository (all rows are invented
  sample data).
- `craft/data-visualization.md`, `craft/slide-composition.md`, `craft/content-discipline.md` —
  distilled from the same sources.

Each of the first four folders carries a `NOTICE.md` with the same statement.

## Jianying draft compatibility runtime

`vendor/jianying-draft/vendor/jianying-mcp/` derives from Ppppan9/jianying-mcp
at commit `3016f4fdbd55d2df3f7e3b8bf4144df968cd10c4` (MIT, Copyright 2026
Hou Tao). Its license and upstream NOTICE are retained in
`vendor/jianying-draft/licenses/`. The local native interface declarations
reference wenshui330/jy-draftc (MIT); its license is retained there as well.
No Jianying proprietary libraries or commercial resource packages are shipped.

The fixed `@ffprobe-installer/ffprobe` 2.1.2 dependency is LGPL-2.1 according
to its package metadata. Platform binary terms and notices remain with the
distributed dependency packages. Jianying and CapCut belong to their owners;
this integration is independent and unofficial.
