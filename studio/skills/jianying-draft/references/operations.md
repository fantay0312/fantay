# Copy-preserving edits

CLI file contains an operation array. The tool/API envelope contains
`{draftId,name?,operations:[...]}`. Use exact IDs returned by inspect.

| Operation | Fields | Meaning |
| --- | --- | --- |
| `add` | `clip` | Add a creation-plan clip |
| `import_srt` | `path,offset?,track?` | Add timed captions from a project SRT |
| `move` | `segmentId,start,trackId?` | Absolute target start; existing compatible track |
| `trim` | `segmentId,duration,sourceStart?` | Target duration, optional source offset |
| `split` | `segmentId,at` | Absolute target time inside the segment |
| `delete` | `segmentId,ripple?` | Default leaves a gap; ripple rejects intersecting clips |
| `set_speed` | `segmentId,speed` | Preserve consumed source and change target duration |
| `set_volume` | `segmentId,volume` | Linear 0–1 |
| `set_text` | `segmentId,text` | Direct text materials; complex style remapping may be refused |
| `transform` | `segmentId,transform` | The creation-plan visual transform fields |
| `replace_media` | `segmentId,path` | Project media, preserving target placement and checking bounds |

```json
[
  {"op":"split","segmentId":"ID_FROM_INSPECT","at":2},
  {"op":"set_volume","segmentId":"ID_FROM_INSPECT","volume":0.3},
  {"op":"set_text","segmentId":"TEXT_ID_FROM_INSPECT","text":"Corrected caption"}
]
```

The batch is applied to a new copy and validated before publication. The
source is never overwritten. Unknown fields and indirectly referenced
materials are preserved. Same-track overlap, invalid source ranges, global
keyframe/group dependencies, multi-timeline projects and cloud links may be
refused. Do not remove such data or force a fallback to make the call succeed.

Every successful edit returns a new draft ID. Re-inspect before the next
batch, especially after split, add, replacing media or changing shared text.
