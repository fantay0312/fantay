# Video editor

## 2026-11-09 polish: audio lines up with its picture

The owner reported that audio and video were not aligned and asked for both
layouts to be polished. Linked audio is now a full-width row at the bottom of
the clip body, inside its border and under the frames (FULL 14 px, COMPACT
12 px), so frames and sound share the clip's edges. The waveform is drawn in
real pixels over the visible window only, on 2 px buckets anchored to source
time (each bucket = loudest peak it covers, gamma 0.6), so it matches the
ruler at every zoom and does not shimmer while trimming. Filmstrip tiles are
anchored to source time the same way. 波形 display is FULL-only; COMPACT always
shows frames over the audio row. Picture keyframes sit on the frame/sound
seam; the lock hatch and selection ring cover the audio row too.

The daemon samples peaks at 50 bins/s (600–24000) on the picture clock
(late or short audio is padded) and cuts about one thumbnail per second
(6–48, `frame-<count>-<i>.jpg`, `audio-peaks-v2.json`); old caches upgrade
lazily.

Layout: 主轨 80 px FULL / 60 px COMPACT; the empty A1 drop lane (dashed, no
lock/mute) shows in both layouts; the zoom re-fits on width changes until the
user zooms by hand. Compact timeline defaults to 35%, full to 42%, each
remembered separately. Timecodes are HH:MM:SS:FF everywhere. The FULL stage is
a lighter tone than the ground so the viewer reads as a card; the upper cards
and the timeline share one 12 px content line. 完整剪辑 is a text-only quiet
button (hidden under 560 px, where the pane's maximize remains). Segmented
controls key their chosen chip on aria-checked, because a wrapping Tooltip
overwrites Radix's data-state.

## 2026-11-03 two layouts, no AI inside the editor

The owner rejected the dense compact pane and the editor's own AI popover, and
asked for a synthesis of all their references (the projects in
doc/开源剪辑软件与项目汇总.md, dogsc, 剪映/CapCut) fitted to Fantay's design
system — not a copy of one. AI editing happens in the project chat left of the
pane; the editor is a manual tool with two layouts over one document,
selection and history (`movie-editor-layout.ts`):

- Compact (pane beside the chat): title, Import, Text, Media & effects drawer
  (left, over the stage only, so media drags straight onto lanes), Adjust
  popover with the tabbed inspector, More, 完整剪辑, Export. Stage, player bar,
  quick-cut toolbar (undo/redo, 分割, Q, W, 删除, 主轨磁吸/吸附/预览轴, zoom).
- Full (shell maximized, or pane ≥ 960 px): cards on a grey ground with 6 px
  gutters that resize (double-click resets): resources (媒体 音频 文本 字幕 转场
  滤镜 动画) | viewer | tabbed inspector (全片设置 list when nothing is
  selected), timeline card with track headers and status bar.

Principles: chrome stays ink on paper, colour marks content (video strip +
thumbnails, audio = success tint, text = warning tint, captions = info tint)
and the playhead; one document, two densities; 剪映 vocabulary and keys
(⌘/Ctrl+B, Q/W, 主轨磁吸, 吸附 N, 预览轴 S, M, ⌘L, ⇧⌫, ↑/↓ edit points);
direct manipulation never animates and commits once; only show what the model
can do (no sticker/effect placeholders). Linked audio is a band inside its
video clip; audio lanes hold detached audio only. Edits arriving from the chat
are outlined on the timeline and summarised in a 来自对话 chip. `--movie-*`
tokens live on `.workspace` (light + dark). All controls use the existing edit
operations (`movieCutOperations` holds the 主轨磁吸 math); contracts, daemon
and CLI are unchanged. The embedded presentation keeps its AI side panel.

## 2026-11-03 unified editor

AI and manual editing share the in-project MovieDocument, absolute tracks and
revision-checked history on Windows and macOS. No separate full editor is
opened or shipped. The earlier compact/native split below is historical and
is superseded by docs/unified-video-editor-20261103.md.

Keep the existing neutral desktop surfaces. In a narrow project pane, show
Import, Text, Media, Adjust, AI and Export without introducing a second chat
column. Adjust opens the same inspector in a popover; on wider panes it docks
beside the viewer. Media can be revealed temporarily. The timeline remains
visible and supports direct manipulation, real thumbnails and real audio peaks.


Mode: Operate. The user explicitly selected Palmier Pro as the visual and
interaction reference, including reuse of its published source. Source version:
`8805801fa4df8bc2dbc57cb0a854a1f5108f95c6` (`last-gpl-source`).

## 2026-10-31 compact editor and background helper

The linked-native compact editor is one column of keyboard-first tools at the
408 px pane the default window gives it: header, stage, one transport row, one
tool row, timeline, status row. The video has no native controls, so the
transport and ruler are the only playback surfaces. Previews stay on screen
while a new one renders, with progress in a chip over the stage. Media and clip
adjustments open as popovers; adjustments dock beside the stage from 860 px.

The ruler scrubs and carries the playback-position slider role. Thumbnails and
audio peaks are read from the rendered preview, so they show the actual cut and
a silent film has no waveform. Clip edges trim inward only; extending a clip
stays in the full editor. Dragging reorders a contiguous track, and slides a
clip inside its gap otherwise. All edits go through the native tools, so the
compact and full editors share one undo history.

The native process is an invisible helper until the user asks for the full
editor: no Dock icon, no windows, no restored session, no export notifications.

## 2026-10-30 desktop authority

The host opens video creation in place. Its right pane provides a compact
preview and working timeline, while the project's conversation stays on the
left. Only the explicit “打开 Fantay 剪辑” action opens the full native editor.
Background reads, preview exports, chat and generation never show a native
window or steal focus. Linked native projects use the native timeline directly;
the older host MovieDocument must never overwrite their edits. Unlinked movies
reuse the Web timeline in its compact layout.

“全部视频与动画” is a permanent sidebar destination at `/movies`, combining
host movies and native projects without duplicating linked entries. Entering
a film opens its project workspace; completed Web renders can play on the
library card. Native cover metadata must not display stale host durations.

Desktop chrome shares the native light/dark AppTheme palette. Keep 220 px host
navigation, a 36 px top row, compact flat settings and one settings sidebar.
Native chat starts at 320 px; media/inspector columns hold their widths while
the viewer receives extra window space. Native chat uses AgentMessageView and
its Markdown rendering, restrained empty state, one shallow composer, and
channel/model menus grouped by availability. TokenToSea identity is shared.

## Source-derived layout

One dedicated editing viewport. The 30 px header contains the project, panel
toggles and export. Media, viewer and inspector share the upper region; the
timeline spans the bottom, initially 35% of height, with a 28 px title and
36 px tool row. There is no surrounding app sidebar or second title bar.

Media defaults to 500 px (minimum 352), inspector to 340 px (minimum 300),
viewer to at least 400 px. Fit media to available width, and collapse it below
1092 px. The inspector and timeline support drag resizing. A hidden media
panel does not hide Import/Generate: both remain in the header menu.
AI is an optional left sibling of the editor, following Palmier's agent pane;
opening it collapses media in this first web adaptation.

The inspector uses 88 px labels, 22 px fields, 28 px group headings and
expandable sections. Name, timecode, source in, speed, volume and fit are
horizontal rows. Subtitle timing/text stays available inside its disclosure.
Only a changed form shows Apply/Cancel. Formatting never rounds the stored
original duration, in-point or volume during an unrelated edit.

## Source-derived tokens

- Base #18191c, surface #1e1f23, raised #26272c; borders white at 7–10%.
- Primary #fafafa, secondary #d6d6d6, tertiary #adadad.
- Neutral accent #ececec; timecode #f29933; playhead #ff524d.
- Video #1d5878, source audio #2e7765, captions #715486.
- Track height 44 px; ruler 28 px; clip label 16 px; trim handles 4 px
  visible when a clip is at least 48 px wide.
- Existing UI sans, 10–12 px controls, tabular timecodes.

## Editing contract

`palmier/palmier-core.ts` is the credited GPL-3.0-only Swift-to-TypeScript
port of SnapEngine and TimeFormatting, with source layout constants.
Snap capture is 8 px, sticky hold is 1.5 times that threshold, and playhead
capture receives the original 1.5 multiplier. Each gesture resets snap state.

Thumbnails are decoded source frames; waveforms are source PCM peaks.
Pointer trim previews locally and commits once on release; cancel discards it.
AI and manual edits share revisions and one-action undo history.

Current caption/video/source-audio lanes share sequential shot timing. They
are not independent overlapping tracks. Trimming inward is supported;
source-in and duration fields handle extensions subject to source bounds.

See THIRD_PARTY_NOTICES.md and licenses/palmier-pro-GPL-3.0.txt. This is
a source adaptation into the existing Electron/React app, not a claim that
Palmier's entire native Swift editor was embedded or its feature set matched.

## 2026-10-29 reference correction

The user supplied a newer Palmier screenshot and rejected the previous
three-column AI view. AI and media now remain visible together: a full-height
charcoal chat column, media bin, viewer and compact inspector. The timeline
starts after chat and has one toolbar. The chat composer uses one shallow
rounded surface, no inner textarea panel, and the real execution/model
selector in its footer. The selector shares the application configuration;
next-send model propagation has a regression test. No decorative audio green.
