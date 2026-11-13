# Fantay Design Usage

Agent-facing guide for Fantay Design, the formalized form of Open Design's own product UI language.

## Read Order

1. Read this file for the package contract.
2. Read `DESIGN.md` for the principles, color roles, component recipes and the pure-white / pure-black decision. Its §Provenance table maps every token to the product source line.
3. Paste the `:root` block from `tokens.css` into the first artifact `<style>`. Add the `[data-theme="dark"]` block only when the artifact sets `data-theme="dark"`, and keep the reduced-motion block.
4. Use `components.manifest.json` for the compact component inventory. Open `components.html` when exact selectors or states matter.
5. Use `preview/` (colors, typography, spacing, app shell) for a quick visual check.
6. Albert Sans ships in `fonts/` under the SIL OFL 1.1 (`fonts/OFL.txt`). Artifacts reference the family by name; the stack falls back to PingFang SC and Microsoft YaHei.

## Design Highlights

- Monochrome ink on white: ground `#fff`, panels `#fafafa`, trays `#ededed`, hairlines `#dbdbdb`. Ink runs `#202020` / `#494949` / `#5c5c5c` / `#848484`.
- The accent is ink, not a hue. `--accent` (`#353535`) marks selection and focus. The primary CTA is a `#202020` pill (`--fg`) that lightens to `--accent` on hover.
- Rationed brand green: `#87ea5c` and `#00ff08` appear only on the send disc, the switch, success ticks and upgrade pills. The selected assist pill uses `#007106` on `#f2fff2`. Green is never text on white.
- The darkest masses are the user's own actions: user bubble `#121212` (`--accent-active`), send disc and primary pill.
- Albert Sans everywhere, 600 for chrome at 14px / 1.25, 500 for reading text at 13px / 1.7. The hero headline alone switches to Georgia / Songti SC 600 at 32px.
- Tone-grouped, borderless surfaces with concentric 16–20px radii; liquid-glass floating layers; frosted white scrims; warm-black shadows `rgba(28, 27, 26, …)`.
- Motion: `cubic-bezier(0.23, 1, 0.32, 1)`, 200ms in, 140ms out, popovers from scale 0.93.

## Do

- Keep the schema token names exactly; raw literals are limited to the documented brand-green family, `#bdbdbd`, `#1a74ff`, material rgba values and the 2 / 16 / 20px radii.
- Make one black pill the primary action per view, with secondary actions as white hairline pills or grey fills.
- Group content with a `--surface-warm` tray holding a `--bg` card before adding any border.
- Use `--meta` only for 12px+ meta text, and pair semantic colour with a word or icon.
- Give every control a `:focus-visible` treatment from `--focus-ring` (or the `--accent` border on fields).
- Reuse the fixture's buttons, fields, select, segmented control, tabs, cards, dialog, menu, tooltip, tags, toasts, switch, chat bubble and nav rows before inventing a control.

## Avoid

- Avoid any second chromatic accent, brand-green text, green washes or gradients.
- Avoid `#000` ink, dark modal scrims, heavy borders and drop-shadowed cards.
- Avoid weight 400 UI text, uppercase eyebrows, letter-spaced labels and `#848484` / `#bdbdbd` running text.
- Avoid `ease-in`, scale-from-zero entrances and slow hover fades.
- Avoid treating the dark block as product-validated; it is derived from tokens the product never renders.
- Avoid bundling or copying JiduMono Pro (All Rights Reserved); reference it by family name only.
- Avoid editing `components.manifest.json` by hand; regenerate it from `components.html` and `tokens.css`.
