# Local editing and persistent undo — 2026-10-28

## Delivered behavior

The workbench edits a selected shot's title, duration, source in-point, speed,
volume, fit, and individual caption cues. One Apply submits one atomic batch.
The server checks the exact revision, allowed fields, caption timing and source
video bounds before saving anything. A compact receipt names the affected shots
and shows each changed field's previous and next value.

Undo and redo persist with the project across reloads. History stores at most
25 edits and 8 MiB of snapshots; larger edits report that history was not kept.
Restoration covers editable content only. Current review notes, saved styles,
renders and production records remain; content changes invalidate approvals and
delivery instead of resurrecting an earlier approval.

HTTP, CLI, MCP and the DeepSeek companion expose the same editing/history
operations. The legacy DeepSeek `fantay_movie_update_story` now sends one batch
to `/edits`, so it receives the same render-in-progress and real source-duration
checks. Companion 0.1.15 was built and installed through the normal setup path.

This follow-up also protects unapplied caption drafts when switching plan views
or closing the page, retains shot selection by ID through reordering/removal,
and synchronizes explicit review-shot selection with the edit panel.

## Live acceptance

Local test project: `9c3e56cc-a146-466b-a1ff-6bc752be2377`,
**Palmier 参考 · 局部编辑实测**.

1. In the real UI, changed the first cue's text and end time together. Revision
   1 → 2 created exactly one undo entry and a two-field receipt. Undo restored
   the entire original content; redo restored the edited content exactly.
2. Through the workbench chat, DeepSeek read the current document and used
   `fantay_movie_edit` to change only `s2-unfurl-caption-1.text` to
   `花瓣舒展，小小生命轻轻走过。`. Revision 4 → 5 added one undo entry.
   Full-content comparison proved all timing, other captions, source clips,
   visual layers, keyframes, camera and style unchanged. The UI reported a
   completed 12-second turn. No render or approval was requested.
3. UI undo/redo and actual `od movie undo` / `od movie redo` restored exact
   before/after content for that AI edit.
4. Changed source in-point, speed and volume together to 2.6s, 0.9× and 0.7.
   The UI displayed one entry with three changes; undo/redo worked. An in-point
   of 999s was rejected without changing the document, and the draft remained
   editable. The valid clip change was then undone.
5. Final revision 15 contains only the two intended caption edits. Two applied
   undo entries remain; one clip change remains available for redo. The original
   delivered garden project `7af171e0-a7b8-4266-adc3-8d1176597c52` was compared
   before/after and is identical, including its delivery and approval records.

The first manual batch used Ego Lite. After the user clarified tool preference,
the remaining UI acceptance used the native Chrome plugin. Desktop and
390×844 layouts were inspected; the viewport override was reset afterward.
No Claude Code call, commit, push or deployment was performed.

## Validation and evidence

- 23 focused backend tests, 17 movie UI tests and 23 companion tests passed.
- Full workspace `pnpm typecheck`, repository `pnpm guard`, whitespace check
  and the UI detector passed. The added UI regression initially failed for
  unprotected plan switching; the added companion regression initially failed
  for full-document saving, and both passed after the fixes.
- `.tmp/movie-edits/verification.json` records exact-content comparisons.
- `.tmp/movie-edits/{baseline,manual-applied,manual-undo,manual-redo,ai-before,ai-after,ai-undo,ai-redo,clip-applied,cli-undo,cli-redo,final-document}.json`
  contains the captured documents. `protected-before.json` and
  `protected-after.json` contain the unchanged delivered project.
- `.tmp/movie-edits/final-desktop.png`, `final-editor.png` and `final-mobile.png`
  show the working UI. `setup-final.json` confirms companion 0.1.15.
- `.tmp/movie-edits/{backend-verified,web-verified,dsh-final,typecheck-verified,guard-final}.log`
  and `design-detector.json` contain verification results.

## Continuation provenance

Nowledge MCP search: query `Fantay Palmier 局部编辑 撤销 重做 DeepSeek`,
requested mode `normal`, returned scope `default` / strict retrieval, no filters.
The relevant first result was `80c9c7a7-83ff-4261-9163-75dab5823cdf`
(Palmier mechanism reference, score 0.99); the remaining results were earlier
original-animation, full-sample, Claude-availability correction and review-flow
records. The preceding session was then read once, messages 150–155 of
`codex-01a17e61-59b7-7771-a210-57f870884d98`, confirming that live local-edit
acceptance had not finished. Current files, tests and captured documents were
used as the authority for this delivery. No new Palmier source was copied.

## Separate global preference update

At the user's explicit request, `/Users/fantasy/.codex/AGENTS.md` now prioritizes
ChatGPT/Codex native tools, native browser capabilities and connected plugins;
external alternatives are fallback choices, and local skill defaults cannot
override that priority. This edits the current Codex global instruction file;
it does not claim to change the separate chatgpt.com account settings.
