# Paint, effects and text

Read this if a slide needs more than color and a card border. All of it is ordinary CSS written in your per-deck classes; none of it touches the framework's `<style>` block.

## Paint and effects: taste

- A gradient background is a deliberate choice, not a default. Flat, toned backgrounds are the norm. One gradient slide (a statement or cover slide) is plenty.
- `border: 1px solid` in a hairline one step off the background separates a card on a light slide. On a dark background use `rgba(255, 255, 255, 0.12)`. To draw a line on only some sides use `border-top`, `border-bottom`, `border-left` or `border-right`: for example `border-top` for a line above a card, `border-bottom` under a header row. Sides may differ in width, never in style or color; for that use a painted 4px div instead. Boxes that touch (stacked rows, tiles with no gap) share one stroke: set `border-top: none` or `border-left: none` on each box after the first, or keep a gap. Two adjacent strokes read as one double line.
- A circle is `border-radius: 50%` on a square box (avatars, dots, markers).
- An icon glyph reads at about half its box: give it at least 32px (48px beside 24px body text) and a color that stands off what is behind it. A pale yellow icon on a white card disappears. A pale or accent-colored icon sits on a filled chip (a small dark circle or square).
- Shadows are seasoning. One soft shadow with a large blur and low opacity, for example `0 4px 24px rgba(0, 0, 0, 0.06)` on a white card over an off-white slide. Never dark, hard shadows, never shadows on text, never shadows on everything.
- `opacity` fades an element and everything inside it.
- A small `rotate(-2deg)` on one polaroid-style photo is playful; on three photos it is noise. `filter: blur(8px) brightness(0.9)` on a full-bleed photo behind a statement; `backdrop-filter: blur(16px)` on a partly transparent div over an image makes a frosted panel; `mix-blend-mode: multiply` on a colored div over a photo makes a duotone. Most decks need no effects. The good ones use one effect idea consistently.

## Text

- Display text: `line-height` 1.05 to 1.15 and a negative `letter-spacing`. Body text: 1.3 to 1.45.
- Small uppercase eyebrow text: `letter-spacing` 2 to 4px and `text-transform: uppercase`.
- Emphasize with `<b>`, `<i>`, weight, or `<span style="color: ...">` inside a sentence. An underline in the accent color is allowed. `text-shadow: 0 2px 8px rgba(0, 0, 0, 0.4)` only for light text on a photo with no scrim.
- Gradient or image text, when asked for: `background: linear-gradient(...)` with `background-clip: text; -webkit-text-fill-color: transparent` on the heading, keeping `color` as the fallback and no box background on that element. If you want a bigger word or a second typeface, put it in a separate block.
- Headings keep their tag defaults until you set size and weight; the framework resets margins. Set `font-family` once per slide class so headings and text inherit.

## Rendering notes for this stage

- The stage is a fixed 1920x1080 box scaled to fit. Nothing scrolls; content that is too tall paints past the slide's `overflow: hidden` edge and is clipped. Treat that as a mistake to fix by splitting the slide, never by shrinking type below 24px.
- A table row at 32px takes about 70px; one line of text takes about `font-size x line-height`. A 96px font with `line-height: 1.15` takes about 220px for two lines.
- Table cells wrap: a long cell makes the row taller. Leave the default cell padding on text cells (a web habit like `padding: 12px 0` puts text on the column lines).
- Inheritance is ordinary CSS: font family, style, line-height, letter-spacing, color, text-align and text-transform inherit; background, border and shadow never do.
