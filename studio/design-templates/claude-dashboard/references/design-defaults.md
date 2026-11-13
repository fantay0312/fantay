# Design suggestions

Suggestions for what the person left unsaid. The data rules, marking, states and hand-over are in `SKILL.md`; where a person's request says otherwise, the request wins.

- A dashboard is easier to act on when it serves one decision and its takeaway says which.
- A short header keeps the figures in view without scrolling: a plain one-line title and one sentence of takeaway under it, filled from data. More than about six headline figures in a row of large numbers is hard to read.
- When appropriate, give each question or domain a page of its own (a tab) rather than one long page, and put further cuts of the same data behind a filter.
- People read the first figure as the most important, so start with the one nearest the outcome (orders, not visits).
- A headline figure is more useful with its change from the period before: signed, the period named, colored by whether the change is good.
- Figures that are stages of one thing are usually clearer as a funnel or a ratio than as separate tiles.
- Cards are easier to read when they say their time window, such as "Last 28 days".
- A breakdown table is easier to compare when it keeps its parent's columns, in the same order.
- Define a metric in plain words where it first appears. A method that takes more than a sentence can have a page of its own.
- Where the SQL or the formula is your own, say so beside the metric's definition.
- You can add one breakdown the person is likely to ask for next, such as by team or by who did it.
- Labelling a line at its end with its name and latest value can replace a legend.
- When something was left out, say so on the page, with why (a table too large to include).

## Shapes to mix or ignore

Where a shape says otherwise, the shape wins.

- **Board:** kept open to watch health. One status line saying what is over its limit now, the same metric for every member as small charts on one shared scale, recent incidents in a table. Only a breach takes the danger color, and nothing moves.
- **Scorecard:** a weekly check-in. Four to six cards, each a large latest value, its change from the period before, a small trend and its target. Only a missed target turns red.
- **Experiment:** deciding whether to ship. The primary metric's lift as the large number, a sentence on whether its 95% interval crosses zero, every metric's interval against a zero line (right of zero is better), then the rate by arm over time.
- **Table:** many rows to scan. One table that sorts and searches, an in-cell bar on one shared scale, a sparkline per row, secondary columns that hide when narrow.
- **Funnel:** where people drop off. Each step as a bar from one left edge over a thin bar for the period before, the share lost between steps, the biggest loss in the danger color.
- **Review:** a period in review, read once. A few large totals on top, one large chart with dated events marked on it, then the same measure per group as small charts on one scale, labelled directly.
- **Visual analysis:** a finding, read top to bottom. The finding in a sentence around one number, then a chart under each heading that says what it shows; one accent series, the rest muted.
- **Scroll story:** a finding told as the reader scrolls (also asked for as a story, a narrative, scrollytelling). Short chapters of text, each marked `data-read-step`, in one column beside one chart that stays in view (`position: sticky`) and changes as each chapter reaches the middle of the viewport (an `IntersectionObserver` with `root: null` and a `rootMargin` that makes the middle band the trigger). One idea a chapter, its numbers marked like any other; when narrow, the chart stays on top and the text scrolls under it.
- **Letter:** an update written as a letter to its readers (members, investors, a team). A greeting, a few short paragraphs in one narrow centered column, each number inside its sentence and marked like any other, with a word that follows it (up, down) filled from the data too; at most one small chart, a sign-off, and `[brackets]` for what only the person can say. No tiles, headline figure, section headings or filters.

## Look

- The page's outermost wrapper sets the gutter and a maximum width (`max-width` with `margin-inline: auto`); it does not stack extra padding on the body.
- Charts and tables are easier to scan in cards, each with its title and a one-line note at the top: `background: var(--surface)`, `border: 1px solid var(--border)`, `border-radius: var(--radius-md)`, padding from `--space-*`. A grid (`repeat(auto-fit, minmax(min(100%, 20rem), 1fr))`, gap from `--space-*`) lets two share a row when there is room, and cards that answer one question can share a section heading.
- Text in the body face and sentence case. Sizes from the `--text-*` scale; the chart and section titles at a medium weight. `font-variant-numeric: tabular-nums` keeps numbers in columns lined up; large standalone numbers keep proportional figures.
- People see text at about 25px or larger as large. For a page title, a headline figure or a tile's main number, the display face at weight 400 works well when the design system defines one.
- Series take the design system's chart tokens, or the dataviz default palette, in order. When one series matters most, the rest take the muted chart token; the status-critical token works for a value past a limit. Colors are tokens that follow the theme, so there is no separate dark-mode rule beyond swapping the token values.
- Counts per day, week or month are usually clearest as bars (`d3.scaleBand` with a gap), and a rate, a running total or several series over time as a line drawn point to point, since a curve suggests values the data does not have.
- Lines look good at 2px with round caps and joins, and bars up to 24 to 32px thick. Gridlines 1px in the grid token, an axis line in the axis token, a reference line in a reference token, tick labels in the muted text token at caption size.
- A tooltip is a small popover: surface background, 1px border, `--radius-md`, a soft shadow, padding from `--space-*`, caption size, `pointer-events: none`. It reads well with the date or category first in secondary text, then a line per series: a short line key in its color, the value in strong text, the name. One series needs no key. To tie it to the chart, the hovered point gets a dot in that color (a bar, a stronger fill or outline), and with several series a rule marks the hovered x while the others fade. A tooltip is `position: absolute` in a `position: relative` box; `position: fixed` misplaces it in a scrolling page.
- A table of more than a screen of rows sits in a box with `max-height` and `overflow: auto`, its `th` `position: sticky; top: 0` on the card's background. It is easier to use when each header is a button that sorts (`aria-sort`, numbers as numbers) and a search `<input>` above filters rows by their text. Scrolling through every row usually works better than pages.
- Numbers and dates are easier to read formatted: counts `d3.format(',')`, shares (0 to 1) `'.1%'`, headline figures from 10,000 `Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1})`, dates `d3.utcFormat('%b %-d')` on a UTC-parsed date.

