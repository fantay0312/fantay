# Astryx package usage

## Read Order

1. Read `DESIGN.md` for the Neutral theme, intended product context, source boundaries, and accessibility behavior.
2. Read `tokens.css` for the compiled light and dark semantic contract; load it as a stylesheet when the target supports CSS files.
3. Inspect `components.html` and `components.manifest.json` for the normalized component vocabulary. Review the colors, typography, and spacing pages in `preview/`.
4. Read `source/evidence.md` and `source/tokens.source.json` before changing any source-derived values. `fonts/OFL.txt` covers the local Figtree font; `source/LICENSE` covers original Meta excerpts.

## Design Highlights

- Neutral primary actions, Figtree type, a 4px spacing rhythm, and explicit light/dark semantic roles.
- 6px/10px/12px inner/control/container radii; the upstream page role is 28px.
- Fast 125ms and medium 300ms motion, clear focus, compact desktop density, and a narrow coarse-pointer type adaptation.
- Fixed upstream source: `meta/astryx@df15de7fc3941b479d3bfb8d4576a3b3c27bca3d`, Beta. Full source and all seven themes are in the material library.

## Do

Use the shared semantic slots, apply the dark theme selector intentionally, retain local font/license files, and use accessible native controls in composed examples. Preserve status text alongside color. In a target app that needs official Astryx components, follow the pinned core README, use React 19+, and validate real interaction there. This package is available to the existing picker and design-context flow as `astryx`.

## Avoid

Do not confuse this with `meta` (Meta Store), inject React 19 dependencies into Studio's React 18 host, imply all official components were rendered, or promise stable experimental chart/lab packages. Do not assume this normalized fixture is an upstream screenshot. Project layout bindings and simplified hover states are documented adaptations.
