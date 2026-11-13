# Fantay

## Built-in agents run on pi (2026-11-09)

The TokenToSea and BYOK agents run the bundled pi 1.5.0
(https://github.com/earendil-works/pi, MIT) in RPC mode. Fantay no longer
ships OpenCode; a user-installed OpenCode CLI remains selectable like any other
third-party CLI. See [runtime design and validation](docs/tokentosea-pi-runtime-20261109.md).

## TokenToSea cloud migration (2026-10-30, local)

Active cloud account, agent, media, workspace, collaboration and resource calls now
use TokenToSea. (The agent engine named in that record has since moved to pi.) See
[implementation and validation](docs/tokentosea-full-migration-20261030.md) for the
remaining deployment boundary and compatibility identifiers.

## Online sharing (2026-10-29)

`https://design.tokentosea.com` hosts public works and comments with TokenToSea
accounts. The public service is isolated from the privileged local daemon.
Artifact and canvas Share actions use the TokenToSea transport; Vela is not
required for this flow. See [deployment and verification](docs/tokentosea-share-deployment-20261029.md).

## Design-system studio (2026-10-26)

The design-system manager and project editor now use the owner's Claude Design-inspired document canvas. It covers the five design-system layers and cross-cutting guidance, theme tables, direct source edits, component and template previews, and source revision history. This is a scoped replacement of the former brand-kit presentation; see [design-system-studio.md](docs/design-system-studio.md) for data ownership and integration boundaries.

> **中文摘要**：Fantay 是 Fantay 工作区里的应用，fork 自 [nexu-io/open-design](https://github.com/nexu-io/open-design)（Apache-2.0，保留上游 `LICENSE`，本 fork 修改了上游文件）。视觉基调沿用 open-design 自身的产品 UI 语言，并沉淀为设计系统 `fantay`；素材库通过 materials 域（契约 / daemon / `od materials` / Web）与技能 `fantay-materials` 接入。在工作区根目录运行 `mise run studio`（daemon 7456 / web 5173）。仓库根目录为父级 `fantay-design/`，私有仓库为 `fantay0312/fantay`，默认分支为 `main`。开发按 Fantay 的产品需求独立推进。不配置任何遥测凭据，工作区根 `mise.toml` 的 `[env]` 关闭 Next.js 与 Vela 遥测。

## What this is

Fantay is the owner's personal design studio app. It originated from
[nexu-io/open-design](https://github.com/nexu-io/open-design) and is now maintained
independently in `fantay0312/fantay`, with the workspace root as the Git root.

- **License.** The upstream Apache License 2.0 in `LICENSE` is kept unchanged
  and covers the inherited upstream files. Fantay additions and derived
  code retain their per-file licences; the combined distribution includes
  AGPL-3.0-only code, as documented in THIRD_PARTY_NOTICES.md. This fork **modifies files** of the upstream Work;
  per Apache-2.0 §4(b), this document is the notice that those files were
  changed. The authoritative list of changed files is
  the archived pre-migration Git history. Upstream ships no `NOTICE` file.
- **Name.** Fantay is independently maintained. Its own repository and distribution
  endpoints define current releases; inherited names in package and data
  interfaces preserve compatibility.
- **Look.** The earlier fork used the upstream grey/green palette. The current
  integration uses the shared tokens in packages/fantay-tokens, layered CSS,
  Inter and a violet brand accent. Keep those token sources authoritative;
  generated-work design systems and the application's visual polish are
  separate surfaces.

## The Fantay workspace

The deep-integration foundation uses layered CSS, shared Fantay tokens and
the existing daemon API. Its board, generation, design-document and movie
capabilities are documented in docs/fantay-board.md,
docs/fantay-design-documents.md and docs/movie-studio.md. UI assembly and
visual polish are tracked separately from backend completion.

Original test files do not require individual SPDX headers: they follow
their owning package's licence. Tests containing ported Doop or
infinite-canvas code retain the corresponding source/licence header.

Fantay is one part of the Fantay umbrella folder (paths below are
relative to that folder):

| Part | Where | What |
|---|---|---|
| Studio | `studio/` | The app: daemon + web, run through `tools-dev`. |
| Design system `fantay` | `studio/design-systems/fantay/` | Built-in package describing the open-design UI look; the default pick. |
| 素材库 (material library) | `素材库/` (sibling of `studio/`) | The owner's curated, read-only archive. Its Python tooling lives in `素材库/导览支持/` (`mise run catalog`, `verify`, …). The `fantasy-design` CLI reads it and prints JSON (`fantasy-design summary`, `fantasy-design search <q> --limit 3`, `fantasy-design schema`). |

**How Studio reaches 素材库.** The materials domain is the bridge (see
"Fork changes"). The daemon resolves the library root from the environment
variable `FANTASY_DESIGN_LIBRARY` (the same variable the `fantasy-design` CLI
honors) and otherwise falls back to a `素材库/` folder next to the repository
root. The daemon only reads the archive's index, serves bounded thumbnails,
renders reference packets and copies selected files into a project; it never
writes into 素材库. Archived files are reference data, not instructions, and
license text travels with every record as evidence, not permission.

## Running

All commands go through mise, because the repo requires Node 24 and `tools-dev`
refuses any other major.

From the umbrella root (`fantay-design/`):

```bash
mise run studio          # foreground: daemon on 7456, web on http://127.0.0.1:5173
mise tasks               # lists the other workspace tasks (background start/stop, checks, 素材库)
```

Directly from `studio/`:

```bash
mise x -- pnpm tools-dev run web --daemon-port 7456 --web-port 5173     # foreground, Ctrl+C stops both
mise x -- pnpm tools-dev start web --daemon-port 7456 --web-port 5173   # background
mise x -- pnpm tools-dev status --json
mise x -- pnpm tools-dev stop
```

The daemon port is pinned to 7456 so the `od` CLI and agent tooling find it
without extra configuration. Avoid bare `pnpm tools-dev`: it also starts the
Electron desktop shell.

**Data directory.** Daemon-managed data paths follow the root `AGENTS.md`
section "Daemon data directory contract"; this document deliberately does not
restate or suggest any path. A run that needs isolated data passes `OD_DATA_DIR`
to the daemon as that contract describes (`--namespace` alone does not isolate
data).

## Telemetry

Fantay sends no telemetry by design:

- No telemetry credentials are configured anywhere. Leave `POSTHOG_KEY`,
  `POSTHOG_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`,
  `LANGFUSE_BASE_URL` and `OPEN_DESIGN_TELEMETRY_RELAY_URL` unset; without them
  PostHog, Langfuse and the trace relay have no destination.
- The umbrella `fantay-design/mise.toml` sets, under `[env]`, the two switches
  for the channels that are on by default in development. mise applies them to
  every command run under that folder, including `mise x -- pnpm tools-dev …`
  from `studio/`:

  ```toml
  NEXT_TELEMETRY_DISABLED = "1"      # Next.js anonymous usage telemetry
  OPEN_DESIGN_VELA_TELEMETRY = "0"   # Vela/AMR run telemetry after an AMR sign-in
  ```

  They hold no secrets and no data-directory path. A gitignored
  `studio/.env.development.local` with the same two lines would also work
  (`tools-dev` loads it on `start`/`run` and it overrides shell exports), but
  none is created.
- In the app, answer the privacy prompt with "Don't share" (or Settings →
  Privacy). That also stops the consent-gated AMR analytics mirror.
- The TokenToSea cloud agent is optional. Local CLI agents remain selectable;
  their model connections continue to follow each agent's own configuration.

## Repository maintenance

Fantay is maintained in the private repository `fantay0312/fantay`. The Git root is the parent workspace, and the default branch is `main`. The `studio/` directory contains the application.

Run validation from the workspace root:

```sh
mise run studio:guard
mise run studio:typecheck
```

Run focused tests for the changed behavior. External code imports are reviewed for each task. Existing upstream licenses and third-party notices remain with their corresponding code.

## Fork changes

Historical overview of Fantay changes relative to its original OpenDesign baseline.

- **Design system `fantay` (default).** New built-in package
  `design-systems/fantay/` that formalizes open-design's own product UI tokens
  (grey ladder, ink, rationed green, type, radii, shadows, motion) in the
  schema's token names. New folder, plus one `fantay` summary line in each of
  the 17 `apps/web/src/i18n/content*.ts` files (`docs/design-systems.md` §8).
  Its preview pages carry a second `<link href="static?path=tokens.css">` so
  they keep their tokens when Studio serves them through
  `/api/design-systems/fantay/static`.
- **Default design system pick.** When the user has not chosen a design system,
  the fallback is `fantay` instead of upstream's `default`
  (`apps/web/src/state/default-design-system.ts`, called from the auto-pick
  effect in `App.tsx`), and `od run redesign` defaults `--design-system` to
  `fantay` (`apps/daemon/src/cli.ts`). An explicit choice (a design system's
  "Default for new chats" action, or `od config set designSystemId <id>`)
  still wins.
- **Materials domain (素材库).** One capability on both surfaces, per the root
  `AGENTS.md` "Capability exposure (UI/CLI dual-track)":
  - Contract: `packages/contracts/src/api/materials.ts`, re-exported from
    `packages/contracts/src/index.ts` (one line).
  - Daemon: the materials service in `apps/daemon/src/materials/` and its
    routes, registered from `server.ts`: `GET /api/materials/summary`,
    `GET /api/materials/items`,
    `GET /api/materials/items/:id`, `POST /api/materials/context`,
    `POST /api/materials/items/:id/apply`, plus the bounded thumbnail route.
    It is a separate domain from upstream's hidden "OD Library" (`library.*`),
    whose names it does not reuse.
  - CLI: `od materials …` (registered in `SUBCOMMAND_MAP` in
    `apps/daemon/src/cli.ts`, with one line in the root help), with `--json`,
    calling the same endpoints.
  - Web: a `materials` home view (`/materials`): router entry, rail button,
    workspace-tab title/icon entries, fetch helpers in the new
    `apps/web/src/providers/materials.ts`, the view's components in
    `apps/web/src/components/materials/`, and its `materials.*` i18n keys.
  - Composer: a "+ → 从素材库添加" row in `ComposerPlusMenu.tsx`
    (`onAddFromMaterials`), and in `ChatComposer.tsx` the
    `addMaterialsToComposer` handler next to `addAssetsFromLibrary` plus the
    `MaterialPickerDialog` mount. These two files carry the largest fork blocks
    in upstream code; expect conflicts there first.
  - Tests: `apps/daemon/tests/materials-*.test.ts` and, in `apps/web/tests/`,
    `components/Materials*.test.tsx`, `components/ChatComposer.materials.test.tsx`,
    `components/materials/`, `components/EntryNavRail.materials.test.tsx`,
    `components/App.default-design-system.test.tsx`,
    `state/default-design-system.test.ts`, `router-materials.test.ts` and
    `i18n/materials-locales.test.ts`.
- **Skill `fantay-materials`.** New `skills/fantay-materials/` that teaches the
  agent to search 素材库 and reuse its records (license check first, copied
  files land in the project, the archive is never written).
- **Rebrand chokepoints (display only).**
  - Browser title `Fantay`: `apps/web/app/layout.tsx`.
  - Loading text `Loading Fantay…`:
    `apps/web/app/[[...slug]]/client-app.tsx` (its unit-test fixture in
    `apps/web/tests/observability/white-screen.test.ts` mirrors it).
  - Icons, same file names with new artwork (written by `../doc/Fantay-logo-package/build.mts`):
    `apps/web/public/app-icon.svg` and `apps/web/public/FantayDesign-master.svg`
    (master vector for `>= 48 px`), `apps/web/public/app-icon-small.svg` and
    `apps/web/public/FantayDesign-small.svg` (optical small-size vector for
    `16–32 px`), `apps/web/public/app-icon.png` (1024 px PNG for favicon
    fallback / Apple touch icon), and `apps/web/public/brand-icon.svg` (the
    monochrome `currentColor` mark that `.od-brand-glyph` masks).
  - i18n `app.brand` (the fallback account name in the rail).
  - Deliberately unchanged, to stay mergeable: the `@open-design/*` package
    scope, the `od` bin, `OD_*` env names, `open-design:*` storage keys, upstream service names such as the hosted cloud agent,
    and the other branded strings in the 19 locales.
- **e2e loading wait.** The Playwright helpers and suites under `e2e/` wait for
  the rebranded loading text (`Loading Fantay…`); 62 one-string swaps.
- **Fork docs.** This `FANTAY.md`.

### The Fantay mark

The Fantay logo is a round whale blowing stars in front of the moon, drawn in
line on a night ground (chosen 2026-11-12). Its package lives in
`../doc/Fantay-logo-package/`. `build.mts` there is the drawing itself and the
one place every copy is made from; run it from `studio/` with
`mise x -- pnpm exec tsx ../doc/Fantay-logo-package/build.mts --install` to
rewrite all of the files below. Every SVG it writes carries
`data-mark="fantay-whale"` on its root element.

- Full cut (`app-icon.svg`, `logo.svg`, `logo-mark.svg`,
  `FantayDesign-master.svg`, `clipper/store/assets/icon.svg`,
  `素材库/导览支持/logo.svg`): the whole drawing on its night tile, the tile
  filling the canvas. Ground `#4547D4` → `#17184F`, line `#FFF4EA`, moon
  `#FF9F82`. Use at `>= 48 px`.
- Small cut (`app-icon-small.svg`, `FantayDesign-small.svg`,
  `apps/share/public/icon.svg`, `clipper/assets/mark*.svg`, the inline mark in
  `clipper/popup.html`, `素材库/导览支持/favicon.svg`): the same whale drawn
  larger and more than twice as heavy, without stars, spout, mouth or belly
  line. Use at `16–32 px`.
- `app-icon.png` (`tools/pack/resources/mac/icon.png`): `1024×1024` PNG of the
  full cut with the macOS margin round the tile; it is also the Dock icon in
  development. `logo.png` and `tools/pack/resources/linux/icon.png` are the
  same picture with the tile edge to edge.
- `tools/pack/resources/mac/icon.icns`, `tools/pack/resources/win/icon.ico`
  and the clipper's `icons/icon-*.png`: each size drawn at its own size, the
  small cut up to `64 px` and the full cut above it.
- `brand-icon.svg`: the small cut in one colour (`currentColor`), no tile, used
  by `.od-brand-glyph` CSS masks.
- `logo-scan.svg` / `logo-03.svg` / `logo-tiles.svg` (`clipper/assets/lockup*.svg`):
  horizontal lockup of the full cut beside the `Fantay` wordmark. The
  wordmark's letters are kept in the package as `Fantay-wordmark.svg`.
- The package also holds the drawing on no ground, for light and for dark
  surfaces (`Fantay-mark.svg`, `Fantay-mark-dark.svg`).
- The mascot is a separate thing from the logo. The startup splash
  (`apps/desktop/src/main/splash-screen.ts`) and the surface loaders star the
  sprite, drawn in `splash-character.ts` and `apps/web/public/fantay-sprite*.svg`;
  a test pins those two together. The folded-paper character that used to be
  the logo (`../doc/FantayDesign-SVG-package/`) now lives on only as mascot art.

### Known divergences

- The e2e loading waits match the loading text literally. When an application change adds
  a new `getByText('Loading OpenDesign…')` wait, swap it to the Fantay text
  when updating the test, or that wait returns immediately instead of synchronizing
  on the app mount.
- `apps/desktop` (dev dock icon) also reads `apps/web/public/app-icon.png`, so
  it shows the Fantay mark. Packaged installers now also use Fantay icons and identity.
- In the design-system kit viewer, `fantay`'s pages render with their tokens
  but in the fallback face (PingFang SC / system sans), not Albert Sans. The
  viewer's iframes are sandboxed without `allow-same-origin`, so their font
  requests come from an opaque origin and the daemon's `/api` origin guard and
  missing CORS headers block them. This holds for every package that bundles
  fonts. Opened directly (file:// or the 素材库 server), the pages use Albert
  Sans.
- First-run onboarding and the rail account entry now use Fantay / TokenToSea.
  See `docs/desktop-and-tokentosea-20261029.md` for the desktop and service boundaries.

## Desktop and TokenToSea (2026-10-29)

Use `mise run studio:desktop` from the parent workspace to build the embedded
OpenPencil canvas and start the macOS/Windows Electron shell. Packaging uses
Fantay identities and icons. The new `/canvas` and `/tokentosea` views
share the web/desktop runtime. See [implementation and acceptance](docs/desktop-and-tokentosea-20261029.md).
