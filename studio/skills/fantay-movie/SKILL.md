---
name: fantay-movie
zh_name: 动画工作台
en_name: Fantay Movie Studio
description: Create and edit persistent code-animation films with styles, storyboards, samples, local MP4 rendering, timestamped review, and delivery. Use inside an existing Fantay movie project.
triggers:
  - 动画工作台
  - 做片
  - 分镜
  - movie studio
od:
  mode: utility
  category: animation-motion
  design_system:
    requires: false
---

# Fantay Movie Studio

The user is editing a persistent film in a single visual workspace. The same
movie document drives previews, samples, MP4 rendering, and delivery. Work on
this document, not an unrelated HTML file. Speak the user's language.

## Live preview and human edits

During Build, save a complete playable scene skeleton early, then complete
scenes incrementally with revision-checked author upserts. Every saved
checkpoint appears in the desktop preview without waiting for an MP4. Keep
stable shot, caption and layer IDs; read the latest complete shot before each
upsert so hand-edited text, timing and style survive. A conflict requires a
fresh read and reconciliation, never a forced overwrite or a guessed revision.

Users can double-click preview text, edit titles/body/captions/artwork labels,
and adjust animation colors and typography directly. Those are source edits
with the same undo history as agent operations. Do not regenerate an entire
film for a local text or style correction.

Live notes have a timestamp or range and a content revision, without a render
ID. `od movie feedback-prompt --project <id> --notes <id,id> --json` (MCP:
`movie_feedback_prompt`) prepares only the user's selected notes for an agent.
This operation does not run an agent, export, approve or resolve anything.
When acting on that request, edit the source and inspect the affected moments;
leave note resolution to the user. Older notes keep their source version:
identify the original scene before reusing its timestamp after a reorder.
An explicit source-only request does not exercise an earlier production grant.

## Open the workspace

When the user only says “打开动画工作台” or asks to open Movie Studio, run
`"$OD_NODE_BIN" "$OD_BIN" movie open --project "$OD_PROJECT_ID" --json`
and return the workspace URL (`/projects/<id>/files/movie-studio.json`); the
film opens inside the project workspace next to the chat. Do not generate or
approve a film for an open-only request.

The four start modes mean: `library` = 从库里选, `remix` = 改一个风格,
`personal` = 用我的风格, and `blank` = 从空白开始. They describe visual style
and storyboard starting points, not provider selection or remixing a video.

## One integrated editor

AI and manual editing use the same `movie-studio.json`, absolute multi-track
placements and revision-checked undo history on Windows and macOS. There is no
separate full editor to open. Read the current document and sources before
editing. The desktop imports a former native project's latest timeline once,
preserving its original package and a migration backup. CLI users can run
`od movie initialize --project <id> --json` before editing a former project.
Never replace a pending native import with its stale host shot snapshot.

Use `fantay_movie_edit` / MCP `edit_movie` for both AI and manual changes.
`insert-clip` accepts registered video, audio or image assets; `insert-text`
accepts `{text, at, duration, track, newShotId?}` for an independent text layer.
`move-clip` places a clip at absolute output seconds on track 0–7; higher tracks
render above lower tracks. Clip settings include source in, rate, volume, mute,
position, size, opacity, rotation and fadeIn/fadeOut seconds. Read actual source
frames and transcripts rather than guessing content from filenames.

The expanded workbench uses the same document. Additional editable clip fields:
`crop {top,right,bottom,left}` (source insets 0..0.45),
`color {exposure,contrast,saturation,blur,grayscale}` (EV -3..3, multipliers 0..3,
blur 0..30 pixels, grayscale 0..1), `audioFadeIn/audioFadeOut` (output seconds),
and `keyframes [{at,x?,y?,width?,height?,rotation?,opacity?}]` (ordered linear
keys, normalized at 0..1, up to 64). Split/trim preserves interpolated poses.
Set a shot's `visual.transition` to cut/crossfade/wipe/iris and
`transitionDuration` .05..1.5; preserve the rest of its visual object. A transition
needs the next visible clip directly adjacent on the same track. Other tracks
must remain unaffected.

`update-shot` also accepts `captionStyle {fontSize,color,background,
backgroundOpacity,y,outline,align}` and `textAnimation` none/fade/rise/slide/typewriter.
`remove-shot {shotId,ripple:true}` closes later gaps on that track only.
`lock-clip {shotId,locked}` protects manual work. Never unlock a clip unless the
user explicitly requests it. The backend rejects edits or ripple shifts of
locked clips. Read and rebase after a revision conflict, preserving manual edits.
When changing speed while preserving source selection, set duration to
oldDuration * oldRate / newRate and retime local captions/fades in the same batch.

Project-owned media can be registered with MCP `import_movie_media`; local
files can be uploaded with `od movie upload-media --project <id> --file <path>`.
Generated media uses the existing TokenToSea account. FrameVelo remains an
optional HTML-motion export backend; footage uses standard local rendering.

## Read, edit, save

For footage-first work, read `references/editing-recipes.md`. The visual editor
and the agent share the same clips and atomic history. The editor's AI panel can
export its current pacing/framing/captions as a portable `SKILL.md`; external
agents can obtain the same recipe with `od movie skill --project <id> --json`.

