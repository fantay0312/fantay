# Fantay Design

> Category: Starter
> Open Design's own product UI language, formalized: monochrome ink on white, a rationed neon-green signal, black pill CTAs, tone-grouped borderless surfaces, liquid-glass floating layers, Albert Sans at 600, and quick ease-out motion.

## Visual Theme & Principles

Fantay Design is the look of the Open Design workspace itself, written down as a reusable system. Values are read off the product UI (`apps/web/src/styles/tokens.css`, `base.css`, `material.css` and the shared primitives), and the §Provenance table cites each source line. The few things the product does not define (section rhythm, the pressed accent step, field-label and status-pill recipes, the dark theme) are marked as derived and built only from product steps. The interface reads like dark ink on white paper. It is quiet, dense and fast, and its single burst of colour is spent sparingly.

1. **Monochrome ink on white.** Almost everything is drawn from one grey ladder: ground `#fff`, panels `#fafafa`, trays `#ededed`, hairlines `#dbdbdb`; ink `#202020`, running text `#494949`, muted `#5c5c5c`, meta `#848484`. Even the accent is a near-black grey (`#353535`), not a hue.
2. **Rationed neon green.** One green family is the brand signature, and it only appears where something is *on*, *sent* or *chosen*: the send disc's glyph, the switch track, the selected assist pill, success ticks, the upgrade pill. It never becomes text, a background wash or a decorative gradient.
3. **Black pill primary CTA.** The main action on a screen is a `#202020` pill with white text. Secondary actions are white pills with a hairline, or quiet grey fills.
4. **The darkest masses are the user's own actions.** The user's chat bubble (`#121212`), the send disc, the primary pill and the selected navigation label are the darkest things on screen. System output stays lighter (`#494949` prose, no bubble).
5. **Tone-grouped, borderless surfaces with concentric radii.** Grouping comes from tone (a `#ededed` tray holding a `#fff` card), not from strokes. Large containers use 16–20px radii that nest concentrically: a 20px tray with 4px padding holds a 16px card.
6. **Liquid-glass floating layers.** Menus and floating panels are translucent `#fafafa` (66%) with a 28px blur and extra saturation. Modal scrims are frosted *white*, never a dark veil. Tooltips are the deliberate exception: they stay solid.
7. **Quick, decisive motion.** Entrances take ~200ms, exits ~140ms, both on a strong ease-out (`cubic-bezier(0.23, 1, 0.32, 1)`). Hover colour changes are near-instant, popovers grow from 0.93 scale, and nothing animates from zero scale or uses ease-in.

## Color Palette & Roles

### Core swatches

- **Background**: `#fff` — page ground (`--bg`)
- **Foreground**: `#202020` — strong ink and titles (`--fg`)
- **Accent**: `#353535` — selection, focus borders, CTA hover (`--accent`)
- **Border**: `#dbdbdb` — hairlines and control edges (`--border`)
- **Surface**: `#fafafa` — panels, fields, dialogs (`--surface`)
- **Muted**: `#5c5c5c` — secondary labels (`--muted`)
- **Primary CTA**: `#202020` — the black pill fill, with a `#fff` label (`--fg` on `--bg`)

### Neutral ladder

| Role | Token | Value | Use |
| --- | --- | --- | --- |
| Ground | `--bg` | `#fff` | Page, cards inside trays, the composer card |
| Panel | `--surface` | `#fafafa` | Inputs, dialogs, tooltips, active segment, active tab |
| Tray | `--surface-warm` | `#ededed` | Composer tray, segmented track, quiet button fill, tag fill. Neutral, despite the slot name |
| Hairline | `--border` | `#dbdbdb` | Control edges; also the "muted fill" step (hover on grey fills) |
| Soft hairline | `--border-soft` | `#ededed` | Menu edges, inner separators |
| Strong ink | `--fg` | `#202020` | Titles, emphasized labels, primary pill, toasts |
| Running text | `--fg-2` | `#494949` | Default body and control text |
| Muted ink | `--muted` | `#5c5c5c` | Secondary labels, inactive tabs, unselected nav rows |
| Meta ink | `--meta` | `#848484` | Timestamps, counts, captions at 12px+ |
| Accent ink | `--accent` | `#353535` | Selected option, focused input border, primary hover |
| Darkest ink | `--accent-active` | `#121212` | Pressed accent, user chat bubble, selected nav label, hero headline |
| Accent label | `--accent-on` | `#fafafa` | Text on an `--accent` fill |

Product literals with no schema slot, used only where named in §Components:

- Strong border / faint text `#bdbdbd`: hover edges, placeholder, disabled label, switch-off track. It is decorative and disabled-state only.
- Selected border `#a3a3a3` (product `--border-selected`).
- Translucent fills: `rgba(0, 0, 0, 0.03 / 0.06 / 0.12)` (product `--bg-fill-*`) and vibrancy fills `rgba(73, 73, 73, 0.08 / 0.14 / 0.2)`.

### Brand green family (rationed)

The shared token schema has no brand slot and this package adds no brand extensions, so the green family is a set of documented literals. Use them only in the places listed; three or fewer green moments per screen.

| Name | Value | Where it appears | Rule |
| --- | --- | --- | --- |
| Brand green | `#87ea5c` | Switch "on" track, active-run orb, brand dots | Fill only; 1.50:1 on `#fff`, never text |
| Signal green | `#00ff08` | Send disc glyph, success tick glyph, upgrade pill ground | Only as a glyph on a `#202020` disc (11.9:1) or as a ground under `#121212` ink (13.7:1) |
| Brand ink | `#007106` | Selected assist pill label and its 22% inset ring | Text on brand surface (6.05:1) |
| Brand surface | `#f2fff2` | Selected assist pill / chip ground | Always paired with brand ink |
| Brand text | `#0d5400` | Deep green text where green must be read | 8.91:1 on brand surface |
| Brand weak / soft | `#d0ffb5` / `#ebffde` | Tints behind brand moments | Background tint only |

