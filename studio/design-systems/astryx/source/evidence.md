# Astryx integration evidence

Archived on 2026-11-06 from [meta/astryx](https://github.com/meta/astryx) at [df15de7fc3941b479d3bfb8d4576a3b3c27bca3d](https://github.com/meta/astryx/commit/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d). The complete fixed-commit source snapshot and file hashes are preserved in the FantayDesign material library, entry `astryx`.

## Owning sources

- [Neutral theme](https://github.com/meta/astryx/blob/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d/packages/themes/neutral/src/neutralTheme.ts): surface/text/accent/status pairs, Figtree, base 14 and ratio 1.2, coarse-pointer adaptation, 125/300ms motion, radii and shadows. Unchanged excerpt: `neutralTheme.ts`.
- [Neutral generated palette](https://github.com/meta/astryx/blob/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d/packages/themes/neutral/src/neutralPalettes.generated.ts): exact neutral hex values. Unchanged excerpt: `neutralPalettes.generated.ts`.
- [Core defaults](https://github.com/meta/astryx/blob/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d/packages/core/src/theme/tokens.stylex.ts): rem spacing and standard easing. Unchanged excerpt: `tokens.stylex.ts`.
- [Core usage](https://github.com/meta/astryx/blob/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d/packages/core/README.md): React 19+ and CSS/theme integration. Unchanged excerpt: `core-README.md`.
- [Original MIT license](https://github.com/meta/astryx/blob/df15de7fc3941b479d3bfb8d4576a3b3c27bca3d/LICENSE): unchanged local `LICENSE`.
- [Figtree font source](https://github.com/google/fonts/tree/main/ofl/figtree): local `../fonts/Figtree.ttf` and `../fonts/OFL.txt`, SIL OFL 1.1. The font is preserved separately from Astryx's upstream snapshot.

## Normalization decisions

This is a curated `bundled`, `normalized` package, following the project's Cloudflare Kumo precedent. The default is Neutral; no corporate Meta blue is substituted for Neutral's near-black action fill. `tokens.source.json` records bindings and source-file checksums.

Exact source colors include body neutral 95/10, surface 100/15, text 0/100 and 30/65, accent 10/95, and source status fills. 4px spacing at a 16px root, 6/10/12px radii, low shadows and standard easing follow source roles. Type steps are rounded from base 14 × 1.2; 12px is used for both shared small slots. Body leading 1.5 and heading leading 1.2 are normalized choices. Layout width, gutters, section rhythm, focus-ring rendering, and adjacent-step hover/pressed fills are compatibility decisions, not universal upstream requirements.

## Verified scope

The HTML component fixture demonstrates normalized tokens and native browser behavior. It is not an upstream screenshot or a build of official React components. The Studio host uses React 18; no React version or app dependencies were changed. Upstream is Beta; seven theme sources are archived, only Neutral is mapped here; lab is unpublished and charts/vega are canary-only. The existing `meta` Meta Store package remains separate.
