# Diagrams: flowcharts, swimlanes, org charts, trees, timelines, system maps

Read this if a slide shows boxes connected by lines. **Boxes first, in the file; lines second.** Pick the idiom (`diagram-recipes.md`, sections Idioms and Rows), take its row and column numbers, and write the slide with only the boxes (and lanes) plus a node-list comment, for example `<!-- A 0,0,320,120  B 448,0,320,120 ... -->` (id, left, top, width, height). Only then add connectors and labels, reading every coordinate off that list. If you notice you are computing connector coordinates before the boxes are written, stop and write the boxes.

**Source order is reading order.** A screen reader gets only the text, in source order, and none of the lines. Put the structure in the words: number sequential steps in their box text, carry an edge's word into the step it leads to ("No: escalate to legal"), keep edge labels in the boxes' order, and let the slide's title or the line under it say what the diagram shows ("Four stages; legal gates the last two"). Give the host `role="img"` with an `aria-label` only when the text inside is decorative; otherwise leave the boxes as real text.

## How a diagram is built here

Everything lives in one host: `<div class="dgm" style="position: relative; width: 1664px; height: 700px">`. Inside it, in this order:

1. one `<svg>` covering the host (`style="position: absolute; left: 0; top: 0" width="1664" height="700" viewBox="0 0 1664 700"`, `aria-hidden="true"`) holding every connector as `<line>`, `<polyline>` or `<path>`, so path numbers are the same numbers as the box edges with nothing to subtract;
2. the boxes: `position: absolute; left; top; width; height` divs with their text, painted opaque so a line that touches an edge never shows through;
3. the labels: pinned `<p>` elements.

Shared head marker, defined once in the SVG:

```html
<svg ...>
  <defs>
    <marker id="head" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
      <path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/>
    </marker>
  </defs>
  <line x1="320" y1="60" x2="448" y2="60" stroke="var(--line-strong)" stroke-width="3" marker-end="url(#head)"/>
</svg>
```

Use `stroke-linecap="round"` and `stroke-linejoin="round"`, `stroke-dasharray="12 10"` for optional or delayed links, and `marker-end` only on the last segment of a chained line. Where `context-stroke` is not available in the target, define one marker per stroke color with an explicit `fill`.

## Which layout

1. **A straight chain, or a small tree (at most two levels of branching and four leaves): flow.** A column or row of boxes with `display: flex; gap: 24px`, a short arrow between steps (an inline SVG arrow 32 by 24, `align-self: center`). Branches are columns inside a row. Nothing can overlap.
2. **A bigger tree, an org chart, a decision tree with more than four outcomes, or a bracket: the pinned Rows recipe** in `diagram-recipes.md`. Flow cannot join branches with lines and the tree will crowd the top of the slide.
3. **Anything else** (loops, lines that cross, swimlanes, boxes with two parents, maps): pin boxes inside the host, as above. Count boxes, connectors and labels before you start; past about 40 pinned elements, split the diagram over two slides.

## Pinned diagrams

- **Put the boxes on a grid.** One regular pitch between columns and one between rows; for example 320px wide boxes at left 0, 448, 896 and 1344, and 120px tall boxes at top 0, 290 and 580. At least 32px between boxes. Boxes that represent the same kind of node are the same size.
- **No box is narrower than its longest word.** At 24px text a node box is at least 200px wide (a 10-letter word with room to spare); add 16px for each letter beyond 10. At 28px: at least 232px, plus 18px per letter beyond 10. Bold or capitals: add another 10%. Two lines of 24px text need a box about 100px tall; of 28px, about 112px. For an absolutely positioned box you set the `width` yourself: `min-width: min-content` is ignored there, and `white-space: nowrap` keeps one line but does not widen the box.
- **If the columns do not allow that width, use fewer columns, never narrower boxes or smaller text.** In order: (1) put consecutive steps that belong to different lanes or rows in the same column, one above the other, and step to a new column only when the next box is in the same lane; (2) wrap a long chain into two rows (left to right, then right to left below, joined by a vertical leg at the turn); (3) merge boxes ("Validate and register" instead of two); shorter label text is also fine. A 1664px host holds at most 7 columns of 200px boxes with 44px gaps (lefts 0, 244, 488, 732, 976, 1220, 1464).
- **Draw connectors from edge point to edge point.**
  - Edge points: the middle of the right edge is `(left + width, top + height / 2)`; the middle of the bottom edge is `(left + width / 2, top + height)`. If a connector already uses an edge's midpoint, use another point on that edge.
  - Straight when the two points share a row or a column.
  - Down then across (`M x1 y1 V y2 H x2`): from a top or bottom edge into a side edge.
  - Across then down (`M x1 y1 H x2 V y2`): from a side edge into a top or bottom edge.
  - One parent to several children, or several boxes into one: use the bus and join recipes in `diagram-recipes.md` (Rows, or the spine for org charts). Never join a top or bottom edge to another top or bottom edge with a single bent path: one leg lies along a box's own border and the head lands sideways. (Down then across from a top or bottom edge into a side edge, as in a swimlane hand-off, is fine.)
  - A single three-leg path (across, down, across) is only for two boxes in different rows and different columns, side edge to side edge, when the two points are at least as far apart sideways as up and down and the gap between the columns is at least 96px; the middle leg runs down that gap. If the points are farther apart vertically, the first leg runs down the box's own side: use another edge, or three explicit segments.
  - Where legs run: a horizontal leg runs in the gap between two rows (its y is between the bottom of one row and the top of the next), never at a y where a box sits unless it ends at that box. A vertical leg runs in the gap between two columns, or at a column's centre when it enters a box from above or below.
  - Loop-back: connect the last box back to the first by going around the outside: down from the last box, along a clear strip below the boxes, then up into the first box. Never run a connector through a box.