## States

(The rules are in `SKILL.md`; these are the visual defaults.)

- A failed source shows one line centered in its element, across and down (`display: flex; align-items: center; justify-content: center`): a 0.375rem round dot in the danger color, then `Failed to load` in the muted color at caption size, with no underline. The element keeps the `min-height` it has with data, so nothing below it moves, and the error message stays off the page.
- A value that is not there is blank space or `—`. Where a whole chart would look broken empty, one muted line under its heading says why.
- Before a dataset's values arrive, give the elements that will show them the class `dash-skeleton`: a short rounded bar in place of words that fills a chart's box, so loading takes no spinner and no words. Leave a chart's box empty, with no `—` and no white space in it. Remove the class when the data arrives or the load fails. While a filter change or a refresh re-runs a source, the affected cards go to about half opacity; the last values stay readable.
- A chart's box with a `min-height` equal to its drawn height keeps a state from moving what is below it.

## Before writing

A read of the file is the check: every token is written in full and exists in the design system's `tokens.css`; every number and date is formatted; each chart's code measures its margins from the widest tick and end label as drawn (`getComputedTextLength()`) and keeps labels from meeting (fewer ticks, end labels moved apart), since the data sets a label's width and place. Animation is CSS `@keyframes` inside `@media (prefers-reduced-motion: no-preference)`, timed from the first draw that has rows so a redraw does not replay it.

## d3 notes

- d3 v7 is the global `d3`. It has scales, shapes, axes and formats, hierarchies (treemaps), network layouts, chords, contours, nearest-point lookup, zoom, brush and transitions. It has no maps and no fixed color schemes. Regions compare well in bars or a table; a color ramp runs between two tokens' computed colors (`d3.interpolateRgb`).
- `d3.scaleUtc` or `d3.scaleLinear` with one argument sets the range, not the domain: pass both, `(domain, range)`.
- Parse each day or month string into a Date once, before scaling: a date axis formats Dates, so a NaN, Invalid Date or undefined on the page means a string went unparsed.
- `d3.axis` puts `font-size` 10 and `font-family` sans-serif on its group: `.attr('font-size', null).attr('font-family', null)` removes both.
- A `<b>` or `<strong>` is bold from the user-agent stylesheet; a selector at least as specific, such as `.page b`, sets a number's weight.
- Status color tokens (`--success`, `--warn`, `--danger`) are text colors; if one fails 4.5:1 on the card, use a darker text step of the same hue.
- An area under a line can fade to nothing at the baseline: a vertical `linearGradient` (`x2` 0, `y2` 1) with stops at 0, .25, .5, .75 and 1 at opacity .26, .16, .08, .03 and 0, in the series color.
- Bars take `--radius-md` or less: `rx` on a rect (the browser caps it at half the bar), a rounded-top path, or `border-radius` on an HTML bar. Dashed reference lines keep the default flat ends (`butt`) so short dashes stay even.
- Boxes in one row stay the same height if the grid keeps its default stretch and the border is on the item itself.
- A formatted key column keeps its raw value on the `<tr>` as `data-key`.

## Links

A link names a place on the page: a tab, a section, any element with an `id`. Open it by reading `location.hash` after the first draw, and keep the hash in step as the reader moves.

```js
const go = (el) => { el.scrollIntoView(); history.replaceState(null, '', '#' + el.id); };
const named = document.getElementById(location.hash.slice(1));
if (named) go(named); // after the first draw, when the element exists
```
