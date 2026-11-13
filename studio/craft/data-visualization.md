# Data visualization craft

Brand-agnostic rules for any chart, graph, KPI tile or dashboard, in any medium (HTML, inline SVG, d3, Chart.js, matplotlib, an exported image). Adapted from Anthropic's dataviz skill (see `skills/dataviz/NOTICE.md`). The full method, the runnable palette validator and the per-topic references live in `skills/dataviz/`; select that skill when you need to validate a palette or build a non-trivial chart. This file is the always-on floor.

## Order of work

Color comes last. Most bad charts pick colors first.

1. **Pick the form from the data's job.** Magnitude, identity, polarity, one headline number, change over time. Sometimes the answer is not a chart: a single value is a stat tile, a handful of headline numbers is a KPI row, more than about 7 classes that all carry meaning is a table.
2. **Assign color by the job it does** (below).
3. **Check the palette** (below), then apply mark specs, add the hover layer, finish the accessibility pass, and look at the rendered result for label collisions and overflow.

## Form

| Job | Default form |
|---|---|
| Compare magnitude | bar or column; heatmap for a grid |
| Trend over time | line; area only for a single series |
| Tell distinct series apart | grouped or stacked bar, multi-line |
| One series is the story, the rest context | emphasis: one accent hue, the rest neutral grey |
| Above or below a baseline | diverging bar, or a line against a baseline |
| Part to whole | stacked bar (horizontal for many or long-named categories); pie or donut only for at most 6 segments and far-apart values |
| Before and after per item | dumbbell |

- Never a one-bar bar chart or a 2-slice pie: that is a stat tile.
- Counts per day, week or month are bars; rates, running totals and several series over time are point-to-point lines. Do not smooth a curve between points the data does not have.
- Sequential (one hue, light to dark) is the safe default for magnitude. Categorical color is for when the series are the subject; if the story is "this one went up", use emphasis instead.
- One axis only. Never a dual-axis chart: two measures of different scale become two charts, small multiples, or both indexed to 100 at the first period.

## Color jobs

| Job | Rule |
|---|---|
| Categorical (identity) | up to 8 hues in a fixed order, assigned in sequence, never cycled. A 9th series folds into "Other", becomes small multiples, or uses composite encoding. Never generate more hues. |
| Ordinal (funnel stage, tier, bucket) | one hue, monotone lightness steps. The lightest step must still be at least 2:1 against the surface. |
| Sequential (magnitude) | one hue, light to dark. Never a rainbow. |
| Diverging (polarity) | two opposite hues (warm and cool) and a neutral grey midpoint, equal steps per arm. |
| Status (good, warning, serious, critical) | a small fixed scale with reserved meaning, always paired with an icon and a word. Never reused as "series 4". A series that means good or bad wears status colors; any other series wears categorical colors, never both in one chart. |

- Color follows the entity, never its rank. Filtering out a series must not repaint the survivors.
- One series means one color for every bar (slot 1) and no legend box. Do not color nominal bars by value: bar length already encodes it.
- The active design system's chart tokens win over the defaults below. When the system defines no chart palette, use the default palette and say so in one line.

## Palette checks

A categorical palette is legal only if it passes these. Run `node .od-skills/dataviz/scripts/validate_palette.js "<hex,hex,...>" --mode light` (and `--mode dark --surface "<hex>"`) instead of eyeballing; add `--pairs all` for scatter, bubble, map and small-multiple charts; use `--ordinal` for an ordinal ramp.

1. Fixed hue order (structural).
2. OKLCH lightness inside the band: about 0.43 to 0.77 on light surfaces, 0.48 to 0.67 on dark.
3. OKLCH chroma at least 0.10, or the hue reads as grey.
4. Color-blind separation between neighbours: OKLab Delta E x100 of at least 8 under simulated protanopia and deuteranopia (floor 6, legal only with a secondary encoding such as direct labels, gaps or texture), and at least 15 for normal vision (hard gate).
5. Contrast of each mark against the chart surface at least 3:1. Where it is lower (yellow, aqua, magenta on a light surface), ship visible direct labels or a table view; a warning here is not dismissable.
6. Only documented palette values.

