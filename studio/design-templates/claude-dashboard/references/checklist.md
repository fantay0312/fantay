# Self-review checklist

Run this before you hand the dashboard over. P0 items block delivery; fix them. P1 items are fixed unless the brief overrides them. P2 items are polish.

## P0

- [ ] Every figure, chart and table is filled from a dataset; there is no number typed in markup and no array of values in a script (a user-chosen goal line is a named constant).
- [ ] `data/sources.json` has an entry per dataset (`id`, `title`, `description`, `source`, `updated.at`, `updated.by`) and the page's `#sources` island matches it.
- [ ] Rows you invented live in a dataset titled "Sample ...", the page shows a visible "Sample data" label, and the reply says which numbers are sample. No invented number is presented as the person's data.
- [ ] Every mark matches its row after formatting; no `NaN`, `undefined`, `Invalid Date` or empty chart on the page.
- [ ] Dates are parsed as UTC with the format the cells use; no `new Date('YYYY-MM')`.
- [ ] Data values reach the DOM through `textContent` or d3 `.text()`; no `innerHTML` with data.
- [ ] Loading, empty and failed states exist and keep the element's height; failures read `Failed to load` (or the person's language).
- [ ] Every computed value is a calculation with a title, a one-line description and a visible formula.
- [ ] Chart rules from `data-visualization` hold: one axis, legend for two or more series, direct labels selective, hairline grid, 2px lines, bars at most 24 to 32px with a rounded data end, a hover tooltip, a table-view twin, no color-only meaning.
- [ ] A categorical palette that is not the design system's own passed `validate_palette.js` for light and dark.

## P1

- [ ] The page serves one decision; the one-sentence takeaway under the title is filled from data and its direction words follow the data.
- [ ] At most about six headline figures, the first nearest the outcome; each has a signed change, a named comparison period and a good-or-bad color that is also readable without color (the sign, the words).
- [ ] Every card states its time window.
- [ ] Counts per period are bars; rates and running totals are point-to-point lines.
- [ ] Tooltips stay inside the page and list every series at the hovered x; hit targets are larger than the mark.
- [ ] The table sorts (`aria-sort`, numbers as numbers), searches, and has sticky headers when it scrolls.
- [ ] Filters sit in one row above the charts they scope and re-render everything from the same slice.
- [ ] Reads at about 400px: no fixed widths, `<svg width="100%" viewBox>`, drawings sized from `clientWidth`, no horizontal page scroll.
- [ ] Colors, fonts, sizes, radii and spacing come from the design system's tokens (`design-system.md`); no stray hex outside the token block and the chart script's palette fallbacks.
- [ ] Light and dark both read; text holds 4.5:1; status colors carry a sign or word.
- [ ] Dates, counts and states are in the person's language and number format.

## P2

- [ ] A line is labelled at its end with its latest value where that replaces a legend.
- [ ] Motion, if any, sits inside `prefers-reduced-motion: no-preference` and does not replay on redraw.
- [ ] Headings and charts have ids so comments and links keep their place; regions carry `data-od-id`.
- [ ] The hand-over names what the person can ask for next and says where the numbers could come from live.
