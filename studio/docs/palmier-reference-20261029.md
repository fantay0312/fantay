# Palmier reference and editor correction — 2026-10-29

## What was researched

- [Official product](https://www.palmier.io/): dedicated media/viewer/inspector/
  timeline workspace, manual editing and agent-driven editing of one project.
- [Agent and MCP documentation](https://www.palmier.io/docs/agent-and-mcp):
  shared tools, explicit clip/range context, and reusable skills.
- [Community skills](https://github.com/palmier-io/palmier-skills): real editing
  workflows such as `ugc-editing` and `create-skill-from-timeline`.
- Historical editor source at `last-gpl-source`, commit
  `8805801fa4df8bc2dbc57cb0a854a1f5108f95c6`: `Timeline/DragState.swift`,
  `Timeline/SnapEngine.swift`, `Editor/EditorUndo.swift`, and
  `Agent/Tools/ToolExecutor+Clips.swift`. Current proprietary binary internals
  were not available or claimed. The initial editor was independent. The follow-up below now ports selected
  published source as explicitly requested by the user.

## Corrections made

The prior editor added buttons to the plan/review screen. Footage editing now
uses a dedicated full-viewport workspace: media thumbnails, live viewer,
inspector/AI panel, and fixed caption/video/source-audio lanes. Sources have
decoded thumbnails and cached PCM peak data; the timeline draws actual
filmstrips and waveforms, not synthetic decoration.

The tools exposed to the real DeepSeek companion still had the old operation
schema, despite the daemon and MCP already supporting structural edits. The
published schema now includes split/trim/insert/move/remove and their fields.
Companion version 0.1.16 was built and installed through the normal setup API.
The existing movie skill now includes footage recipes; UI and CLI can export a
portable SKILL.md containing current pacing, framing, audio and caption data.

## Evidence and limits

Test project `3d0edfa4-f055-44d4-8aef-ed5d077799bf` uses existing public garden
test footage and synthetic narration, not a production user project. Through
the actual workbench conversation, DeepSeek read revision 6, invoked
`fantay_movie_edit` with `split-clip`, and produced revision 7. A 2.4-second
opening became 1.0 and 1.4 seconds. The remaining three shots and assets were
byte-for-byte unchanged. The batch added one undo entry and performed no
generation, transcription, rendering or approvals. UI undo restored the exact
pre-AI shots. A separate pointer trim shortened the last clip by 0.5 seconds;
one UI undo restored its exact content.

Evidence is in `.tmp/palmier-research/`: AI before/after/comparison files,
manual and AI undo comparisons, companion setup, focused test logs, screenshots
and exported SKILL.md. Development-only memory/cache restarts were separate
from user project state.

This is still a sequential clip model. The three lanes represent captions,
video and linked source audio. Independent overlapping multitrack editing,
multicam, color grading, speed curves and XML interchange are not implemented
and are not claimed to match Palmier's feature set. Drag handles currently trim
inward; extending a clip requires its source-in/duration controls. TokenToSea
paid generation was not submitted by this validation.

## Source adaptation follow-up

The user rejected the initial layout after testing the installed app. That
prior visual approval is superseded. The follow-up ports SnapEngine.swift and
TimeFormatting.swift, and uses the published AppTheme/InspectorRow/timeline
geometry for a denser editor. Exact adaptation and licensing are recorded in
THIRD_PARTY_NOTICES.md and the source header. Full GPL text is bundled.

The inspector no longer displays a long stack of full-width form fields or
raw fractional durations. Header 30 px, tool row 36 px, tracks 44 px, resizable
media/inspector/timeline and optional left AI pane follow the source structure.
The React/Electron host, movie document, rendering and existing agent tools
remain Fantaydesign's implementation.

Installation uses `/Applications/Fantaydesign.app`; persistent user state is
under `~/Library/Application Support/Fantaydesign/namespaces/fantay`.
Original project files and settings were preserved during migration. A route
race in ProjectView that returned the editor to a project-file tab was fixed
and is covered by a dedicated regression test. The installed test project is
`472c5747-f5d5-4aa7-888a-c4ff5dcc86fb`. Its actual desktop export is H.264/AAC,
1920×1080, 10.1 seconds; evidence is in `.tmp/desktop-install-20261029/`.

Current source-adaptation checks and packaging evidence are recorded in
`.tmp/palmier-native-reference/`. No paid TokenToSea generation was submitted.

## Final installed acceptance

The final ARM64 DMG was installed into `/Applications/Fantaydesign.app`.
SHA-256: `8a6685cab8c20752be9c8e70e005d5b93e220265e6927a801a5123532c04c5eb`.
The bundled GPL file and deep code signature verification passed.
104 focused movie/side-chat tests, workspace typecheck and guard passed.

In the installed app, changing `00:00:05:22` to `00:00:05:00` updated the
sequence; undo restored the exact original two shots, including fractional
timing. Playback advanced correctly. The exported H.264/AAC MP4 is 1920×1080
and 10.1 seconds. The final AI pane has a local dark theme (`rgb(24,25,28)`),
a video-editing placeholder, and its Skill export entry. The account-wide
appearance and agent selection were not changed.

Evidence: `.tmp/palmier-native-reference/acceptance.json`, `final-ai.png`,
`verified-document.json`, `export.mp4`, `export-probe.json`, and build/test logs.
