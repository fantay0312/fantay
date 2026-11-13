# Rehearsal: empty-state demos

Three Stageshow scenes in the product's own empty states. Filmed with the skill's `scripts/film.mjs` against a Vite
preview that imported these files, then opened in the real renderer (Next dev, isolated data root).

| Scene | Host | Gold | Kept | Changed |
|---|---|---|---|---|
| `BoardDemo` | `board/chrome/BoardStatus` | `ai-chat`, `loading` | Sent message and streamed rows; skeleton at the content's geometry, resolving top to bottom | Runs on the real dotted canvas with no window; result is a board node with the real selection and context bar |
| `MovieDemo` | `components/movie/MovieLibrary` | `loading` | Resolve order, whole-item arrival | Real frames from `movie-samples/paper-garden.mp4`, playhead, brand ring on the running shot |
| `SystemDemo` | `workspace/ProjectDesignSystemTab` | `panel-annotation` | Panel over the product's margin, one change at a time | Two real catalogue systems; a tool row sits between the click and the change, because choosing does not restyle a page |

Beats, all `play="once"` and holding the payoff, because they sit beside a running agent:

- Board, about 8s: type, send, read row, write row, line to the board, page resolves, click selects.
- Movie, about 8s: type, send, four shots resolve, approve, playhead runs seed to flower, delivered.
- System, about 7s: pick, tool row, page restyles, pick again, tool row, page restyles.

Captured: wide in light and dark; narrow (392) for Board and System; reduced-motion posters; German and Portuguese
strings; Arabic for Board. Movie has no compact design: its host is never under 500 wide on the desktop app.

Film lines judged intentional, each looked at in the frames:

- `uneven gutters` on `.md-frame`, `.sd-hero`, `.sd-page`, `.sd-menu`, `.bd-chat`: the check reads the distance to the
  text under the stage, or the page padding kept clear for the chooser that overlaps it. Nothing is off-centre in frame.
- `tight mark` on the swatches: 2px apart is the real chooser's spacing (`ProjectDesignSystemTab`, `gap-0.5`).
- `half-pixel glyph` in the context bar: the bar is centred on text of varying width and holds a layer through its rise.

Found only in the real renderer: `EmptyState` `dashed` used `items-center`, which collapsed the illustration to zero
width, so the demo mounted and ran invisibly. Fixed in `ui/empty-state.tsx` with a per-variant illustration class.

Assumptions: a demo may replace the glyph in these three states; the fictional brand `Verdant` stays untranslated.

Not checked: the fresh-eye review in the skill's `review.md` (skipped at the owner's standing preference against
review passes); the Electron window and the packaged app; other locales beyond those above; Thai line breaking; the
film `--slow` frame-by-frame pass on every press; live frame pacing on a real display.

# Rehearsal: welcome scene

`WelcomeDemo`, the right column of the sign-in page (host: `components/WelcomeShowcase`). It replaced a single review
window on a dotted tray, which read as boxed and showed one feature.

| Scene | Host | Gold | Kept | Changed |
|---|---|---|---|---|
| `WelcomeDemo` | `components/WelcomeShowcase` (EntryShell step 0) | `hero-grid`, `ai-chat` | Five tiles on different grounds as one picture, 8px gaps, content cropped by the tile; a sent message, a working line, a reply written in place | One stage for the whole picture, so every tile follows one story; the lead tile is the conversation; the grounds are the app's neutral and the mascot's own violet and coral |

Beats, `play="loop"`, about 13s a request, two requests alternating so nothing rewinds in view: type, send (the last
request's marks clear as one thing), the researcher picks two references in the library, the page is drawn onto the
canvas top to bottom, the film changes and its playhead runs three shots, the reviewer's check lands, the reply is
written, hold 2.4s. The poster is the opening frame: a finished second request.

Captured in headless Chrome against the dev renderer with a stand-in host bridge (the page is behind the desktop
gate): 1280 × 900 light and dark, Chinese and English, 1140 × 720 and 1728 × 1000, the reduced-motion poster, nine
frames across the loop, and bursts over the send and the bubble hand-off. The living mascot was seen under software
WebGL only.

Assumptions: the page keeps no tray behind the picture (the owner's note against dot grids and blurred glows); the
picture is fitted whole and centered, so a column of another shape shows page on two sides rather than a new crop.

Not checked: the skill's `film.mjs --gate` (it cannot pass the desktop gate), the fresh-eye review (the owner's
standing preference against review passes), the Electron window and the packaged app, locales other than Chinese and
English, live frame pacing on a real display.
