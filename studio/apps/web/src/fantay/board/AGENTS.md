# apps/web/src/fantay/board — board engine (画板)

Follow the root, `apps/` and Fantay rules first. This file records the board module's invariants (spec 03 §13 as
amended by plan R1/R2/R6/R7). Specs: `03-board-engine.md` (engine/UI), `04-board-data.md` (contract, store).

## Layout

- `data/`, `sync/` — 04 web data layer (store, API, SSE bus, chat sync). The engine reads it only through
  `BoardDataStore` (`data/types.ts`).
- `model/` — engine types, contract adapter (04 `BoardDocument` → `EngineDoc`), kind registry, defaults, labels.
- `store/` — engine store (UI state only), React bindings, engine-op → contract-op translation, selection
  reducers, runtime state, engine runtime (camera ↔ store wiring) and the engine factory.
- `camera/` — camera math, Doop layout zoom, DOM camera controller, infinite-canvas `focusViewportForNode`.
- `engine/` — culling/LOD, live budget (plus the node-chrome files: covers, frame transport, message router…).
- `layers/` — stage DOM stack: grid, label layer, world (groups, edges, nodes), screen-space overlay.
- `nodes/` — `NodeShell`, `NodeLabel`, `TextEditor`, shared faces (`common/`), note/shape/group faces; the
  other kinds register in `node-faces.ts`.
- `interaction/` — tools, pointer controller, snapping, resize math, keyboard.
- `commands/` — `BoardCommands`, shell command registration, focus intents, the Frame tool's blank page.
- `chrome/` — toolbar, context bar, minimap, menus (`BoardChrome.tsx` is the entry).

## Invariants

- **I1** One node per file path: `ensureFileNodes` reuses the node that shows a path; file inserts use
  `stableBoardId('n', 'path:' + path)` with `ifAbsent`, the movie node `stableBoardId('n', 'movie:' + projectId)`.
- **I2** Pan and zoom never trigger React renders: the camera controller writes the world transform, the grid and
  `--zoom/--inv-zoom/--vx/--vy/--lz` on the root; React commits only when the visible set changes and on settle.
  Screen-space UI (labels, overlays) is placed with `calc(var(--vx) + x * var(--zoom))`.
- **I3** At most `LIVE_BUDGET` (4) live surfaces — frame/web/motion iframes and mounted `<video>`, extension bodies
  included (`live` + `requestLive(pinned)`); recomputed only when no gesture runs.
- **I4** Removing a node never deletes a file; deleting a file needs an explicit confirmation.
- **I5** The 04 store owns undo/redo (server inverses, last-writer guard). Only `origin: 'local'` transactions are
  undoable; every edit is `store.commit(tx)` → contract ops → `dataStore.apply(ops, applyOptionsFor(tx))`.
- **I6** Board data and covers never go into the user's project folder (daemon data root only).
- **I7** srcdoc-only features must pass through `decideFrameTransport` / `shouldUrlLoadHtmlPreview`.
- **I8** Every ported file keeps its SPDX + upstream header (Doop → AGPL header of spec 01 §4.5,
  infinite-canvas → MIT header of spec 03 §7.3); `THIRD_PARTY_NOTICES.md` lists them.
- **R6** DOM marked `data-board-interactive` (`BOARD_INTERACTIVE_ATTR`) keeps its own pointer, wheel and keys; bodies
  also stop `pointerdown` propagation. The node layer never clips overflow.
- **R7 / B5** The workspace header zoom menu is the only zoom control; `fantay.board.*` commands are registered only
  while the board is the active root tab; the viewport snapshot is published on settle while active, null otherwise.
- Field names follow the 04 contract (`x/y/w/h`, `ref`, `device: 'mobile'`, palette colours, `textStyle`); z is the
  contract array order (groups paint beneath other nodes); placement uses contracts `placeBoardItems`.
- New UI uses the Fantay primitives (`../ui`) and token variables (spec 01 names, amendment B1); CSS Modules only.
