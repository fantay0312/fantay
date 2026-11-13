# Self-review checklist

Run this before you hand the deck over. P0 items block delivery; fix them. P1 items are fixed unless the user's brief overrides them. P2 items are polish.

## P0

- [ ] The file is the canonical deck skeleton filled in: framework chrome, `@media print` and the navigation script are untouched; the first slide is `class="slide active"`; every slide is a `<section class="slide">` with a `data-screen-label`.
- [ ] Every slide sets its own `background` (a per-deck class is fine), and no slide depends on the stage color.
- [ ] No text under 24px. No slide where content passes the 1080px bottom or the 128px side margins; footer slides stop flow at y = 920.
- [ ] Body text contrast is at least 4.5:1 (3:1 from 44px up) against the slide's background, on every slide including the accent and dark ones.
- [ ] Every number, quote and name comes from the user's material or a cited source. A missing value is a bracketed placeholder (`[EUR __]`) and is listed in the reply. No invented statistics.
- [ ] Titles were posted before building, are in one grammar, and none delivers a verdict or fake tension ("It's not X. It's Y.").
- [ ] Charts follow `data-visualization`: bar lengths computed from `--v` and `--max`, every point labeled with its value, one baseline, color never the only signal.
- [ ] Diagram labels are real text, boxes are at least as wide as their longest word, and no connector crosses a box.

## P1

- [ ] One idea per slide. Lists became tables, card rows, big numbers or quotes. No slide is a wall of text.
- [ ] One type scale of four or five sizes, reused. At most two typefaces (three with a clear job). Emphasis by weight, italic or color, not a new size.
- [ ] Palette chosen once: one dark, one light, one or two accents; toned whites and blacks; two background tones plus one accent statement slide.
- [ ] Content slides share markup; the heading sits at the same height on every one; a content slide is not left 40% empty (spread with `space-between` or a spacer).
- [ ] Sentences sit in a column of 800 to 1000px, not across 1664px.
- [ ] Typographic punctuation in all text people read; straight quotes only in markup.
- [ ] No emoji as icons, no gradient backgrounds beyond one statement or cover slide, no rounded card with a colored left border, no decorative filler.
- [ ] Images: only the user's or the design system's; photos `object-fit: cover`, screenshots and diagrams `object-fit: contain`.
- [ ] The active design system's tokens are bound in `:root` and used for colors and fonts; no stray hex outside the theme-token block.

## P2

- [ ] Rhythm check: read the slides in order; no three consecutive slides with the same background or layout unless they are a deliberate run.
- [ ] Repeated elements (eyebrows, footers, page numbers) are in the same place on every slide that has them.
- [ ] Speaker notes exist only if the user asked for them, and carry a spoken script, not bullets.
- [ ] Print preview (Save as PDF) shows one slide per page.
