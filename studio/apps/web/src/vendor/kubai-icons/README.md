# Kubai Icons engine (vendored, generated)

`runtime.ts` is the engine (`src/engine.js`) of [Kubai Icons](https://github.com/kubai087/kubai-icons) and the Fantay feature
icon set (`src/icons.js`), joined into one module by `fantay-design/tools/feature-icons/scripts/sync-studio.mjs`. The
source of truth is that folder, outside this repository: it holds the gallery, the self-check and the static exporter.
Edit the icons there, check them, then run the script; never edit `runtime.ts` by hand.

- Licence: the Kubai Icons License (`LICENSE`), source-available, not open source. It allows shipping the engine and
  icons inside the product with the copyright notice kept at the top of the file; it does not allow redistributing the
  example icons on their own as an icon set, or shipping the skill's PROMPT.md / SKILL.md.
- Differences from upstream (marked `Fantay:` in the engine): `tint()` gives a neutral grey accent the same amt on
  every channel, so deep marks stay grey; a palette may give one colour for every icon, may be flat (`flat`,
  painted by `paintFlat()`: one colour per kind of part, no gradients, shadow or top glow) and may be drawn as lines
  (`line`, painted by `paintLines()`: outline width, inside strokes on white content, a blend that lets the fills
  take on the surface behind); `recolor()` repaints an icon in the current palette at once. `FANTAY_INK` holds the
  light and dark line inks that `feature-icon.tsx` switches with `<html data-theme>`; `FANTAY_SOLID` the earlier
  black-and-white inks. The icon set holds 17 upstream examples, unchanged but for `data-line` hints that only line
  palettes read and the alarm clock's hover (its hands run on an hour instead of the clock ringing), and 8 icons
  drawn for Fantay.
- `// @ts-nocheck` because the engine is plain JavaScript with no types.

The React wrapper and the feature → icon table are in `src/fantay/ui/feature-icon.tsx`.
