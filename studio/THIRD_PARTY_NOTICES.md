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

## 京華老宋体 (KingHwa OldSong)

`apps/web/public/fonts/KingHwaOldSong-hero.woff2` is a glyph subset of 京華老宋体 v2.002, Font © Copyright
2022 TerryWang, used for the Home headline. The author's terms allow free commercial use and embedding in
software; they forbid altering the glyphs, distributing altered versions, or selling the font file on its own.
The subset keeps the original outlines and name records unchanged.

## IM FELL English

`apps/web/public/fonts/IMFellEnglish-Regular.ttf` and `IMFellEnglish-Italic.ttf` are the unmodified IM FELL
English roman and italic from [google/fonts](https://github.com/google/fonts/tree/main/ofl/imfellenglish), used
for the Latin text of the Home headline. SIL Open Font License 1.1, Copyright (c) 2010 Igino Marini — licence
text: [`licenses/IMFellEnglish-OFL.txt`](licenses/IMFellEnglish-OFL.txt).

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

## Design references (no code)

- Wonder (wonder.design): no code or assets used; layout patterns re-implemented clean-room.

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