Scatter, bubble, map and small-multiple charts need all pairs to pass, which the default palette does only for its first 3 slots: past three, fold to "Other" or facet.

Default palette (use only when the design system has none):

| Slot | Hue | Light | Dark |
|---|---|---|---|
| 1 | blue | `#2a78d6` | `#3987e5` |
| 2 | orange | `#eb6834` | `#d95926` |
| 3 | aqua | `#1baf7a` | `#199e70` |
| 4 | yellow | `#eda100` | `#c98500` |
| 5 | magenta | `#e87ba4` | `#d55181` |
| 6 | green | `#008300` | `#008300` |
| 7 | violet | `#6250d6` | `#9085e9` |
| 8 | red | `#e34948` | `#e66767` |

Status: good `#0ca30c`, warning `#fab219`, serious `#ec835a`, critical `#d03b3b`. Chart surface light `#fcfcfb`, dark `#1a1a19`. Dark mode is selected and validated on its own, not an automatic flip of the light values.

## Marks and chrome

- Bars: at most 24px thick (never fill the band slot), 4px rounded data end, square at the baseline, one shared baseline.
- Lines 2px with round joins and caps. Markers and end dots at least 8px. Area fill is the series hue at about 10% opacity.
- Gridlines and axes are solid 1px hairlines one step off the surface, never dashed.
- Adjacent filled marks are separated by a 2px gap in the surface color, and overlapping dots carry a 2px surface ring. Never draw a border around a mark to separate it.
- Saturated fills belong to small marks and accents, not large blocks.
- Text never wears the data color. Values, labels, legends and axis text use text tokens; identity comes from the colored mark beside the text. The one exception is a label inside a colored fill, which is white or near-black by the fill's luminance.
- Hero figure: one per view, at least 48px, in the interface sans (a display or serif face is allowed only when the design system's tokens say so), proportional figures. Use `tabular-nums` only for columns that must align (table rows, axis ticks).

## Labels, legend, hover

- Two or more series always get a legend; at most 4 are also direct-labeled. A single series gets no legend box: the title names it.
- Label selectively: the endpoint, the extreme, the series the story is about. Never a number on every point.
- A label that does not fit inside a bar or segment moves outside the bar end or into the tooltip. Never clip it with `overflow: hidden`.
- When end labels collide, use leader lines, small multiples or the legend, not vertical nudging.
- Every HTML or SVG chart ships a hover layer: a crosshair and one tooltip listing every series on line and area charts, a per-mark tooltip on bars, dots and cells. Hit targets are larger than the mark (at least 24px for dots). Tooltips enhance and never gate: every value is also reachable through direct labels or a table view, and keyboard focus shows the same as hover.
- Series and category names are untrusted data: insert them with `textContent`, never `innerHTML`.
- One filter row above the charts it scopes, date range first; filters re-render every chart, stat and table against the same slice. On refetch, keep the previous render at reduced opacity instead of a skeleton flash.

## Accessibility and states

- Every chart has a table-view twin.
- Color alone never carries meaning: status, deltas and the highlighted series also say so in words or icons.
- Texture (45 and 135 degree hatching) is opt-in for print, forced-colors and full color-blind mode, never decorative.
- A fixed chart height includes the x-axis band so the card never gets a nested vertical scroll.

## Anti-patterns

Dual axes. Recoloring on filter. A 9th hue. A value ramp on nominal categories. A rainbow for magnitude. Status colors on ordinary series. Eight hues when the story is one number. A donut for close values. Dashed gridlines. A number on every point. Borders around marks. Clipped labels. A tooltip as the only way to read a value. Pinpoint hover targets. Per-chart filters.
