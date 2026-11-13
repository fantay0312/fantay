---
name: dataviz
zh_name: 数据可视化规范
description: |
  Use this skill whenever you are about to create ANY chart, graph, plot, KPI tile or dashboard, in ANY output medium (HTML or SVG, d3, Chart.js, matplotlib, an exported image). Read it BEFORE writing the first line of chart code, choosing chart colors, building a stat tile or KPI row, or laying out a dashboard. Teaches a design-system-agnostic method: form heuristic, color formula with a runnable palette validator, mark specs, hover and accessibility rules. The default palette is in references/palette.md.
zh_description: |
  创建任何图表、KPI 卡或仪表盘之前先读：先选图表形式，再按用途分配颜色并用脚本校验色板，随后套用标记规格、悬停与无障碍规则。附带可运行的色板校验脚本和一套默认调色板。
triggers:
  - "chart"
  - "graph"
  - "plot"
  - "data viz"
  - "data visualization"
  - "visualization"
  - "dashboard"
  - "KPI"
  - "stat tile"
  - "sparkline"
  - "heatmap"
  - "legend"
  - "chart colors"
  - "categorical colors"
  - "sequential palette"
  - "diverging palette"
  - "colorblind safe palette"
  - "图表"
  - "数据可视化"
  - "仪表盘"
  - "配色"
od:
  mode: utility
  category: diagrams
  design_system:
    requires: true
  craft:
    requires: [color, accessibility-baseline, data-visualization]
---

# Data Visualization

A chart is read by people and executed by you. This skill turns "make it look good" into a procedure with checks, so the result is right by construction rather than by taste. The always-on floor of these rules is in the `data-visualization` craft section; this skill adds the full method, the references and the runnable validator.

**The method is design-system-agnostic.** A design system supplies a small set of parameters (its ramps, a categorical order, a diverging pair, a status palette, its surfaces); the method consumes them unchanged. When the active design system defines chart tokens (a chart palette, `--chart-*` or equivalent), those win over the default palette. When it does not, use the validated default palette in `references/palette.md` and say so in one line. Typography follows the design system too: where `references/` says "system sans" or "never a serif hero figure", the design system's own tokens take precedence.

> The single most important habit: the color part is computable, so compute it. Never eyeball whether a palette is color-blind safe: run the validator.

## Where the files are

This skill's folder is staged inside the project at `.od-skills/dataviz/` (the skill preamble above shows the exact root, with an absolute fallback). Run the validator with Node from the project directory, and do not install packages:

```bash
node .od-skills/dataviz/scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a,#eda100,#e87ba4,#008300,#6250d6,#e34948" --mode light
node .od-skills/dataviz/scripts/validate_palette.js "<dark hexes>" --mode dark --surface "#1a1a19"
node .od-skills/dataviz/scripts/validate_palette.js "<hexes>" --pairs all          # scatter, bubble, maps, small multiples
node .od-skills/dataviz/scripts/validate_palette.js "<ramp hexes>" --ordinal        # funnel stages, tiers
```

Exit 0 means no hard FAIL; WARN bands still require a secondary encoding (direct labels, gaps, texture) or a table view. Exit 1 means fix the palette before continuing. A Python twin, `scripts/validate_palette.py`, behaves the same. In a chart page you may instead load the validator as `<script type="module">`, with `data-palette` and `data-mode` on `<body>`; it logs a `console.table` report to the console.

## The procedure: do these in order

Color comes last. Most bad charts pick colors first.