Never set brand green (`#87ea5c` or `#00ff08`) as text on white. When a green label is needed, use the deep ink on the green surface: `#007106` on `#f2fff2`.

### Semantic

| Role | Token | Value | Product pair |
| --- | --- | --- | --- |
| Success | `--success` | `#00aa54` | tint `#f5ffee`, edge `#adf788` |
| Warning | `--warn` | `#ff7528` | tint `color-mix(in srgb, #FFBA12 18%, #fafafa)` |
| Danger | `--danger` | `#f04142` | tint `color-mix(in srgb, #F04142 10%, #fafafa)`, edge 24% |
| Info (literal) | none | `#1a74ff` | tint `color-mix(in srgb, #1A74FF 10%, #fafafa)`, edge 24% |

Semantic hues mark icons, dots, badges and fills. Their labels stay in ink. On `#fff`, success is 3.05:1, danger 3.79:1, info 4.21:1 and warning 2.68:1, so none of them carries body text. A danger count badge uses white 9px/700 text on `#f04142` (3.79:1), acceptable only because it is a short numeric badge; for anything longer, put the label in ink beside a coloured dot.

### Contrast notes (measured, WCAG 2.x)

| Pair | Ratio | Verdict |
| --- | --- | --- |
| `#202020` on `#fff` | 16.29:1 | Any text |
| `#494949` on `#fff` | 9.00:1 | Any text |
| `#5c5c5c` on `#fff` | 6.69:1 | Any text |
| `#5c5c5c` on `#ededed` | 5.71:1 | Any text (tray labels) |
| `#848484` on `#fff` | 3.74:1 | Meta and large text only, never running text |
| `#848484` on `#ededed` | 3.19:1 | Large text only |
| `#bdbdbd` on `#fff` | 1.88:1 | Decorative or disabled only |
| `#dbdbdb` on `#fff` | 1.38:1 | Grouping hairline, not a control boundary |
| `#fff` on `#202020` | 16.29:1 | Primary pill label |
| `#fff` on `#121212` | 18.73:1 | User bubble |
| `#007106` on `#f2fff2` | 6.05:1 | Selected assist label |
| `#1a74ff` on `#fff` | 4.21:1 | Focus ring (needs 3:1) |

### Pure white and pure black

`craft/color.md` says to avoid pure black and pure white. Fantay keeps the product's `#fff` ground: it is the product's real canvas, and its grey ladder is tuned against it (`#fafafa` panels are only visible because the ground is white). Fantay never uses `#000` for ink, though. The darkest ink is `#121212` (`--accent-active`). The product's home hero paints its headline `#000`; Fantay deliberately softens that one literal to `#121212`.

## Typography

### Font stacks

- **Display font**: `"Albert Sans", "PingFang SC", "Microsoft YaHei", sans-serif`
- **Body font**: `"Albert Sans", "PingFang SC", "Microsoft YaHei", sans-serif`
- **Mono font**: `"JiduMono Pro", ui-monospace, "SFMono-Regular", "SF Mono", "JetBrains Mono", Menlo, Monaco, Consolas, monospace`

### Families

- **Albert Sans** for every role, display included; the product binds its own `--serif` to the same sans stack, and PingFang SC / Microsoft YaHei carry Chinese. The package bundles Albert Sans as a variable font (`fonts/AlbertSans-VariableFont_wght.ttf` and `fonts/AlbertSans-Italic-VariableFont_wght.ttf`, weight 100–900) under the SIL Open Font License 1.1 (`fonts/OFL.txt`). Declare it with `font-weight: 100 900`.
- **JiduMono Pro** is a proprietary CoType face (All Rights Reserved). It is named first in the mono stack, so it renders where it is installed, and it is never bundled or copied. Mono text uses `font-variant-numeric: tabular-nums`.
- **Hero headline:** `Georgia, "Songti SC", STSong, SimSun, serif`, weight 600, 32px, line-height 1.24, tracking `-0.02em`, ink `#121212`, centred. This is the product's home hero and the only serif in the system. It is a component-level literal: Georgia is a system font and is not bundled. The Song faces are what make Chinese headlines read as serif.

### Weights

The product uses a 500 / 600 / 700 ladder.

- **600 is the default** for UI chrome: labels, buttons, rows, titles, tabs and inputs.
- **500 is for reading text:** chat and prose bodies, tooltips, descriptions you read rather than scan.
- **700 is for tiny numerics only**, such as count badges.
- **Never use 400** for UI text. The product reserves it for font metadata.

### Scale

| Token | Size | Use |
| --- | --- | --- |
| `--text-xs` | 12px | Meta, tags, small buttons, tooltips, toasts |
| `--text-sm` | 13px | Chat and prose body, menu options, nav labels, dialog descriptions |
| `--text-base` | 14px | UI default: body chrome, buttons, inputs |
| `--text-lg` | 16px | Lead lines, small section heads |
| `--text-xl` | 20px | Dialog titles, page titles |
| `--text-2xl` | 24px | Section titles |
| `--text-3xl` | 32px | Hero headline |
| `--text-4xl` | 48px | Display (rare; marketing-scale only) |

