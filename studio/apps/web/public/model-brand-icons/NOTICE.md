# Model icon notices

Brand marks in this directory identify the vendor or product line of each model. They remain the property of their trademark owners; showing them does not imply partnership or endorsement. `provenance.json` lists every file with its source URL, SHA-256, licence and any modification.

## LobeHub files (MIT, see `LICENSE`)

From `@lobehub/icons-static-svg@1.95.1`: `openai.svg`, `claude.svg`, `gemini.svg`, `deepseek.svg`, `deepseek-color.svg`, `qwen.svg`, `qwen-color.svg`, `kimi.svg`, `zhipu.svg`, `zhipu-color.svg`, `cogview-color.svg`, `cogvideo-color.svg`, `doubao.svg`, `doubao-color.svg`, `grok.svg`, `meta.svg`, `mistral.svg`, `minimax.svg`, `minimax-color.svg`, `hailuo-color.svg`, `stepfun-color.svg`, `cloudflare-color.svg`, `hunyuan.svg`, `wenxin.svg`, `yi.svg`, `siliconcloud.svg`, `happyhorse.svg` (title metadata corrected from "Hedra" to "HappyHorse").

## Official vendor files (not covered by the MIT licence)

- `tongyi.svg`, `wan.svg`: the Tongyi mark from the header of https://tongyi.aliyun.com/ (retrieved 2026-10-21). Wan uses the same mark on https://wan.video/ and in the official Wan-Video repositories.
- `typesafe.svg`: the official favicon of https://typesafe.ai/ (retrieved 2026-10-21), embedded unchanged in an SVG container.

These are used only to label the vendor's own models. No reuse licence is asserted.

## Rendering

Files ending in `-color.svg`, plus `tongyi.svg`, `wan.svg` and `typesafe.svg`, are full-colour artwork. Show them as they are in both themes. The other files are monochrome `fill="currentColor"` marks (`ModelBrand.mono === true`). An `<img>` paints these black, so tint them on dark backgrounds, for example with a CSS mask or `filter: invert(1)`.
