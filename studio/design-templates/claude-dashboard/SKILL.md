---
name: claude-dashboard
en_name: Data-backed dashboard
zh_name: 数据驱动仪表盘
description: |
  Build a data-backed dashboard, metrics page, KPI tracker, scorecard or recurring report as one self-contained HTML page over datasets: a CSV, TSV or JSON file the user has, or data you gather and can cite. Every number, chart and table comes from a dataset (nothing typed into markup, no value arrays in scripts), carries a provenance record in data/sources.json, shows its formula when computed, and defines loading, empty and failed states. Use when the user asks for a dashboard, KPI page, scorecard, board, metrics report or data story from their data, and wants the official Claude Dashboard behaviour.
en_description: |
  Build a data-backed dashboard, metrics page, KPI tracker, scorecard or recurring report as one self-contained HTML page over datasets, with provenance for every number.
zh_description: |
  基于数据集构建单文件 HTML 仪表盘、KPI 页、记分卡或周期报告：每个数字、图表和表格都来自数据集，data/sources.json 记录来源，计算值附可见公式，并覆盖加载、为空、失败三种状态。
triggers:
  - "claude dashboard"
  - "claude-dashboard"
  - "dashboard from my data"
  - "data dashboard"
  - "metrics page"
  - "KPI tracker"
  - "scorecard"
  - "recurring report"
  - "data visualization page"
  - "数据仪表盘"
  - "指标看板"
  - "数据看板"
od:
  mode: prototype
  platform: desktop
  scenario: operations
  preview:
    type: html
    entry: index.html
  design_system:
    requires: true
    sections: [color, typography, layout, components]
  craft:
    requires: [data-visualization, state-coverage, accessibility-baseline, laws-of-ux, content-discipline]
  example_prompt: "Build a dashboard from the attached orders.csv: one headline sentence, four KPIs with change against the month before, an orders-per-month chart, a repeat-rate line, and a sortable table by channel."
  example_prompt_i18n:
    zh-CN: "用附件 orders.csv 做一个仪表盘：一句话结论、四个带环比变化的 KPI、月订单柱状图、复购率折线，以及可排序的渠道明细表。"
---

# Claude Dashboard

A dashboard is a page you write over **datasets**. The datasets carry the numbers and their provenance; the page only draws them. What the person asks for is what you build; the defaults here apply only to what they left unsaid. Whatever the page's own code can draw is allowed: any chart, control or interaction. A chart they named is the one you draw, by hand where d3 has no helper; if you draw another, say which and why.

## Resource map

```
claude-dashboard/
├── SKILL.md            you are reading this
├── example.html        a working dashboard on sample data: the data layer, marks, states, charts and table to start from
├── data/               the sample datasets and their sources.json, showing the file convention
└── references/
    ├── design-defaults.md  what to build when the person left it open: shapes, look, states, filters, d3 notes, hand-over
    ├── features.md         filters, several pages, calculations, files that stay current, self-checks
    ├── remix.md            retelling a dashboard as a story, a letter or another shape
    ├── design-system.md    wearing the active design system's tokens
    └── checklist.md        P0/P1/P2 self-review
```

Read `example.html` end to end before writing and keep its data layer (the `store`, `dash.calc`, `fillMarks` and format helpers) as it is; rewrite the page markup, the charts and the datasets for the brief. Then read `references/design-defaults.md`.

## The output

Write these files in the project:

- `index.html`: one self-contained page. CSS in one `<style>`; d3 pinned as `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js">`; the datasets as inline JSON islands; the page script at the end. Tag each logical region with `data-od-id="slug"`, give headings and charts ids, and use semantic markup (`<main>`, `<header>`, `<section>`, `<table>`).
- `data/sources.json`: the provenance record, one object per dataset (below). Mirror the same array in the page's `<script type="application/json" id="sources">` island so the page can show its own Sources list; keep the two identical.
- `data/<id>.json` or `.csv`: the dataset files themselves when the user gave you one or you gathered one. The page's island holds the same rows; keep them identical.

## Datasets: where numbers come from

Every figure, chart and table comes from a dataset. No numbers in markup, no arrays of values in a script. The one exception is a fixed reference the user chose (a goal line, a target), which is a named constant and unmarked. The HTML holds a placeholder (`—`) marked with `data-source="<id>"`; a script fills it.

