# Slide composition craft

Brand-agnostic rules for decks on the fixed 1920x1080 canvas, written against the deck framework (`<section class="slide">` inside `#deck-stage`). Adapted from Anthropic's Slides artifact type (see `design-templates/claude-slides/NOTICE.md`). Express every rule below through per-deck classes in the second `<style>` block and inside the slide sections; never edit the framework chrome. The rules apply to any deck skill that opts in; the active design system's tokens decide colors and fonts.

## Think like a presentation designer

Each slide is a poster of 1920x1080 px that should make sense on its own. Aim for clarity, narrative flow and back-of-the-room readability, as a consultant or executive preparing boardroom material would. Do not design slides as web pages: no 14 to 16px body text, no dense UI.

## Outline first

- Write the full title sequence before any slide, in one grammar: short topic titles ("Market research", "Team structure") or action titles ("Asia is our largest market", "...but Eastern Europe has the most room to grow"). Read only the titles; the story should be clear.
- Post the list of titles in chat before building. Wait for approval only if the request was unclear.
- A title introduces the slide. It is not the speaker's punchline. Avoid titles that deliver a verdict, are too dramatic, create fake tension ("It's not X. It's Y."), reframe heavily, or promise a "magic moment".

## One idea per slide

- A statement beats bullets. Turn lists into tables, card rows, big numbers, quotes, diagrams or images. Several short slides beat one crowded slide.
- Decide the system out loud before writing: a layout for each slide kind (section header, title, content, image), then variety and rhythm on purpose. Mix full-image slides, background tones, big numbers, quotes, tables and a little text.
- Speaker notes only when the user asks. Then the deck becomes visual-first and the notes carry the script as spoken prose; take text off the slides to match.

## Canvas, margins, footer

- Section padding is 128px, leaving a 1664x824 content box. Pinned elements start 128px from an edge.
- Footer (page number, source, logo) is one 24px row at `bottom: 64px`, in the same place on every slide that has one. A slide with a footer uses `padding: 128px 128px 160px` so flow content stops at y = 920 (792px budget) and nothing else enters the footer band.
- Set `background` explicitly on every section so the slide never depends on the stage color.

## Type

- Four or five sizes for the whole deck, reused everywhere, for example 120 / 72 / 44 / 32 / 24 px. Minimum 24px. If text only fits at 20px there is too much text. Convert points to px by x2 ("36pt" is 72px).
- Eyebrows: 24 to 28px, uppercase, 2 to 4px letter spacing, accent color. Headings make statements; 40 to 48px for agenda-level points; 28 to 32px for sentences.
- Display lines: line-height 1.05 to 1.15 and slightly negative letter spacing. Body: 1.3 to 1.45. Emphasize with weight, italic or color, not a new size.
- One or two typefaces; a third needs a clear job. The text typeface and the display typeface come from different families.
- Type sets in the active design system's fonts. With no design system, pick a deliberate pairing (see the template's `references/fonts.md`).
- Typographic punctuation in text people read: curly apostrophes and the quotation marks of the text's language. Keep straight quotes in code and in markup.

## Width and vertical budget

- Flow text across 1664px is too wide for body copy. Put sentences in a 800 to 1000px column; display lines work at about 1400px. Size every box to at least its longest word (about 0.6 x font-size per character).
- Nothing shrinks to fit. Budget the 824px: a heading takes about font-size x lines x 1.1; a table row takes about 2.1 x font-size per line of cell text; a card takes lines x font-size x line-height plus padding. A two-line 96px heading is about 210px; add a 48px gap; nine 32px table rows are about 630px and do not fit below it.
- If content is too tall, use 24 to 28px in tables or split the slide. Do not set a fixed height smaller than the text needs; leave the height out.
- Keep a deck under about 50 slides.

## Rhythm and alignment

- Slides of one kind share markup (padding, gap, sizes). Repeated elements keep their place: the heading sits at the top margin at the same height on every content slide, so it never hops when the viewer pages through.
- Do not center a column that has a heading above its body. Only title-less slides (statement, quote, closing line) center vertically.
- A content slide whose column stops at 60% of the height looks unfinished. Fill the height: `justify-content: space-between`, or a flex spacer above the last block, with the heading staying at the top. A statement or title slide with open space below is correct.
- Bar charts: every bar stands on one baseline inside a fixed-height track, bottom-aligned; values above the bars, labels below; groups on one slide share track height and scale.
- Touching boxes share one stroke (drop the border on the touching side) or keep a gap. A matrix is one grid, not separate columns of stacks.

## Color

- Hex colors chosen once for the deck: one dark, one light, one or two accents. Tone whites and blacks toward the palette (for example `#FBFBF8` and `#14213D`), never raw `#fff` or `#000` unless the stark look is the point. Two accents share chroma and lightness but differ in hue.
- Two background tones plus one accent statement slide with the single number or sentence people should remember. Dark for the opening and closing slides, light for the main content.
- Body text holds 4.5:1 against its background (3:1 at 44px and above). Put dark text on a light accent. Colors that must be told apart differ in lightness, not hue alone; prefer blue and orange to red and green.
- Color never says it alone: a status, the winning bar or a highlighted cell also says so in words. A dash or an icon standing for a word gets the word beside it.
- A gradient background is a deliberate choice for one statement or cover slide, not a default. Shadows are seasoning: one soft, large-blur, low-opacity shadow, never on text or on everything.

## Images, diagrams, charts

- Use only the user's images or the design system's. Photos `object-fit: cover`; screenshots and diagrams `object-fit: contain` on a contrasting ground. Put diagram labels as real text over the artwork, not inside the image.
- Charts follow `data-visualization`: every number comes from the user's material or a cited source; a missing figure is a bracketed placeholder such as `[EUR __]`, never an invented number.
- Diagrams: write the boxes first on a grid, then the connectors from box edge midpoints; no box narrower than its longest word; at least 32px between boxes. See the template's `references/diagrams.md`.