- **Put text labels in `<p>` elements pinned beside their line**, never on the line: at least 8px clear of the stroke and of every box. Set the `width` of the `<p>`. Along a rail, path or timeline: period names (months, quarters) go inside or directly under the track; a milestone label sits only at the far end of its own leader line, and neighbouring leaders alternate two lengths (for example 40px and 100px) or two sides so labels cannot touch; flags, ticks and "today" markers never share a label's strip; phase names go in a gutter, not on the track.
- **Angled labels (45 degrees) on maps and dense timelines.** `transform: rotate` turns a box about its centre, so a rotated label whose corner is at the dot swings back across the line. For a dot centred at (X, Y), a label that starts beside the dot and runs up and to the right is:
  ```html
  <p style="position: absolute; left: {X-23}px; top: {Y-114}px; width: 240px; height: 34px; line-height: 34px; font-size: 24px; white-space: nowrap; transform: rotate(-45deg)">Station name</p>
  ```
  One that runs down and to the right is the same with `top: {Y+80}px` and `rotate(45deg)`. Keep `width: 240px; height: 34px` whatever the text. Keep names to 13 characters (abbreviate); a 13-character label climbs about 160px, so parallel lines sit at least 170px apart (in the 700px host that is four lines at y = 160, 330, 500, 670 with every label above its line) and stations at least 56px apart along a line.
- **Keep the slide within budget.** Allow 64px for the title (about 70px tall), a 40px gap and 700px for the host: 810px of the slide's 824px. With a pinned legend or source line at the bottom (a footer slide, see `layout.md`, Footer band), give the slide `padding: 128px 128px 160px` and a 16px gap: 786px of a 792px budget. **Use the whole host**: the lowest row of boxes ends below y = 600 (the row tables in `diagram-recipes.md` do this for you); a diagram squeezed into the top half above an empty band reads as unfinished. If the brief allows two slides, split at about 12 nodes. If it must be one slide, keep 24px text and use the Rows and fewer-columns rules; do not shrink the text.
- **Before you save, check the source; the geometry is the check.** Go down your node list once: (1) every connector's start and end is an edge midpoint of a listed box, or a bus or junction point from a recipe, none is "about there"; (2) every horizontal leg's y is in a gap between rows, and every vertical leg's x is in a gap between columns or at a column centre where it enters a box from above or below; (3) every label `<p>` is at least 8px from every line and every box; (4) boxes are at least 32px apart (except boxes that deliberately touch and share one stroke) and inside the host; (5) no text overflows its box.

## Curves

Use a curved path only when the line must be curved (a causal loop). One `<path d="M x1 y1 Q cx cy x2 y2">` per arc in the same covering SVG, starting at one box's edge midpoint and ending at another's, copied from the node list; only the control point is free. Put it 80 to 160px to the outside of the straight line between the ends, or to the inside when the outside would leave the host. End the path 2 stroke widths short of the target edge point (8px at a 4px stroke) so the marker tip touches the edge. Never estimate an endpoint; if you cannot name the box edge a path ends on, it is wrong. Keep the path at least 2 stroke widths inside the SVG's bounds so the head is not clipped. Give a curve-only SVG an `aria-label` when the curves carry meaning the labels do not ("more listings, lower rents").

```html
<!-- A 0,0,320,120  B 896,0,320,120 : arc from A's right-edge midpoint (320,60) to B's left-edge midpoint (896,60), ending 8px short -->
<path d="M 320 60 Q 608 180 888 60" fill="none" stroke="var(--accent-ink)" stroke-width="4" marker-end="url(#head)"/>
```