For footage editing, use the same atomic edit endpoint as the timeline UI:
`od movie edit --project <id> --file <json> --json` (or `fantay_movie_edit` /
`edit_movie`). Read the current revision and imported sources first. One batch
has `expectedRevision`, `label`, and `operations`. Available structural operations:
`split-clip {shotId, at, newShotId?}`, `trim-clip {shotId, start, end}`,
`move-shot {shotId, index}`, `remove-shot {shotId}`, and
`insert-clip {assetId, index, in?, duration?, newShotId?}`. Split/trim times are
relative output seconds within the existing clip; source in-points account for
playback rate automatically, and subtitles are cropped and shifted. Indices are
zero-based final positions. Insert only registered video sources. Preserve
unrelated shots, batch one user intention into one undo step, and report the
actual receipt. These operations do not approve or deliver the film.

When the scoped `fantay_movie_*` tools or Movie MCP tools are available, use
them instead of shell commands. Read the current film first. Read the style
catalog only when remixing or looking for references; blank original work uses
the authoring guide. A selected complete animation already has
its scene and motion data. Use `fantay_movie_update_story` to adapt its shot text
and timing without rewriting or losing visual data. A style can carry
`visual.copy`, `visual.transition`, and up to 32 `visual.layers` (rect, ellipse,
line, grid, text, path, image), plus `assets`, material `references`, and a frozen
`designSystem` source. Coordinates are percentages; keep the story text legible.
Do not replace the workbench with an unrelated HTML page.

For an original/blank brief, use `fantay_movie_guide` (MCP:
`movie_authoring_guide`) and invent the visual narrative rather than copying the
catalog. Use `fantay_movie_author` (MCP: `author_movie`, CLI: `movie author
--file`) to save style metadata and complete shots with `direction`, per-shot
`visual`, object keyframes and camera motion. `shots.mode: replace` creates the
first storyboard; `upsert` replaces one complete scene by id or appends it.
Only editable art fields are accepted. Imported assets and production grants
remain server-owned. Use the returned revision after every operation.

Render a motion preview, inspect representative PNGs from the early/middle/late
states of the different scenes, repair via author upsert, then save the style.
The server requires a current preview before saving an authored style. Saving
preserves its full scene sequence and aspect ratio for home reuse. A blank
project has no selected template and cannot use update_story until scenes exist.

Default finished-film direction uses solid subjects, colored surfaces, lighting,
contact shadows and depth. Do not deliver a sparse wireframe diagram unless the
user explicitly asks for one. The guide describes independent fill/stroke,
gradients, subtle paper/grain texture, groups, pivot points, 3D plane rotation,
anticipation/settling and real cut/crossfade/wipe/iris transitions. Keep subjects
and movement coherent across cuts; do not fade every scene into empty paper.

Use the material search tool and link with `mode: "attach"` to import actual
media. `mode: "packet"` records only a reference and does not copy an image.
Image layers must use an ID actually returned in `style.assets`. Bind an existing
design system to read its real palette and typography. Render a style preview,
read its PNG, repair any missing media or overlap, then save the complete style.
Keep source/license evidence; website bookmarks are references, not image files.

1. Run `"$OD_NODE_BIN" "$OD_BIN" movie get --project "$OD_PROJECT_ID" --json`.
2. Edit the returned `document`. Its editable fields are title, brief,
   startMode, aspect, style, and shots. Preserve other fields and the exact
   revision you read. Save the document JSON into a temporary project file.
3. Run `"$OD_NODE_BIN" "$OD_BIN" movie save --project "$OD_PROJECT_ID" --file <file> --json`.
   On a revision conflict, reread and reapply the user's edit. Never overwrite
   a newer revision by guessing its revision number.
4. The open workspace refreshes automatically. Explain the concrete edit.

Each shot has a unique id, title, body, duration (at least 1/60 second), layout
(`title`, `statement`, `metric`, `split`), and optional project-relative media
path. Films support at most 1000 clips and four hours. Style colors are
six-digit hex values; font is `sans`, `serif`, or `mono`; motion is `rise`,
`slide`, or `scale`. New work may create a custom style, then persist it with
`movie save-style`. Each shot may override `visual`, including normalized
`keyframes` for individual layers and `camera` motion. Saved styles include
the full `demoShots` sequence, so reuse preserves the animation, not just colors.
It becomes selectable under the user's saved styles.

## Workflow gates

`movie approve-storyboard`, `movie approve-samples`, `movie render`,
`movie approve-review`, `movie deliver` mirror the buttons in the workspace.
Only approve a stage after the user has confirmed it. Content changes
invalidate earlier confirmations. Rendering is a real asynchronous operation:
use `movie wait` (up to 25 seconds per call) until the render is done or failed; never claim completion
based only on the accepted response. Rendering uses the local HyperFrames
engine and the current style/shot document. Do not replace its snapshot files.

Exception: when the saved document has `production.status: "armed"`, the user
explicitly chose Generate film for this one production. Preserve per-shot
visuals, normalized keyframes and camera tracks while adapting the storyboard.
Save it, call `fantay_movie_produce` with its latest revision, then use
`fantay_movie_wait` until done or failed. This grant never approves final review
or delivery. Never invent or modify the production grant via editable JSON.

Review notes carry a render id and timestamp. Read all notes; edit the relevant
shot; only resolve a note when its requested change has been made. Old render
files remain available. Delivery requires an approved current render and no
unresolved review notes; its ZIP includes MP4, editable source and project data.

## Existing design library and AI assets

Use `od materials search` and `od materials context` to inspect recorded
references and licensing. Copy approved material into this project, never
modify the source archive. Use configured media generation tools for images
or video only when the user requests them. Keep generated assets inside the
project and set the shot's media path. Never claim an AI asset was generated
unless the tool succeeded. Do not invent model availability or credentials.

Do not change external desktop settings, install providers, spend on unasked
generation, publish, or mark human review complete without authorization.
