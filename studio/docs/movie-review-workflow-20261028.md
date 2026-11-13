# Animation review and revision loop — 2026-10-28

## Scope

The user selected review/revision completion before a new real-video import flow. The reference is Lemo's interaction: planning samples, scoped feedback, versioned review, and a revision produced from the selected notes. Existing Fantay navigation, design tokens, materials, and model settings remain shared.

## Implemented behavior

- Plan / Produce / Review navigation. Plan has style, storyboard, and real frame samples. Clicking a frame targets its shot in the feedback panel.
- The review player loads immutable, version-specific frames and chapter titles from the rendered MP4 and its saved document snapshot. Space plays, arrow keys step using the source frame rate, and N opens feedback. Dragging selects a time range.
- Feedback scopes are shot, point, range, and whole film. Each record retains its source content version and optional source render. Shot titles are stamped when the note is created.
- Explicit submission freezes the selected note IDs and creates one production authorization. Revision prompting takes precedence over blank/original authoring. A matching successful render marks the notes as addressed, pending confirmation; it never resolves them automatically.
- Human confirmation records the resolving render. Final review approval and delivery remain separate. Viewing an old version cannot approve a different current version via the header's delivery action.
- Old completed versions remain viewable while a new revision is being generated. Historical notes and timeline chapters use the corresponding render snapshot.
- CLI supports review-assets, scoped add-note, review-submit, and versioned resolve-note. MCP exposes the same scoped note schema and submit_movie_review. DeepSeek retains project-scoped tools and cannot grant itself production or final approval.
- Waveforms come from decoded PCM. No-audio and silent-audio states are explicit; no synthetic waveform is displayed.

## Local acceptance evidence

Project: `43b9c398-948c-4b64-88c5-b83cd13cf8b5` — 奏鸣 · 纸雕电影.

Source render v2: `ac1789bb-84e0-4bac-876d-8d16a9914cc0`.

1. Selected shot 6 from the plan's sample card and saved the request to change its title to “让创意飞得更远”.
2. Dragged the review filmstrip and set the range to 3.2–4.8 seconds, requesting the subtitle “每一次转动，都推动灵感”.
3. Submitted both selected notes through the page. DeepSeek Harness 0.1.12 edited the document and produced a real 16-second MP4.
4. Result v3: `99d8b49a-747b-4064-828f-fff4f79a970c`. Document comparison confirmed unchanged visual objects and shot durations. Extracted frames at 4s and 14s confirmed both requested text edits in the MP4.
5. Verified both notes initially remained unresolved with v3 pending confirmation, then confirmed each through the UI. Both retain v2 as origin and v3 as resolving version. Final approval and delivery were left unset.
6. Switched back to v2 and verified the old shot title and original MP4 remained available. Checked desktop (1600×1100) and narrow (390×844) layouts.

Artifacts in `.tmp/movie-review/`: `before-revision.json`, `after-revision.json`, `revision-v3.mp4`, `verified-range.png`, `verified-title.png`, `plan-samples.png`, `review-pending.png`, `review-confirmed.png`, and `mobile-plan.png`.

## Verification

- Movie backend: 15 files / 51 tests passed, including real FFmpeg thumbnail and audio extraction.
- Movie UI: 5 files / 15 tests passed, including range selection, source-frame stepping, pending confirmation, and real sample targets.
- DeepSeek runtime: 3 files / 22 tests passed.
- A focused review test rerun passed after separating historical source content version from current production baseline.
- Web, daemon, and runtime type checks, project guard, and whitespace checks passed. Frontend detector returned no findings.
- No Claude Code execution or connection testing. No commit, push, or deployment.
