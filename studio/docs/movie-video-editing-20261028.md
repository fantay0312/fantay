# Real footage editing in Fantay — 2026-10-28

## Behavior

The home animation workspace now offers Code animation / Video editing. Video editing uses the existing Library asset registry, with a video-only picker and a bounded binary upload route for MP4/MOV/WebM (256 MiB). Selected files are copied through the existing project-apply API, hash-verified, and registered in the film before any production authorization is created. The external reference archive remains read-only.

`MovieShot.clip` names an imported asset plus source in-point, rate, volume and fit. `duration` remains output time. Source out-point is `in + duration * rate`; actual media probing rejects source overruns. The renderer pre-trims and normalizes clips with FFmpeg, so frame capture and audio muxing use the same media clock. Slow motion uses `atempo` for voice pitch preservation. Original source audio opts out of the music renderer's per-track fade-out, avoiding lost words at shot cuts.

`MovieShot.captions` stores ordered local-time cues, separately from headings/body copy. Shared HTML previews and exported MP4s use those cues. Delivery includes an SRT sidecar. The same visual layer and camera system supplies overlays, labels, highlights and transitions above full-frame footage.

Source inspection supplies actual frames, duration, dimensions, frame rate, audio availability and cached transcripts. Local Whisper transcription uses the multilingual small model, with explicit language or detection. Its normalized array output and raw segment format are both supported. No reliable speech produces an error; the application does not invent a transcript. AI-written explanatory captions remain an explicit separate use.

CLI: `od movie upload-video --file`, `import-video --asset`, `sources`, `transcribe --asset --language`. MCP: `import_movie_video`, `get_movie_sources`, `transcribe_movie_source`. DeepSeek: `fantay_movie_sources`, `fantay_movie_transcribe`, existing author/preview/produce/wait. Production and final approval permissions are unchanged; models cannot grant themselves production or final approval.

## Acceptance source

Public flower footage: https://developer.mozilla.org/shared-assets/videos/flower.mp4 (the example linked by MDN's HTML video documentation). A clearly named local test source adds a synthetic Chinese test narration and repeats the short footage to exercise speech, timing and source audio. It is test material, not claimed to be an unmodified recording.

Workspace project: `7af171e0-a7b8-4266-adc3-8d1176597c52`, 花园里的小世界 · 实拍剪辑.

From the real home UI: uploaded the video into Library, selected it, entered a single brief and used DeepSeek Harness 0.1.13. The model inspected source frames, invoked local transcription, authored four cuts (10.3s total, including 0.55× speed), timed simplified-Chinese captions and animated overlays, and inspected real rendered samples.

The first export exposed an invalid motion-audio policy value. Corrected it to the existing `required` contract and added regression coverage. The saved AI-authored plan was retained; the UI retry produced `122c94cf-473b-4272-b6a0-57b567ecf2f1`. Re-transcribing that MP4 recovered the source narration, including the slow-motion section.

The review test selected the 0–2.5s range and requested two opening subtitle cues: 0.10–0.90s and 1.00–2.40s. It also exposed a reverse-seek bug in GSAP caption tweens. Captions now derive visibility from the absolute playhead time; forward/backward seeking has a real-GSAP regression test. The preview cache was advanced to `motion-scenes-v7`.

DeepSeek continued the same authorized review batch and produced render `7feb9983-c979-4beb-a9c2-bb9118cfd028`. The result is 10.3 seconds, 1920×1080, 30fps, with real source audio. Document comparison proved all source cuts, rates, volume, visual layers and other shots unchanged. Frame extraction at 0.50s, 0.96s and 1.50s verified first cue, intentional blank interval, and second cue. Decoded audio PCM was byte-identical before/after the subtitle revision.

The review note was confirmed in the UI, then the current render was approved and the delivery ZIP was generated and actually downloaded through the page. The 17-entry ZIP contains the matching final MP4, SRT, editable HTML, media, project and review data. MP4 hash and SRT timing were verified against the final files. Desktop 1600×1100 and narrow 390×844 layouts were checked.

Validation: 61 movie/audio backend tests (including the two cache tests rerun after updating their cache version), 16 movie UI tests, and 22 Harness tests passed. Web and daemon source/test types, project guard and whitespace checks passed; the frontend detector reported no findings. No Claude Code calls, commits, pushes or deployment.

Artifacts: `.tmp/movie-video/final-film.mp4`, `captions.srt`, `delivery.zip`, `delivered-document.json`, `final-review.png`, `delivery.png`, `mobile-delivery.png`, plus the source, before/after documents and verification logs. The actual browser download is `/Users/fantasy/Downloads/fantay-movie.zip`.
