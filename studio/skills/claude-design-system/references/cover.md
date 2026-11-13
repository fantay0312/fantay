# The cover: preview/cover.html

Every system has one. It is a standalone preview page that the Design System tab shows above the brand book, so a system has a face the moment it opens. It is written last, from what you built. Register it in `manifest.json` `preview.pages` as `{"path": "preview/cover.html", "role": "cover", "title": "Cover"}` only when the project already has a `manifest.json`.

## Shape of the file

A complete HTML document, 960px wide, 240 to 360px tall:

- `<link rel="stylesheet" href="../tokens.css">` so every value resolves from the package tokens.
- One inline `<svg>` plus two text elements (the name and one tagline) over the ground. Nothing else.
- Every fill, stroke and corner radius is a class bound to a token (`.brand { fill: var(--accent) }`, `.tile { rx: var(--radius-lg) }`). No images, no gradients or shadows the tokens do not define.
- The four-line derivation (below) sits as a comment at the top of the SVG.
- No motion, no width or container queries, no `vw` or `cqw` sizes. The page is laid out at 960px and the host scales the whole picture down to fit a narrower frame, so it looks the same at every width.

## The direction: palette and pattern

A cover shows the two things a person remembers a system by, its colors and its shapes, with the name as the figure. All three parts, every time.

1. **Color blocks.** The palette as big solid fields, not chips: three to five blocks in the system's identity colors at full value (brand, accent and signal hues, a deep ink or a dark surface, one tint for relief), together a quarter to a half of the cover. Weight them by identity, not UI frequency: the colors people know the brand by take the big blocks even where the UI spends them sparingly. A neutral-first system leads with its one or two hues. A color that only means a state (error red) stays small. Cut them from the scales: sides are spacing steps or multiples, corners are radius tokens (square for a square system; for a pill or disc set `rx` to half the short side, because an SVG `rx` of 9999px draws an ellipse, not a pill). Arrange them the way the brand composes: a flush modular grid, a staggered stack, one tall slab with satellites, a strip of unequal bands, blocks bleeding off the top or right edge. Never a row of equal squares: that is a swatch table.
2. **One pattern**, over or between the blocks, in block colors (or the ground cut out of a block), picked from what the system says about itself in `DESIGN.md` and the tokens' usage notes:

   | The system is... | Pattern |
   |---|---|
   | soft, friendly, large radii | discs, pills, half-rounds from the radius scale |
   | precise, technical, mono, a 4px grid | a dot or plus grid at one spacing step |
   | editorial, serif, "borders not shadows" | a few hairline rules (the hairline token at its own strength) or a baseline grid crossing the blocks; never a field of rules, never rules without blocks |
   | loud, bold, poster type | stripes, chevrons or a checker at a spacing pitch |
   | geometric, modular, dense UI | tiles cut by the radius tokens, some merged two-wide like the components |
   | a literal motif (lens, wave, leaf, ticket, spark) | arcs, quarter-circles or that silhouette built from radii |
   | a distinctive display or numerals face | one oversized glyph or numeral used as a shape, clipped by a block |

   Shapes, not pictures: no faces, mascots, icons or scenes. Take the row that is most specifically this brand and say why in the derivation; if a generic system would land on the same row and the same arrangement, change the arrangement. Geometry comes from the scales (pitch, gap and radius are tokens); a dozen to sixty units for tiles, dots or pills, three to six rules, never hundreds.
3. **The name** in the display face (one-family systems: the body family at display weight), as large as 120px, line height 0.9 to 0.95 (0.95 or more on two lines), bottom-left on the ground in the ink color, with one tagline line under it at 13 to 14px in the muted color (taken from `DESIGN.md`, or one sentence in the system's voice), the two in a text block at most 440px wide. No other words. The name reads exactly as `DESIGN.md` writes it, same words and same case, breaking only at a space or hyphen it already has (never inside a word), two lines at most. Zone it: pick a size from 120 down to 64px at which the longest line measures 440px or less (fallback faces run up to a fifth wider: count 0.6em a letter for a sans, 0.55 for a serif, 0.62 for a mono); lines x size + tagline + two steps must also fit the height. If it is still wider than 440px at 64px, use the top-band skeleton below. Otherwise every block and pattern unit sits right of x = 480: nothing crosses the name or the tagline, hairlines included.

## Rules

- **Both themes are the same file.** Render the dark theme and look: a block within a few percent of the ground vanishes there. Bind it to another token rather than outlining it.
- **One layout, at 960 x height.** The blocks and pattern sit in one box from x = 480 to the right edge. The one other skeleton is a band of blocks and pattern full-width across the top (96 to 120px tall, about a third of the height, a step clear of the name's cap line), with the name beneath it, sized as in part 3; a name that is here because it was too wide takes the largest size of 64px or less at which its longest line fits 960px minus the text block's left and right insets. Use it for a brand that composes in horizontal strips, and whenever the name is too wide for its zone.
- **Squint test:** the name reads first, then color, then pattern. If the pattern wins, halve its count. **Thumb over the name:** the blocks and pattern alone should say which brand this is. If they could be anyone's, the colors or the row are wrong.
- **Derivation first**, four lines kept as a comment atop the SVG: blocks (tokens x sizes), arrangement, pattern row and the sentence that chose it, the steps and radii used. A blocks, pattern or scales line with no token in it means start over.

## Avoid

The barcode (a field of thin vertical rules tightening toward an edge), the swatch table, confetti (more than five colors or two patterns), the poster (a pattern louder than the name), words on blocks.

Regenerate when the name, palette, display face or scales change, not for smaller edits. A person changes it by asking in chat ("quieter", "more of the green", "use the wave"): revise the file and keep the derivation unless the ask changes it.
