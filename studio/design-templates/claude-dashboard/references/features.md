# Dashboard features

Read this for a filter, several pages, a calculation that returns rows, a dataset that stays current, or a self-check pass. The data rules are in `SKILL.md`.

## Filters

A filter is a page-level state object (for example `const params = {region: null, start: null}`) that your `dash.onData` callbacks read. A control's `change` or a click sets a value and calls the shared redraw; every chart, stat and table re-renders from the same filtered rows so the numbers always agree.

- Keep filters in **one row above the charts they scope**, never inside a chart card and never per chart. Date range first, with presets (today, last 7, 30, 90 days) as rows before a custom range.
- When a filter's options are all known up front and one is picked at a time (a segment, a plan), compute the rows for every option once and switch which rows are drawn; do not refetch.
- Fill a filter's choices from a dataset (`regions`) so new ones appear, and draw a control from the page state, except a date or text field while it has focus.
- A date filter is a plain `<input type="date">`. Its value is text like `2026-09-01`. It fires `change` while a date is half typed (a year of `0002` on the way to `2026`), so accept only a whole date between `min` and `max` (`start.validity.valid`); when the field loses focus it shows the date in use again. Provide a Reset button.
- A click on a row or a bar can set a filter too, and every card that depends on it redraws. Show what is picked, with a way to clear it. Each `<tr>` carries its key as `data-key`; a bar does the same from d3's `.on('click', (event, d) => ...)`.
- Parameter defaults the page works out itself (a date relative to today) are set at the top of the script, before the first draw; Reset calls the same code.
- When a filter reruns, keep the previous render at reduced opacity rather than showing a skeleton.

```js
const params = { region: null };
const select = document.querySelector('.region');
select.addEventListener('change', () => { params.region = select.value || null; redraw(); });
dash.onData(() => {
  const g = dash.data('regions');
  select.replaceChildren(new Option('All regions', ''), ...(g.status === 'ok' ? g.data : []).map((r) => new Option(r.region)));
  select.value = params.region ?? '';
});
```

## More than one page

Pages are sections of `index.html` that a script shows one at a time; separate HTML files do not link. Keep a page's HTML in a `<template>` and clone it in when first shown if its work is heavy. Skip hidden pages in redraw and draw one when it is shown: at zero width a chart is blank. Reflect the open page in `location.hash` so a link opens it.

## Calculations that return rows

`dash.calc` may return rows (a per-channel change, a share of total), and its output is read like a dataset (`data-source="<calc id>"`). A calculation takes datasets or other calculations as `inputs`, uses only them and constants, and is never defined in a loop. Readers see `fn`'s text in the Sources and formulas list: name each parameter after its dataset, keep the body short, give it a plain title and a one-line description.

Filtering, aggregating, rounding, renaming for show and computing belong in a calculation (or in the file you prepare), not in drawing code, so that they stay visible.

## A dataset that stays current

- `schedule`: in words, how it stays current; `staleAfterHours`: about twice the cadence (48 for daily), past which the page shows it as stale (a muted "updated N days ago" beside the card's window).
- Refreshing: gather the rows again, replace the island and the `data/<id>.json` file, and update `updated` and `source.name` in `sources.json` and in the mirrored `#sources` island. For a recurring refresh, a scheduled routine whose prompt names this dashboard, the dataset ids and where each file gets its data; then write `schedule` and `staleAfterHours`. Data that must update by itself when the page opens belongs in the `live-artifact` template.
- Removing a source: delete its island, its `data/` file and its `sources.json` entry, and remove every mark that named it.

## Self-check pass

After a page write, before you hand over:

1. Open the page in a browser if one is available and read the console. No error is thrown, no `NaN`, `undefined` or `Invalid Date` is on the page, and no chart is blank.
2. Every mark matches its row: for a sample of marks, the text on the page equals the dataset value after formatting.
3. Labels do not overlap or get cut off, at the desktop width and at about 400px.
4. Every state renders: temporarily break one dataset's JSON to see the failed state, remove its rows to see the empty state.
5. Light and dark both read.

If you cannot open the page, say that you could not check the rendering; do not say the page works.
