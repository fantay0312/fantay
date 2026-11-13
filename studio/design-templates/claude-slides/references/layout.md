# Layout: how slides, flow and pinning compose

Read this when a slide needs more than a column of blocks and a card row. Every slide is a `<section class="slide">` on the framework's 1920x1080 stage, laid out with your per-deck classes. The framework gives the active slide `display: flex; flex-direction: column` through a zero-specificity rule, so a variant class on the section can switch it to grid or block just by declaring `display`.

## Two ways to place anything

- **Flow.** Children sit one after another in the slide's flex column. They size to their content unless you give a `width`, `height` or `flex`. Open space low on a slide is correct; do not reach for `justify-content: center` on every slide.
- **Pinned.** `position: absolute` with `left`, `right`, `top`, `bottom` measured from the slide's padding-box edge (the slide is `position: absolute` itself, so it is the containing block). Give pinned text a `width`. Use pinning only for what flow cannot do: a source line at the bottom edge, a badge over a corner, a full-bleed photo behind everything (`left: 0; top: 0; width: 1920px; height: 1080px; object-fit: cover`, written first in the source so later elements paint over it), a diagram.

Source order is paint order unless you use `z-index`; list pinned backdrops first. Inside a `position: relative` host, pinned children paint over the host's flow content.

## Padding is the margin

`padding: 128px` on the slide gives a 1664x824 content box. Set it in a per-deck class, not inline on every slide, so slides of one kind share markup.

## Flex idioms

- **Card row:** `display: flex; gap: 32px` with `flex: 1` children. The default `align-items: stretch` makes every card as tall as the tallest. A card is a flex column with `gap` plus its paint (background, border, radius, padding).
- **Two columns, unequal:** `flex: 2` and `flex: 1`, or `width: 800px` on one and `flex: 1` on the other.
- **Push apart:** an empty `<div style="flex: 1"></div>` between siblings, or `justify-content: space-between` on the parent.
- **Bottom-anchored block:** a `flex: 1` spacer above it.
- **Centered block**, for a one-off slide (statement, quote, closing line): `justify-content: center` on the slide.
- **A run of slides with one layout** (the content slides of a deck): the heading sits at the top margin on every one, at the same height, so it never hops when the viewer pages. Leave the column top-aligned and spread or anchor the body below the heading with `justify-content: space-between` or a `flex: 1` spacer. Centering the whole column makes the heading's height depend on how much the slide holds, so it jumps 20 to 60px between neighbours. A slide of a different kind (a centered statement or quote with no heading above its body) is free to differ.
- **Align a row's items:** `align-items: center`, `baseline` to line up different sizes on one line, or `flex-end`.
- **Big number and caption:** a column with `gap: 8px`; the number at 120px with `line-height: 1`, the caption at 28 to 32px in the softened tone.
- **Bar chart and a row of small bar charts:** every bar stands on one baseline. Give the bars a track of fixed height and bottom-align inside it; put the value above each bar and the category label and any note below the track. When several groups sit side by side, every group uses the same track height and the same scale, so all bars share one floor and the labels sit on one line. A top-aligned column of bars lets short bars float at different heights and the labels land raggedly. A waterfall chart is the one exception: its middle bars float on purpose, each starting where the previous one ended; its first and last bars still stand on the floor. Compute bar lengths from the data with `--v` and `--max` custom properties (the deck framework's chart discipline) instead of typing percentages.
- **Widths:** every column, card, pill and legend item is at least as wide as its longest word, or the word breaks mid-word. Count about 0.6 x font-size per character.

## Grid idioms

`display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px` fills children in row-major order; `grid-column: span 2` widens a cell. Use grid for KPI tiles, photo grids, feature matrices and anything a flex row cannot keep square (`aspect-ratio: 1` or `4 / 3`). A table is usually better than a grid of text cells for tabular content.

**A matrix is one grid, not many columns.** Three columns each holding a chip, a blurb and a card look like three stacks that drift apart as their content heights differ. Make it one grid of nine children in row-major order so rows line up across columns. Parallel content (a bilingual table, a before and after pair) shares rows the same way: one table with both languages as column groups. Add a gap or a divider between side-by-side tables so their rules do not read as one.

## Footer band

A footer (page number, source line, logo) is one pinned 24px row at `bottom: 64px`, at y of about 982 to 1016, in the same spot on every slide that has one. Nothing else enters its band: give that slide `padding: 128px 128px 160px` so flow stops at y = 920 (a 792px budget instead of 824px) and keep pinned content at `top + height <= 920`.

## Labels over an image, and anything pinned to a box

Wrap the `<img>` in a `position: relative` `<div>` with a set `width` and `height`, and pin badges, callouts or a caption bar to that box (`left: 0; right: 0; bottom: 0; padding: 24px 32px; background: rgba(0, 0, 0, 0.55); color: #fff`). Put diagram labels as real text over the image, never inside the image or an SVG's raster: fonts do not load inside images, and the text must stay editable and readable by assistive technology. The artwork is the image; the words are `<p>` elements over it.

## Example: one slide, flow plus pin

```html
<section class="slide s-light s-footer" data-screen-label="07 Q3 in numbers">
  <p class="eyebrow">Q3 in numbers</p>
  <div class="tiles">
    <div class="tile"><p class="figure">41%</p><p class="caption">faster ramp</p></div>
    <div class="tile"><p class="figure">6 to 1</p><p class="caption">onboarding paths</p></div>
    <!-- third tile alike -->
  </div>
  <div class="footer"><span>Source: People Ops, Q3 survey (n=212)</span><span>07</span></div>
</section>
```

with `.s-footer { padding: 128px 128px 160px }`, `.tiles { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px }`, `.tile { display: flex; flex-direction: column; gap: 8px; padding: 40px; border: 1px solid var(--line); border-radius: 16px }`, `.figure { font-size: 120px; line-height: 1 }` and `.footer { position: absolute; left: 128px; right: 128px; bottom: 64px; height: 24px }`. The figures come from the user's material; the numbers above are layout illustration only.
