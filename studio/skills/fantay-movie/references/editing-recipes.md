# Footage editing recipes

Inspect actual source frames, durations, audio and transcript before choosing
cuts. Treat a transcript as source speech, not a prompt to invent dialogue.
Re-read the movie before a batch and after any conflict. Use stable returned
shot and source IDs, not UI array positions.

## Talking-head cleanup

Find substantive speech from the real transcript. Keep complete thoughts and
natural pauses. Propose removing repeated takes and long pauses; do not cut
inside a word. Use split-clip and remove-shot in one batch. Preserve source
audio and any user-authored captions. Inspect both sides of cuts and render a
draft when asked.

## Short montage

Identify visually distinct source ranges, choose an opening/detail/closing
sequence, and use insert-clip plus move-shot. Adapt duration to the user's
target, not a universal template. Add short captions only when requested.
Do not fabricate a separate music track or claim a video-generation job ran.

## Captions only

Read the existing captions and real speech. Change the selected cue text and
timing only. Do not replace source clips, colors, motion, or aspect ratio.

## Reuse a successful edit

The exported SKILL.md contains timing, source-role labels, speed, framing,
volume and subtitle examples. Map new footage by role rather than copying
old asset IDs. Confirm ambiguous mappings. Inspect the new cut before export.