The full product ladder is 12 · 13 · 14 · 16 · 18 · 20 · 24 · 28 · 32 · 36 · 48 · 52 · 64. Off-token steps such as 18px and 28px are allowed as literals when a layout needs them.

### Leading and tracking

- **UI chrome:** `--leading-tight` (1.25), the product's `line-height: 125%` on `body`. Headings also use 1.25.
- **Reading text:** `--leading-body` (1.7), the product's prose and chat line-height. Code blocks use 1.65.
- **Tracking:** 0 everywhere except display sizes (`--tracking-display`, `-0.02em`, at 32px and above).
- **Case:** sentence case. No uppercase eyebrows, no letter-spaced labels.

## Spacing, Radius & Elevation

### Spacing

The product spacing ladder is 2 · 4 · 6 · 8 · 10 · 12 · 16 · 18 · 20 · 22 · 24 · 28 · 32 · 36 · 38 · 42 · 48 · 52 · 58 · 62 · 68. The schema steps map onto it directly: `--space-1` 4 · `--space-2` 8 · `--space-3` 12 · `--space-4` 16 · `--space-5` 20 · `--space-6` 24 · `--space-8` 32 · `--space-12` 48. The in-between steps (6, 10, 22) are real product values and may be used as literals in component internals, for example 6px menu padding, 10px input padding and 22px dialog padding.

Section rhythm (`--section-y-desktop/tablet/phone` = 48 / 32 / 24) is a derived binding. The product is an app with no marketing sections, so these steps come from its column run-out (48px) and spacing ladder.

### Radius

| Radius | Value | Use |
| --- | --- | --- |
| literal | 2px | Inline code, micro chips |
| `--radius-sm` | 4px | Inputs, select trigger and menu, default and icon buttons, toast |
| `--radius-md` | 8px | Tooltips, segmented control, menus and popovers, tab top corners |
| `--radius-lg` | 12px | Dialogs, nav rail rows, chat bubble corners |
| literal | 16px | Cards: home content card, composer card, memory card |
| literal | 20px | Trays that hold a 16px card with 4px padding (the composer tray) |
| `--radius-pill` | 999px | Primary and secondary buttons, small buttons, tags, switch, send disc |

Fantay radius tokens keep the product's own names and values (`--radius-sm` 4, `--radius-md` 8, `--radius-lg` 12, `--radius-pill` 999). The product's comments call literals like 6px, 9px and 10px drift, so Fantay snaps menus to 8px and menu rows to 4px. Nested corners are concentric: outer radius = inner radius + the gap between them.

### Elevation and materials

- **Flat (`--elev-flat`):** the default. Most surfaces separate by tone only.
- **Ring (`--elev-ring`):** `0 0 0 1px var(--border)`, for edges that must not shift layout.
- **Raised (`--elev-raised`):** the product's `--shadow-md`, `0 6px 24px rgba(28, 27, 26, 0.07), 0 2px 6px rgba(28, 27, 26, 0.04)`. Use it for menus, popovers, tooltips and toasts.
- **Card whisper (literal):** `--shadow-sm`, `0 1px 2px rgba(28, 27, 26, 0.05), 0 1px 3px rgba(28, 27, 26, 0.04)`. Use it on the glass content card.
- **Modal (literal):** `--shadow-lg`, `0 24px 60px rgba(28, 27, 26, 0.16), 0 8px 16px rgba(28, 27, 26, 0.07)`. Use it on dialogs and the glass select menu.

All shadows use a faint warm black, `rgba(28, 27, 26, a)`; never use neutral `rgba(0,0,0,…)` for elevation in light mode.

The product's liquid-glass materials:

- **Glass regular:** `rgba(250, 250, 250, 0.66)` with `backdrop-filter: blur(28px) saturate(1.8)`. Use it for floating functional layers such as the select menu and toolbars. Edge: `1px solid rgba(73, 73, 73, 0.18)`.
- **Material thin:** `rgba(250, 250, 250, 0.6)` with `blur(16px) saturate(1.6)`. The home content card uses `rgba(255, 255, 255, 0.85)` with the same blur and an inset `0 0 0 1px rgba(255, 255, 255, 0.18)` rim.
- **Scrim:** `rgba(255, 255, 255, 0.6)` with `blur(50px)`, a frosted white veil behind dialogs. Image lightboxes are the only dark-scrim exception.
- **Fallback:** under `prefers-reduced-transparency: reduce`, or without `backdrop-filter` support, every material becomes solid `--surface` (`#fafafa`).

## Motion

- **Easing:** `--ease-standard` = `cubic-bezier(0.23, 1, 0.32, 1)`, a strong ease-out, for entrances, exits and state changes. Never use `ease-in` on UI.
- **Durations:** `--motion-base` (200ms) for entrances and general state changes; `--motion-fast` (140ms) for exits, collapses and micro-states. Exits are faster because the user has already decided.
- **Hover feedback:** button background, border and colour shifts run at 50ms, which reads as instant. The press is a `translateY(1px)` nudge over 100ms.
- **Popover entrance:** from `opacity: 0; transform: scale(0.93) translateY(-3px)` to rest over 140ms. Never start from `scale(0)`; 0.9 is the floor.
- **Dialog:** the backdrop fades over 150ms; the panel pops from `scale(0.97)` over 250ms on a decelerate curve.
- **Toast:** enters 200ms from `translateY(-6px)` and leaves 140ms, both on `--ease-standard`.
- **Tab glide indicator:** 300ms on `cubic-bezier(0.32, 1.28, 0.36, 1)`, the one sanctioned overshoot.
- **Switch:** the knob travels 16px over 200ms.
- **Disclosure:** expand and collapse with `grid-template-rows: 0fr → 1fr` and an opacity fade. Keep conditional elements mounted and toggle a class, so exits can animate.
- **Reduced motion:** the tokens collapse to 0.01ms, matching the product, which also collapses every animation and transition duration to 0.01ms. Information must never depend on motion.