1. **Pick the form.** What is the data's job: magnitude, identity, polarity, a single headline, change over time? The job picks the chart type, and sometimes the answer is not a chart (a stat tile or hero number). See `references/choosing-a-form.md`.
2. **Assign color by the job it does.** Categorical (identity), ordinal, sequential (magnitude), diverging (polarity), or status (state), each with one rule. Assign categorical hues in fixed order, never cycled. See `references/color-formula.md`.
3. **Validate the palette.** Run the script (above), once per mode, with the mode's own surface. Fix anything that FAILs before continuing. Do not reason about Delta E by hand.
4. **Apply mark specs and spacers.** Thin marks, 4px rounded data ends anchored to the baseline, 2px lines, markers of at least 8px, a 2px surface gap between adjacent fills and a 2px surface ring on overlapping marks, selective direct labels. See `references/marks-and-anatomy.md`.
5. **Add the hover layer by default.** An HTML or SVG chart is interactive: a crosshair and tooltip on line and area charts, a per-mark tooltip on bars, dots and cells. Hit targets are larger than the mark; filters sit in one row above the charts. See `references/interaction.md`.
6. **Final accessibility pass.** For two or more series a legend is always present and at most 4 are also direct-labeled, so identity is never color alone; a table view exists; dark mode is selected on its own against the dark surface; texture is available for the color-blind, print and forced-colors case.
7. **Render it and look at it.** The validator checks color, not layout. When the chart is part of a saved HTML file, check the rendered result for label collisions, geometry and overflow before you call it done.

Then check the result against `references/anti-patterns.md`. If your chart matches an entry, it is wrong.

## Non-negotiables

- Categorical hues in fixed order, never cycled. A 9th series folds into "Other", small multiples or composite encoding.
- One axis. Never a dual-axis chart; two measures of different scale become two charts, small multiples, or both indexed to a common base.
- Color follows the entity, never its rank. A filter that changes the series count must not repaint the survivors.
- Sequential is one hue, light to dark. Diverging is two hues plus a neutral grey midpoint. Never a rainbow.
- Run the validator before shipping any categorical palette. Color-blind Delta E of at least 8 is the target (OKLab x100); 6 to 8 is a floor legal only with secondary encoding. A normal-vision floor below 15 is a hard FAIL. A contrast WARN obligates visible labels or a table view and is not dismissable.
- Thin marks; a legend for two or more series (none for one); selective direct labels, never a number on every point; recessive grid and axes.
- Text wears text tokens, never the series color. A colored mark beside the text carries identity.
- Status colors are reserved (good, warning, serious, critical), never reused as "series 4", and ship with an icon and a label.
- Series and category names are untrusted data: insert them with `textContent`.

## Plugging in a design system

The method is invariant; only these parameters change per system. The reference instance, every value filled in, is `references/palette.md`.

| Parameter | What the system provides |
|---|---|
| Ramps | the hue scales (named steps) the palette draws from |
| Categorical theme | the fixed hue order (a named theme), default plus alternates |
| Sequential hue | the default single hue for magnitude |
| Diverging pair | two warm and cool poles plus a neutral midpoint |
| Status palette | good, warning, serious, critical, on steps distinct from the categorical ones |
| Texture fill | one directional hand-drawn fill, used at 45 and 135 degrees |
| Surfaces | light and dark chart-surface colors (the validator needs these) |
| Filter controls | date-range and dimension controls (behavior in `interaction.md`) |

To onboard a new system: fill those rows from its `tokens.css` and `DESIGN.md`, feed its ramps to the validator, and let it snap each slot to the nearest passing step (`references/color-formula.md`, Snap-to-passing). Define the chosen slots as CSS custom properties at the top of the chart's page (see `references/palette.md`, How to use these values) so light and dark swap in one place.

## Reference files

| File | What it answers |
|---|---|
| `references/choosing-a-form.md` | Which chart type, and is it even a chart? |
| `references/color-formula.md` | The five color jobs, the six checks, snap-to-passing |
| `references/marks-and-anatomy.md` | Mark specs, spacers, labels, figures, hero number |
| `references/interaction.md` | Tooltips and hover, filters and time ranges |
| `references/components.md` | The pieces a chart is made of, buildable in plain HTML and SVG |
| `references/anti-patterns.md` | What goes wrong; check every chart against it |
| `references/palette.md` | The reference palette instance; swap its values for your brand's |
| `scripts/validate_palette.js` | The runnable six-checks validator |
