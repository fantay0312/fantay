# Retelling a dashboard in another shape

A remix tells what a dashboard already shows as another of the shapes in `design-defaults.md` (Scroll story, Visual analysis, Letter, or a short visual). The shapes are shapes of a dashboard's page, not other artifact types: there is no new project to make.

Read the shape's description first. The remix writes a new `index.html` over the same datasets; it replaces the page, so say so before you write ("this replaces the current page; the datasets stay"), and keep the old page's file under another name only if the person asks for both.

## What carries over

Defaults, each for a reason; what the person asked for comes first.

- **The same numbers.** A reader who knows the dashboard will compare. Keep each calculation's `id` and `fn`, and each dataset, unless the shape says otherwise.
- **A figure keeps its base when its filter goes.** A story usually drops the filters. A figure that was measured over a filter's default ("+22% since 2006", with 20 years showing) is still measured over that, or its sentence says the new base: over all the data it is another number.
- **Words that turn on the data are filled from it**, headlines too (up, down, fell behind, a name that leads), from the sign of a change or the top row of a sort. A typed finding goes stale under the numbers beside it as soon as the data is refreshed.
- **A story carries less than a board.** Start from what the dashboard is for, choose the finding it serves, and keep what tells it. Tiles often fold into sentences and filters usually stay behind. A table people look things up in can stand at the foot of a page that scrolls.
- **Say what was left out**, in a line at hand-over. The remix replaces the old page, so the person should know before they rely on it.