## Components

Recipes are the product's own values unless marked *derived*. `components.html` renders each one with the tokens.

### Buttons

| Variant | Recipe |
| --- | --- |
| Primary | Pill (`--radius-pill`), fill `--fg` (#202020), label `--bg`, no border. Hover lightens to `--accent` (#353535); active lightens to `--fg-2` (#494949) and nudges down 1px. One per view. |
| Secondary | Pill, fill `--bg`, 1px `--border`, label `--fg-2`. Hover: edge `#bdbdbd`, label `--fg`. |
| Default | 4px radius (`--radius-sm`), transparent fill, 1px `--border`, label `--fg-2`. Hover: fill `--surface-warm`, edge `#bdbdbd`. |
| Subtle | 4px radius, fill `--surface-warm` (#ededed), label `--fg`, no border. Hover: fill `#dbdbdb` (`--border` value); active: `#bdbdbd`. |
| Ghost | Transparent, no border. Hover `--surface-warm`, active `#dbdbdb`. |
| Danger confirm | Only as the confirm action of a destructive dialog: `--danger` fill, `#fff` label, hover `filter: brightness(0.95)`. The label is 3.79:1, so keep it short and let the dialog title carry the meaning. Elsewhere a destructive action is a menu row or default button with a `--danger` icon. |
| Disabled | Fill `--surface-warm`, label `#bdbdbd`, `cursor: not-allowed`, no transform. |

**Sizes**

- **Default:** 36px tall, `0 16px` padding, 14px/600, 8px gap.
- **Small (`sm`):** content height (about 26px), `4px 11px` padding, 12px/600, always a pill, 6px gap, 11px icons.
- **Icon:** 36×36, 4px radius, centred glyph.
- **Send disc:** 28×28 pill, `#202020` fill with a `#00ff08` arrow glyph; hover lightens the disc to `--fg-2`, press nudges it 1px. Background and transform move over 140ms on `--ease-standard`.

Focus on every button is `box-shadow: var(--focus-ring)`: a 1px `#1a74ff` ring held 2px off the edge, the product's outline rendered as a shadow.

### Inputs and textarea

- **Shape:** `--surface` fill, 1px `--border`, 4px radius, `8px 10px` padding. The font is inherited (14px/600, `--fg-2`); placeholder `#bdbdbd`.
- **Focus:** the border turns `--accent` (#353535, 8.86:1 against the old edge). There is no glow ring.
- **Label (derived):** above the field, 13px/600 `--fg-2`. Helper text 12px/500 `--muted`. Error: `--danger` icon and edge, message in ink.

### Select menu

- **Trigger:** min-height 36px, `7px 10px` padding, `--surface` fill, 1px `--border`, 4px radius, chevron in `--muted`.
- **Trigger states:** hover or open gives fill `--surface-warm` and edge `#bdbdbd`. Focus or open gives an `--accent` border plus a `0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)` halo. The chevron rotates 180° on open.
- **Menu:** glass regular (`rgba(250, 250, 250, 0.66)`, `blur(28px) saturate(1.8)`), 1px `rgba(73, 73, 73, 0.18)` edge, 4px radius, 4px padding, modal shadow.
- **Options:** min-height 30px, `6px 8px` padding, 13px, 4px radius. Hover `rgba(73, 73, 73, 0.14)`.
- **Selected option:** `color-mix(in srgb, var(--accent) 9%, var(--surface-warm))` at weight 600, with a check in `--accent`.

### Segmented control

- **Track:** `--surface-warm`, 1px `--border`, 8px radius, clipped.
- **Segments:** `8px 14px` padding, label `--muted`.
- **Active segment:** fill `--surface`, label `--fg-2`. There is no pill thumb and no shadow.

### Tabs

- **Workspace tabs:** sit on a 44px chrome bar with a `--bg` ground and no bottom hairline. Each tab is 34px tall and 96px wide (shrinking to 56px), with top corners `8px 9px 0 0` and a 13px/600 label in `--muted`.
- **Tab states:** hover gives `color-mix(in srgb, var(--fg-2) 5%, transparent)`. Active gives fill `--surface`, label `--fg`, a 72% hairline whose bottom edge merges into the panel, and an inset top sheen of `0 -1px 0 rgba(255, 255, 255, 0.68)`.
- **Glide pill:** slides under the active tab (300ms overshoot).
- **Content tabs:** inside panels, use the segmented control rather than underlines.

### Cards and trays

- **Tray:** `--surface-warm` (#ededed), 20px radius, padding `4px 4px 8px`, max 820px. It holds a white card.
- **Card in a tray:** `--bg` (#fff), 16px radius, 15px padding plus a 1px transparent stroke, no shadow, max 720px. On focus the stroke can darken.
- **Glass content card:** `rgba(255, 255, 255, 0.85)` with `blur(16px) saturate(1.6)`, 16px radius, card whisper shadow plus an inset 1px white rim. This is the home content column.
- **Panel card:** `--surface`, 16px radius, no border (the memory fold card).
- **Project tiles:** have no surface of their own. The 16px radius only shapes the media and the selection ring.

### Dialog

- **Backdrop:** frosted white scrim, z-index 1500.
- **Panel:** `--surface`, 12px radius (`--radius-lg`), 22px padding, 520px wide (max `100vw - 32px`), 12px gap, modal shadow.
- **Text:** title 20px/600 `--fg-2`; description 13px/1.25 `--muted`.
- **Actions:** right-aligned. Primary pill last, secondary or default before it. The sectioned variant adds a footer with a 1px `--border` (#dbdbdb) top edge.

### Menus and popovers

- **Shape:** opaque `--bg`, 1px `--border-soft` edge, 8px radius, 6px padding, 2px row gap, raised shadow. Width 160px for action menus, up to 340px for launchers.
- **Rows:** `8px 10px` padding, 4px radius, 13px/600 `--fg-2` with an optional 16px icon; hover `--surface-warm`. A destructive row takes a `--danger` label and a `color-mix(in srgb, var(--danger) 12%, transparent)` hover; pair it with an icon, because `#f04142` is 3.79:1 as text.
- **Motion:** popovers enter at scale 0.93 (see §Motion).
- **Glass:** menus that float over content (select menu, toolbars) use glass regular; menus anchored to chrome stay opaque.

### Tooltip

- **Surface:** solid `--surface`, not glass, so it stays legible over any content. 1px `--border`, 8px radius, `5px 9px` padding, raised shadow.
- **Text:** 12px/500/1.4 in `--fg`.
- **Size and layer:** max width `min(260px, 100vw - 16px)`; wraps instead of truncating; z-index 4000 (below menus at 9000).
- **Fade:** opacity over 100ms. The tooltip never takes pointer events.

### Tags and badges

- **Tag:** pill, `1px 7px` padding, 12px/600/1.5, tracking `0.01em`, `--surface-warm` fill, `--muted` label, 1px `--border`.
- **Selected assist pill:** `#f2fff2` ground, `#007106` label, inset `0 0 0 1px color-mix(in srgb, #007106 22%, transparent)` ring. This is the green moment for "chosen".
- **Status pill (derived from the product's tint pairs):** tinted ground (for example success `#f5ffee` with a `#adf788` edge), a coloured 6px dot, and the label in `--fg-2`.
- **Count badge:** 15px tall pill (min width 15px, `0 4px`), `--danger` fill, 9px/700 white numerals, 2px `--bg` ring.
- **Kbd (derived):** mono 12px, `--surface-warm` fill, 1px `--border`, 4px radius, `0 5px` padding.
- **Inline code:** mono at 0.92em, `--surface-warm` fill, 2px radius.

### Toasts

- **Feedback toast:** a `#202020` (`--fg`) pill with a `--bg` label at 12px/18px, `10px 16px` padding, max `min(560px, 100vw - 32px)`. It is fixed 64px from the top, centred, at z-index 1800, with a raised shadow. Motion: 200ms in, 140ms out.
- **Inline toast:** `--fg` fill, `--bg` label, 4px radius, `9px 10px` padding, 12px, modal shadow. It sits at the panel's bottom right.
- **Colour:** toasts are ink, not coloured. State goes in an icon (signal-green tick, `--danger` glyph).

### Switch

- **Track:** 36×20 pill. Off `#bdbdbd`, hovering to `color-mix(in srgb, var(--muted) 42%, #bdbdbd)`. On `#87ea5c` brand green, hovering to `color-mix(in srgb, var(--fg-2) 14%, #87ea5c)`.
- **Knob:** 14px `#fff`, 3px inset, `0 1px 3px rgba(0, 0, 0, 0.2)` shadow, travels 16px over 200ms.
- **Focus:** `0 0 0 3px color-mix(in srgb, #87ea5c 45%, transparent)`.
- **Disabled:** 45% opacity.
- **Labels:** always pair the switch with a text label, because neither track colour reaches 3:1 on white.

### Chat bubble

- **User:** `--accent-active` (#121212) ground, `--bg` text, radius `12px 12px 4px 12px` (the tail corner is bottom-right), `9px 13px` padding, 13px/500/1.7. Right-aligned; wraps with `overflow-wrap: anywhere`.
- **Assistant:** no bubble. Prose at 13px/500/1.7 in `--fg-2`, headings 14–16px/600 in `--fg`, code blocks on `#fafafa` with an `#ededed` header strip.
- **Composer:** the tray and card above. The send disc sits at the card's bottom right.

### Navigation rail rows

- **Rail:** 236px wide, no surface of its own, sitting 12px from the window edges. It collapses at 1080px and below, and opens or closes with a 200ms grid-column transition.
- **Rows:** `10px 10px 10px 16px` padding, 12px radius, 18px icon, 13px/600 label in `--muted`.
- **Hover:** fill `color-mix(in srgb, var(--fg) 10%, transparent)`, label and icon step up to `--fg`.
- **Selected:** the same 10% ink fill, icon and label in `--accent-active` (#121212) at 600.

## Layout Metrics

- **App grid:** two rows, a 44px top chrome and `1fr` content. The chrome has `0 10px 0 8px` padding, a `--bg` ground and no hairline.
- **Home content:** the glass card sits on a `0 12px 12px 0` margin; its sticky top bar is 44px. The inner column is capped at `--container-max` (1648px = 1600 + 2 × 24 gutters), with padding `24px 24px 48px` and a 20px gap. Below 900px the side padding drops to 16px (`--container-gutter-tablet` / `-phone`).
- **Reading and composing columns:** composer tray at most 820px, composer card at most 720px; long-form text at most about 72ch.
- **Project split:** chat panel 460px by default (min 345, max 720), workspace min 400px, 4px resize handle. Focus mode collapses the chat column over 140ms.
- **Breakpoints:** the product uses literals, not tokens: 1080 (rail), 900 (gutters), 760, 720, 640 and 560. Prefer 900 and 640 for new layouts.
- **Layers:** tab chrome 120, project menus 1200, dialogs 1500, toasts 1800, tooltips 4000, menus 9000. Menus sit above tooltips on purpose.
- **Density:** controls are 36px, menu rows 30–36px, nav rows about 41px. Touch layouts should grow hit areas to 44px without growing the visible chrome.

## Dark Theme

Fantay ships a `[data-theme="dark"]` override in `tokens.css`. It is **derived, not product-validated.** The values come from the product's own dark token block (`apps/web/src/styles/tokens.css:225-284`), which the product ships but never renders: `apps/web/src/state/appearance.ts` forces `data-theme="light"` because "the workspace surfaces have no dark tokens". Treat dark mode as a starting point that needs its own review, not as a finished theme.

- **Ladder:** ground `#202020`, panel `#353535`, tray `#494949`, hairline `#5c5c5c`, soft hairline `#494949`. Ink `#fafafa` / `#ededed` / `#bdbdbd` / `#848484`.
- **Accent:** inverts to `#ededed`, with `#fafafa` hover and pressed states. The primary pill inverts automatically (light pill, dark label) because it is drawn in `--fg` on `--bg`.
- **Semantic:** success `#3bbf7d`, warning `#ffc740`, danger `#ff5e5e`, focus `#3aa5f0`. Brand green tints become `#164111` surfaces with `#adf788` ink.
- **Shadows:** neutral black at higher alpha.
- **Opt-in only:** dark applies only with an explicit `data-theme="dark"`. Fantay does not follow `prefers-color-scheme`, matching the product's forced-light stance.
- **Known gap:** `#848484` meta ink drops to 3.28:1 on the `#353535` panel. Use `--muted` for anything that must be read in dark.

## Do and Don't

### Do

- Build screens from the grey ladder first; add green last, and only where something is on, sent or chosen.
- Make the primary action a black pill and keep it to one per view.
- Group with tone (a tray holding a white card) and concentric radii before reaching for a border.
- Use 600 for chrome and 500 for reading text; keep UI copy at 12–14px.
- Use frosted white scrims and glass for floating layers; keep tooltips solid.
- Keep motion short: about 200ms in, 140ms out, strong ease-out, popovers from 0.93.
- Put semantic colour in dots, icons and tints, with the label in ink.

### Don't

- Don't use brand green as text, as a page wash, or as a gradient.
- Don't use pure black ink, or a dark modal scrim over UI.
- Don't add coloured accents. The accent is ink; a second chromatic accent breaks the system.
- Don't draw cards with heavy borders or drop shadows; no neumorphism or skeuomorphic depth.
- Don't use `#848484` or `#bdbdbd` for running text.
- Don't use uppercase eyebrows, letter-spaced labels or weight 400 UI text.
- Don't use `ease-in`, scale-from-zero entrances, or long hover fades.
- Don't bundle or copy JiduMono Pro; reference it by family name only.

## Accessibility

- **Text contrast:** running text uses `--fg` / `--fg-2` / `--muted` (6.69:1 or more on white). `--meta` is for 12px+ meta text only and carries no essential information alone. `#bdbdbd` is limited to placeholders and disabled states.
- **Control boundaries:** hairlines are 1.38:1, so a field is never identified by its border alone. Keep a visible label, use the `--surface` fill, and rely on the 8.86:1 `--accent` focus border.
- **Focus visible:** every interactive element shows `var(--focus-ring)` on `:focus-visible` (4.21:1 info blue on white). Inputs and select triggers switch their border to `--accent`; the select trigger adds its halo; the switch uses its green halo.
- **Not colour alone:** switch state is carried by knob position plus a text label. Status pills carry a word next to the dot. Count badges sit beside their label.
- **Targets:** default controls are 36px tall. Small buttons (about 26px) need 8px of clear space. On touch, extend hit areas to 44px.
- **Semantics:** use native `button`, `input`, `select` and `dialog` elements, `aria-pressed` or `aria-selected` for segmented controls and tabs, `role="switch"` with `aria-checked`, and `role="status"` for toasts. Tooltips must not hold the only copy of essential information.
- **Motion:** honour `prefers-reduced-motion` (tokens collapse to 0.01ms) and `prefers-reduced-transparency` (glass becomes solid `--surface`).
- **CJK:** the stack falls back to PingFang SC and Microsoft YaHei for Chinese. Keep 13px as the floor for Chinese body copy.

## Agent Prompt Guide

- Paste the `:root` block from `tokens.css` first. Set `body { font: 600 var(--text-base)/var(--leading-tight) var(--font-body); color: var(--fg-2); background: var(--bg); }` and `-webkit-font-smoothing: antialiased`.
- For a hero, use the Georgia/Song stack at 32px/600/1.24 with `-0.02em` tracking in `--accent-active` (#121212), then a 14–16px `--muted` subtitle and one black pill.
- For a form, use labels at 13px/600 and `--surface` fields with 4px corners; focus is the `--accent` border.
- For a dashboard, use tray-and-card grouping, 12px meta in `--meta`, tags as grey pills, and status as dot plus word.
- For brand green, use at most three moments per screen, chosen from the places listed in §Brand green family.
- If a needed value is not in this file, use the closest product step and add an HTML comment naming it. Never invent a new hue.

## Provenance

Paths are relative to the Open Design repository root. Line numbers were re-verified on 2026-10-26.

| Fantay token | Value | Product token or literal | Source |
| --- | --- | --- | --- |
| `--bg` | `#fff` | `--bg` | `apps/web/src/styles/tokens.css:12` |
| `--surface` | `#fafafa` | `--bg-panel` / `--bg-elevated` | `apps/web/src/styles/tokens.css:14,20` |
| `--surface-warm` | `#ededed` | `--bg-subtle` | `apps/web/src/styles/tokens.css:15` |
| `--fg` | `#202020` | `--text-strong` | `apps/web/src/styles/tokens.css:37` |
| `--fg-2` | `#494949` | `--text` | `apps/web/src/styles/tokens.css:36` |
| `--muted` | `#5c5c5c` | `--text-muted` | `apps/web/src/styles/tokens.css:38` |
| `--meta` | `#848484` | `--text-soft` | `apps/web/src/styles/tokens.css:39` |
| `--border` | `#dbdbdb` | `--border` | `apps/web/src/styles/tokens.css:31` |
| `--border-soft` | `#ededed` | `--border-soft` | `apps/web/src/styles/tokens.css:34` |
| `--accent` | `#353535` | `--accent` (also `--selected`, default accent colour) | `apps/web/src/styles/tokens.css:42,206`; `apps/web/src/state/appearance.ts:12` |
| `--accent-on` | `#fafafa` | `--accent-contrast` | `apps/web/src/styles/tokens.css:43` |
| `--accent-hover` | `#202020` | `--accent-hover` | `apps/web/src/styles/tokens.css:47` |
| `--accent-active` | `#121212` | derived: the product's darkest ink (`--upgrade-ink`, user bubble, selected nav ink) | `apps/web/src/styles/tokens.css:78`; `apps/web/src/styles/chat.css:612`; `apps/web/src/styles/home/entry-layout.css:1359` |
| `--success` | `#00aa54` | `--green` | `apps/web/src/styles/tokens.css:96` |
| `--warn` | `#ff7528` | `--amber` | `apps/web/src/styles/tokens.css:108` |
| `--danger` | `#f04142` | `--red` | `apps/web/src/styles/tokens.css:105` |
| `--font-display` | Albert Sans stack | `--serif` (same stack as `--sans`) | `apps/web/src/styles/tokens.css:209` |
| `--font-body` | Albert Sans stack | `--sans` | `apps/web/src/styles/tokens.css:210` |
| `--font-mono` | JiduMono Pro stack | `--mono`, extended with the `_schema/defaults.css` fallbacks | `apps/web/src/styles/tokens.css:211`; `design-systems/_schema/defaults.css:58` |
| `--text-xs` … `--text-4xl` | 12 / 13 / 14 / 16 / 20 / 24 / 32 / 48px | `--font-size-12/13/14/16/20/24/32/48` | `apps/web/src/styles/base.css:59-69` |
| `--leading-body` | `1.7` | `--prose-line-height`; user bubble `line-height: 1.7` | `apps/web/src/styles/tokens.css:216`; `apps/web/src/styles/chat.css:633` |
| `--leading-tight` | `1.25` | `body { line-height: 125% }` | `apps/web/src/styles/base.css:53` |
| `--tracking-display` | `-0.02em` | home hero title tracking | `apps/web/src/styles/home/home-hero.css:148` |
| `--space-1` … `--space-12` | 4 / 8 / 12 / 16 / 20 / 24 / 32 / 48px | `--spacing-4/8/12/16/20/24/32/48` | `apps/web/src/styles/base.css:73-88` |
| `--section-y-desktop` | `48px` | derived: home column bottom run-out | `apps/web/src/styles/home/entry-layout.css:1918` |
| `--section-y-tablet` / `-phone` | `32px` / `24px` | derived: `--spacing-32` / `--spacing-24` | `apps/web/src/styles/base.css:84,82` |
| `--radius-sm` | `4px` | `--radius-sm` → `--radius-medium` | `apps/web/src/styles/tokens.css:160,175` |
| `--radius-md` | `8px` | `--radius-md` → `--radius-large` | `apps/web/src/styles/tokens.css:161,177` |
| `--radius-lg` | `12px` | `--radius-lg` → `--radius-xlarge` | `apps/web/src/styles/tokens.css:162,178` |
| `--radius-pill` | `999px` | `--radius-pill` | `apps/web/src/styles/tokens.css:181` |
| `--elev-flat` | `none` | `_schema/defaults.css` fallback (product surfaces are flat by default) | `design-systems/_schema/defaults.css:84` |
| `--elev-ring` | `0 0 0 1px var(--border)` | `_schema/defaults.css` fallback | `design-systems/_schema/defaults.css:85` |
| `--elev-raised` | `0 6px 24px rgba(28, 27, 26, 0.07), 0 2px 6px rgba(28, 27, 26, 0.04)` | `--shadow-md` | `apps/web/src/styles/tokens.css:126` |
| `--focus-ring` | `0 0 0 2px var(--bg), 0 0 0 3px #1a74ff` | button `outline: 1px solid var(--blue); outline-offset: 2px`; `--blue` | `packages/components/src/button.module.css:37-40`; `apps/web/src/styles/tokens.css:99` |
| `--motion-fast` | `140ms` | exit and popover duration | `AGENTS.md:390`; `apps/web/src/styles/entrance.css:156`; `apps/web/src/components/share/ShareFeedbackToast.module.css:27` |
| `--motion-base` | `200ms` | `--dur-enter` / `--duration-normal`; toast entrance | `apps/web/src/styles/tokens.css:186,197`; `apps/web/src/components/share/ShareFeedbackToast.module.css:24` |
| `--ease-standard` | `cubic-bezier(0.23, 1, 0.32, 1)` | product UI ease-out | `AGENTS.md:389`; `apps/web/src/styles/entrance.css:2` |
| `--container-max` | `1648px` | `max-width: calc(1600px + 48px)` | `apps/web/src/styles/home/entry-layout.css:1911` |
| `--container-gutter-desktop` | `24px` | home column padding | `apps/web/src/styles/home/entry-layout.css:1918` |
| `--container-gutter-tablet` / `-phone` | `16px` | side padding below 900px | `apps/web/src/styles/home/entry-layout.css:1936-1940` |
| dark block | see §Dark Theme | `[data-theme="dark"]` token block | `apps/web/src/styles/tokens.css:225-284` |
| reduced motion | `0.01ms` | global reduced-motion rule | `apps/web/src/styles/base.css:119-128` |

| Documented literal | Value | Product token | Source |
| --- | --- | --- | --- |
| Brand green | `#87ea5c` | `--brand` | `apps/web/src/styles/tokens.css:48` |
| Brand weak / soft | `#d0ffb5` / `#ebffde` | `--brand-weak` / `--brand-soft` | `apps/web/src/styles/tokens.css:49-50` |
| Brand text | `#0d5400` | `--brand-text` | `apps/web/src/styles/tokens.css:51` |
| Brand ink / surface | `#007106` / `#f2fff2` | `--brand-ink` / `--brand-surface` | `apps/web/src/styles/tokens.css:65-66` |
| Signal green | `#00ff08` | `--send-ground` / `--upgrade-ground` | `apps/web/src/styles/tokens.css:70,77` |
| Strong border / faint text | `#bdbdbd` | `--border-strong` / `--text-faint` | `apps/web/src/styles/tokens.css:32,40` |
| Info blue | `#1a74ff` | `--blue` | `apps/web/src/styles/tokens.css:99` |
| Card whisper / modal shadow | see §Elevation | `--shadow-sm` / `--shadow-lg` | `apps/web/src/styles/tokens.css:125,127` |
| Glass regular | `rgba(250, 250, 250, 0.66)`, `blur(28px) saturate(1.8)` | `--glass-regular` / `--glass-backdrop` | `apps/web/src/styles/tokens.css:24-25`; `apps/web/src/styles/material.css:33` |
| Scrim | `rgba(255, 255, 255, 0.6)`, `blur(50px)` | `--scrim-tint` / `--scrim-backdrop` | `apps/web/src/styles/material.css:45-46` |
| Buttons | see §Buttons | `Button` variants and sizes; destructive confirm | `packages/components/src/button.module.css:1-172`; `apps/web/src/styles/workspace/mention-home.css:637-642` |
| Inputs | see §Inputs | `.control` | `packages/components/src/form-controls.module.css:1-22` |
| Select | see §Select menu | `.od-select-*` | `apps/web/src/styles/primitives.css:263-382` |
| Tooltip | see §Tooltip | `.od-tooltip-layer` | `apps/web/src/styles/primitives.css:139-192` |
| Dialog | see §Dialog | `Dialog` | `packages/components/src/dialog.module.css:1-129` |
| Segmented control | see §Segmented control | `.segmented` | `apps/web/src/styles/design-system-flow.css:1329-1346` |
| Workspace tabs | see §Tabs | `.workspace-tab` | `apps/web/src/styles/shell.css:305-306,325-357,419-425,470-478` |
| Composer tray and card | 20px / 16px | `.home-hero__composer-card` / `.home-hero__input-card` | `apps/web/src/styles/home/home-hero.css:519-591` |
| Hero headline | Georgia stack, 600, 32px / 1.24 | `.home-hero__title` | `apps/web/src/styles/home/home-hero.css:128-154` |
| Glass content card | `rgba(255, 255, 255, 0.85)`, 16px | `.entry-main--scroll` | `apps/web/src/styles/home/entry-layout.css:1850-1880` |
| Nav rail | 236px; rows 12px radius | `.entry-nav-rail__btn` | `apps/web/src/styles/home/entry-layout.css:13,826,1359,1667-1687` |
| Menu | 160px, 6px padding | `.menu` | `apps/web/src/components/WorkspaceProjectActions.module.css:60-102` |
| Tag pill | `1px 7px`, 12px/600 | `.design-card-tag` | `apps/web/src/styles/workspace/mention-home.css:645-659` |
| Selected assist pill | `#f2fff2` / `#007106` / 22% ring | `.home-hero__type-pill.is-active` | `apps/web/src/styles/home/home-hero.css:424-429` |
| Count badge and inline toast | 15px pill; ink toast | `.badge` / `.toast` | `apps/web/src/components/MessageCenter.module.css:10-24,433-448` |
| Feedback toast | `#202020` pill, 200 / 140ms | `.toast` | `apps/web/src/components/share/ShareFeedbackToast.module.css:4-28` |
| Switch | 36×20, `#87ea5c` on | `.switch` | `apps/web/src/components/LabsSection.module.css:141-191` |
| User chat bubble | `#121212`, `12 12 4 12` | `.msg.user .user-text` | `apps/web/src/styles/chat.css:612,625-637` |
| Send disc | 28px, `#202020` + `#00ff08` | `.composer-send` | `apps/web/src/styles/chat.css:2203-2229`; `apps/web/src/styles/tokens.css:67-71` |
| Fonts | Albert Sans (OFL 1.1); JiduMono Pro (not bundled) | `@font-face` | `apps/web/src/styles/base.css:3-41` |
| Weights and base text | 600 default, 14px / 125% | `body` | `apps/web/src/styles/base.css:45-56` |
