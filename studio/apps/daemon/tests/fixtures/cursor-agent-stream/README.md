# cursor-agent stream recordings

`turn-all-tools.jsonl` is two real `cursor-agent --print --output-format stream-json
--stream-partial-output` runs (CLI 2026.10.22-27dcf5f) joined into one file. Only local
paths and request ids were rewritten. Assert Cursor stream behavior against this file,
not against hand-built frames.
