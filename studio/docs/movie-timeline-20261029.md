# Video editing and TokenToSea materials — 2026-10-29

## Correction

The earlier Palmier work implemented localized parameter/caption edits and
history, but left structural timeline editing for later. Imported footage was
registered as an asset without a direct way to make its first editable clip.
The existing review strip was for annotations, not editing. These gaps made the
film workspace fail the basic import/edit/export workflow.

The user confirmed that video generation should use their TokenToSea account.
The first implementation independently extended Fantay's existing movie model.
The source-adaptation follow-up now ports selected published Palmier code;
see `palmier-reference-20261029.md` and `THIRD_PARTY_NOTICES.md`. It retains
the existing Electron/Next/daemon stack.

## Implemented

- A visible **Edit / 剪辑** stage: live composition preview, playhead, clip
  selection, source insertion, split, trim before/after playhead, reorder by
  dragging or buttons, remove, and a contextual AI request input.
- A whole imported source can be added to the sequence. Sources over 30 seconds
  are divided into consecutive clips, rather than silently truncated. The
  existing 60-clip/five-minute total limits remain. The minimum shot duration
  now permits subsecond editing.
- HTTP `/edits`, `od movie edit`, and MCP `edit_movie` share the new operations:
  `insert-clip`, `split-clip`, `trim-clip`, `move-shot`, `remove-shot`. A batch is
  one revision-checked undo step. Source time accounts for playback speed;
  split/trim crops and shifts subtitles; removing clips keeps source files.
- `render-preview` renders a draft MP4 without manufacturing storyboard,
  sample, or final approval. Formal delivery keeps its existing review rules.
- **Generate video asset / 生成视频素材** opens TokenToSea video models inside
  the film workspace. It uses account model availability, versioned pricing,
  spending limit, preparation/invocation and result polling. It does not use a
  separate provider API key or switch the user to the board.
- Completed archived videos can be added to current movie sources. The daemon
  verifies the signed-in account's ownership of the run/asset, downloads from
  TokenToSea's COS archive without forwarding OAuth credentials, limits size,
  probes real video bytes, and saves against the current movie revision.
  `/api/tokentosea/movie/import` enforces project write access and origin checks.
  CLI parity: `od movie import-generated --run ... --asset ... --session-file ...`.
  The session file is caller-provided; credentials are never printed or stored
  in project content.

## Verified

Focused backend and UI tests cover split source/caption continuity, subsecond
trim, insertion/reorder/removal, rollback on invalid batches, undo/redo, video
model filtering, result import and ownership/storage rejection. Existing movie
history, selection, source handling, playback, production and account tests
pass. Workspace type checking, repository guard and whitespace checks pass.

Real browser acceptance used an isolated local test project
`7365ef6e-84ac-4f70-a3e0-c7a9e471ffde`. A generated six-second local test pattern
with audio was uploaded through the library API, inserted via the visible UI,
split at two seconds, undone and redone. The resulting two-/four-second clips
rendered to an actual six-second 1920×1080 H.264/AAC MP4. The exported frame at
2.1 seconds shows the matching source time. Test-pattern footage is not evidence
of a paid video model generation.

Evidence: `.tmp/movie-timeline/final-ui.png`, `preview.mp4`, `media-check.json`,
`export-frame.png`, `render-wait.json`, and `.tmp/test-records/`. The initial
test render was interrupted by a development-runtime restart; the subsequent
render completed. User projects were not used for these mutations.

The TokenToSea screen was inspected in its signed-out state. Authenticated
generation-result import uses test account responses and actual MP4 bytes in
tests. No paid generation was submitted. Real account login, charged generation
and return of that specific remote output remain unverified.

The Mac ARM64 installer is rebuilt at `.tmp/desktop/Fantaydesign.dmg` and the
desktop acceptance follow-up installed it at `/Applications/Fantaydesign.app`,
preserving the existing projects and settings. The dedicated editor now has
inward trim handles and actual source-audio waveforms. This remains a
sequential clip editor; independent overlapping tracks, waveform editing and
exact retiming of authored animation layers are not delivered.

## Development Issue follow-up

The user reported the red Next.js `1 Issue` badge left in the browser proof.
Opening it showed ENOENT for `packages/contracts/dist/analytics/index.mjs`.
The packaging cache materializer removes and restores workspace output trees;
the development bundler was reading that same transient output. The error
remained in the browser overlay after the file had been restored.

Development-only aliases in `apps/web/next.config.ts` now resolve the public
contracts, host and release exports to their TypeScript sources. JavaScript
import suffixes resolve to source TypeScript during development. Production
continues to use built package exports. Regression coverage failed before the
change and then passed; 26 focused configuration/runtime tests, workspace
typecheck and guard pass.

After restarting only the test web runtime, the browser loaded the editing
page without an Issue badge. Rebuilding contracts while it stayed open did
not reintroduce the badge. The served bundle references the source analytics
entry and no longer references its dist entry. Evidence is in
`.tmp/issue-build-race/`, including `after.png` and `module-resolution.json`.

## Context retrieval

Nowledge MCP thread search `palmier`, normal mode, default Space, found the
earlier request in `codex-01a17e61-59b7-7771-a210-57f870884d98`. One bounded read
of messages 144–149 confirmed that the earlier implementation deliberately
deferred the editable timeline. Current source and live behavior were used to
verify the gap and this correction.
