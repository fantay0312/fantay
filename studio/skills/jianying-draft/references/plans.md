# Creation plans

CLI: `od jianying create --project <id> --file <plan.json|-> --json`.
Tool: `fantay_jianying_create` with `{source:"plan",spec:<plan>}`.

```json
{
  "name": "Editable draft",
  "width": 1920,
  "height": 1080,
  "fps": 30,
  "clips": [
    {"type":"video","path":"media/source.mp4","start":0,"sourceStart":1,"duration":4,"speed":1,"volume":0.8,"track":0},
    {"type":"image","path":"media/photo.png","start":4,"duration":2,"track":0},
    {"type":"audio","path":"media/music.wav","start":0,"duration":6,"volume":0.25,"fadeIn":0.2,"fadeOut":0.3,"track":0},
    {"type":"text","text":"Caption","start":0,"duration":3,"subtitle":true,"track":0}
  ]
}
```

All file paths are relative to the current FantayDesign project. They are
validated against the project boundary. The generator copies source media
into the new draft. Images and text need explicit durations.

`duration` is target time; video source consumption is `duration × speed`.
Tracks are independently numbered by video/audio/text, starting at 0 without
gaps. Images use video tracks. Overlap needs separate tracks. Audio creation
currently supports original speed only. Volume is linear 0–1.

Optional `srt:{path:"captions.srt",offset:0,track:0}` preserves subtitle timing.
Optional visual `transform:{x:0,y:0,scaleX:1,scaleY:1,rotation:0,alpha:1,
flipX:false,flipY:false}` uses half-canvas offsets, degrees and opacity 0–1.

Creation returns `draft.id`, `draft.path`, `inspection`, `validation` and
warnings. Keep these IDs; do not infer a path or overwrite a previous output.