1. **Find the data.** The file the person gave, or data they named; otherwise gather it with your own tools (a published source you can cite, an API you can query). Use only tables and columns you found there, and read no personal field (a name, an address, anything of a person's identity or health) the person did not ask for. Prefer a smaller or already aggregated table over raw rows: only the columns and rows the page needs, aggregated where you can.
2. **Save rows as a dataset island:** `<script type="application/json" data-dataset="<id>">[{...row...}, ...]</script>`; `<id>` is `[A-Za-z0-9_-]`, 1 to 64 characters. Cells are plain JSON values; a CSV's cells arrive as text, so convert (`Number(x)`, `day.slice(0, 10)`) before use. A date not in ISO form is parsed as UTC with `d3.utcParse(format)` fitted to the cells, never `new Date(day)` (local midnight shows as the day before east of UTC).
3. **Describe each dataset in `data/sources.json`:** `{id, title, description, source, updated: {at, by}, schedule?, staleAfterHours?, fixed?}`.
   - `title`: a short name that stands alone in a list of sources, two to five words ("Signups vs quarter target").
   - `description`: one sentence on what this is; for a file, ending with where its rows came from ("Exported from the shop admin on Oct 28.", "From the 2025 annual report, p. 14.").
   - `source`: `{kind: "file", name, format}` for a file; `{kind: "url", url}` for data you gathered from a citable web source.
   - `updated`: `at` the ISO time now, `by` who (the person's name, else your own). A file write without it is a defect.
   - `schedule` (in words, how it stays current) and `staleAfterHours` (about twice the cadence) for data that stays current; `fixed: true` when it should stay as it is.
4. **Invented data is a dataset titled "Sample ...".** Rows you wrote yourself (sample, estimated or recalled, neither the person's own nor looked up) are a dataset whose `title` starts with "Sample" and whose `description` says how you made them. The page shows a visible "Sample data" label while any such dataset is present, and your reply says which numbers on the page are sample. Never present sample rows as the person's data.

## Marking and computed values

Mark the smallest element that shows a value:

- `data-source="<dataset or calc id>"` plus `data-field="<column>"`; add `data-where="col=value"` (several joined with `&`) or `data-row="<0-based index>"` when it comes from one row. Format with `data-format`.
- A chart or its legend drawn wholly from one dataset takes `data-source` alone, on its container, once. A table drawn from rows takes `data-source` and `data-row-key="<column>"` on the `<table>`, and `data-field` on each `<th>`.
- Anything computed (a share, a delta, a total, a sentence) is a `dash.calc(id, {title, description, inputs, fn})` that returns rows from its inputs and constants only. Name each parameter of `fn` after its dataset, keep the body short, and give it a plain title and one line of description; the page's Sources and formulas list prints `fn` so readers see the formula. A number you work out while making a file instead is said in that dataset's description.
- Words that turn on the data (up, down, fell behind, a name that leads) are filled from it, headlines included, from the sign of a change or the top row of a sort.
- Data values are untrusted text: write them with `textContent` or d3 `.text()`, never `innerHTML` or `.html()`.
- A mark whose value differs from the data, or that matches no row, is a defect: check each mark against its row.

## States

Define all of them; the page never shows a spinner or a blank:

- **Loading:** elements that will show values carry the class `dash-skeleton` (a short rounded bar in place of words); a chart's box stays empty with a `min-height` equal to its drawn height so nothing below moves. Remove the class when data arrives or the load fails.
- **Failed:** one line centered in the element, a small danger-colored dot then `Failed to load` in muted caption text. The element keeps its `min-height`. The error message stays off the page; Sources shows it.
- **Empty:** a value that is not there is blank space or `—`; where a whole chart would look broken empty, one muted line under its heading says why.
- **Refreshing:** keep the last render at reduced opacity; no skeleton flash, no layout jump.
- Motion only inside `@media (prefers-reduced-motion: no-preference)`.

## Design

Follow `references/design-defaults.md`, in short: the dashboard serves one decision and its takeaway says which; a plain one-line title and one sentence of takeaway under it, filled from data; at most about six headline figures, the first nearest the outcome, each with its signed change against a named earlier period and colored by whether the change is good; every card states its time window; counts per day, week or month are bars, rates and running totals are point-to-point lines; lines 2px, bars at most 24 to 32px; tooltips that stay inside the page; a sortable, searchable table with sticky headers; full width first, readable at about 400px (no fixed widths, drawings sized from `clientWidth`, `<svg width="100%" viewBox>`). Chart color, marks, legend, hover and table-view rules are the `data-visualization` craft and the `dataviz` skill; run its palette validator when you choose a categorical palette that is not the design system's own.

Use the active design system's tokens for every color, size, radius and font (`references/design-system.md` maps the names). Text in the body face, sentence case; big numbers in the display face when the design system has one. Write the page in the person's language, numbers, dates and state lines included: the `en` formats and `Failed to load` in `example.html` are English examples. In Chinese, headline figures take `Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 1})` (万, 亿), dates `d3.utcFormat('%-m月%-d日')`, and a failed source reads `加载失败`.

## Process

0. Ask only if you must. When the brief leaves a result-changing decision open (which decision the page serves, which data to use, who reads it), ask once through a single `<question-form>` of at most 4 questions with prefilled defaults, then stop the turn. A brief with a file attached, or one defaultable point, earns no form; a missing figure is a placeholder, not a question.
1. Find the data and write the datasets and `data/sources.json` (above).
2. Decide the shape (`design-defaults.md`, Shapes): what decision it serves, which headline figures, which one or two charts, which table.
3. Write `index.html` from `example.html`'s skeleton and data layer.
4. Self-check against `references/checklist.md`: every mark against its row, every state, a 400px width, light and dark.
5. Hand over: tell the person, in a line each, what they can do next (ask for any chart or control by name, such as a flow diagram, a date filter or a click that filters every card). Then what to know about their data: the datasets are inline in the page, so anyone who can open the file can read them. Then where the numbers could come from next, once and in a line (the file may be an export of a system they could connect; a live connection is the `live-artifact` template). Rows you wrote yourself: say which numbers on the page are sample.

## Changing and refreshing

Before a fix, read the dataset and check the column names. Change only what was asked. A new file version is a new island plus an updated `data/sources.json` entry (`updated`, `source.name`). Refreshing is that, from data gathered again the way the dataset's description says. Asked for this dashboard as a story, a letter or another shape: read `references/remix.md` first, and say that it replaces the page.

To the user this is their dashboard: talk about it in their words (the figures, the charts, where the numbers come from), not in terms of islands, marks or calcs.
