# Run this on Windows:
mise run studio:build:windows
```

Desktop product/app identities and installer icons are Fantay's. Updating is
disabled until an explicit `OD_UPDATE_METADATA_URL` is provided, so a Fantay
installation cannot replace itself with an upstream OpenDesign release.
The build-cache contract now includes the canvas source and generated assets.

## Acceptance and remaining gates

Browser and macOS development-shell checks cover real canvas creation,
daemon persistence, reopening and HTML-frame import; `.op` parsing/preview
was exercised with a synthetic one-page document. The latter is not evidence
of full compatibility with complex third-party documents.

The macOS ARM64 DMG was built, installed into the tools-pack test namespace,
and launched. The installed application passed first-run entry, two-layer
creation, Chinese text and coordinate editing, save, refresh and reopen.
Noto Sans CJK SC is bundled for offline glyph coverage; a Chinese SVG that
still names Inter also renders and exports correctly through the fallback.
The DMG's read-only mounted application passes `codesign --verify --deep
--strict` with an ad-hoc signature. It has no Developer ID notarization.

Artifact: `.tmp/desktop/Fantaydesign.dmg`
(432282924 bytes). SHA-256:
`1b92e7fd0d89e83d925ad50e3be675dfea2676c09b64b4f7afe979d320774e37`.
Screenshot: `.tmp/canvas-acceptance/final-mac-desktop.png`.

The startup wordmark now reads `Fantaydesign`, with the existing pixel-scan
animation and F icon. The desktop's inline SVG matches `public/logo-scan.svg`;
both the scan and assembled states were captured from the Electron splash.
Startup screenshot: `.tmp/splash-brand/splash-assembled.png`.

Failed-import regressions were exercised in both directions: saved FIG →
malformed OP and saved OP → malformed FIG. The prior view, document ID and
format are restored before saving; the OP bytes retain the same SHA-256.
The code review confirmed the rollback fix. This does not claim exhaustive
malformed-file compatibility.

On this Mac, the synced Documents folder can reattach Finder metadata to a
bundle while signing. The build task therefore stages the app under the OS
temporary directory and copies the completed DMG back to `.tmp/desktop`.
Strict signature checking remains enabled; the final DMG was verified from
a read-only mount. The current staging tree is exposed through
`.tmp/native-build-20261029`, a symlink to its local temporary directory.

Checks passed: 18 TokenToSea PostgreSQL integration cases, 4 Fantay
identity/storage cases, the service-view and default-agent cases, packaged
window-title cases, and 33 packaging/cache/identity cases (one Windows-only
case skipped on macOS). Workspace guard and type checking passed.

Focused daemon identity/storage tests pass. The TokenToSea integration suite
and existing official-execution/market tests use an isolated PostgreSQL
database with synthetic identities, signing material and simulated upstream
results; they do not incur real provider charges. Validation logs and visual
evidence live under the workspace's `.tmp` folder.

Still requires release approval and environment-specific acceptance:
TokenToSea production deployment/migration, real account consent and service
calls, hosted HTTPS callback configuration, Windows installer execution,
macOS signing/notarization, and live Penpot/Doop server connectors. A working
format adapter must not be described as live collaboration or lossless
interchange.

## MyGo assessment

The user asked whether to adopt `egoist/mygo`. No MyGo dependency or migration
was introduced. The current recommendation is to keep Electron for this
delivery and measure a separate MyGo shell against the same complex canvas
before deciding. MyGo's system WebView and Go UI can reduce shell overhead;
the existing Node services, CanvasKit, fonts, media tools and host bridge
still need to be accounted for. This is an engineering recommendation, not
a user-approved framework switch.

## Upstream evidence

- <https://github.com/open-pencil/open-pencil/blob/master/packages/vue/README.md>
- <https://github.com/ZSeven-W/openpencil/blob/main/packages/op-web-sdk/README.md>
- <https://github.com/penpot/penpot/blob/develop/mcp/README.md>
- <https://github.com/kgoedecke/doop/blob/main/README.md>
- <https://docs.tokentosea.com/connect/oauth/>
# Subsequent CLI and packaging completion

Project-scoped design commands are available with od canvas --project.
The legacy global list/import/export commands remain supported. Unknown
arguments return 2, an unreachable daemon returns 64, and a missing project
returns 68. Exports refuse to overwrite files.

All three platform package lists include @fantay/tokens and
@fantay/tokentosea. The resource tree also carries LICENSE,
THIRD_PARTY_NOTICES.md and licenses/. This is source and packaging-path
validation; it does not substitute for installing a new Windows build.

## Fantay desktop, design canvas and TokenToSea

Later online-sharing deployment: [TokenToSea sharing](tokentosea-share-deployment-20261029.md).

## Implemented locally

The existing Next.js / daemon / Electron architecture remains the shared
application for web, macOS and Windows. `apps/canvas` builds the actual
OpenPencil editor into Web public assets; the host displays this local editor
inside the normal Fantay navigation. No remote editor website is embedded.

The canvas provides frame, rectangle, ellipse and text creation; nested
layers; position, dimensions, rotation, fill and text properties; components,
auto layout, undo/redo, `.fig` save/open, SVG/PNG/HTML export. Files persist in
the daemon's managed data directory under the root AGENTS contract, with
optimistic conflict detection and retained previous source revisions.
`od canvas list|show|import|export` uses the same API.

| Source | Current integration | Explicit boundary |
| --- | --- | --- |
| open-pencil/open-pencil | Core + Vue SDK 0.16.0; real editable scene and `.fig` IO | Not the complete upstream product UI |
| ZSeven-W/openpencil | Official Web SDK 0.8.0; `.op` preview and SVG export | Read-only; original `.op` bytes retained |
| Penpot | Import/export SVG into editable vector layers | No Penpot server, live team sync or `.penpot` archive import |
| Doop | Import HTML or a canvas JSON containing `frames`; convert HTML into layers; export HTML | No Doop server, comments, live collaboration or lossless HTML round-trip |

The npm OpenPencil release needed two local build compatibility adaptations:
published worker URLs still ended in `.ts`; CSSOM's browser entry did not
export the parser expected by the SDK. Vite uses the published `.js` workers
and CSSOM's CommonJS entry. These transformations are bounded to the pinned
dependencies, without editing `node_modules`.

## Account and services

The free-credit promotion and the Feishu/X/email icon row are removed from
the rail. First-run onboarding also presents Fantay and TokenToSea instead
of the upstream cloud-registration promotion. Local agents and existing
projects remain available; Claude Code remains selectable, without probing
or live model testing in this change.

Fantay's daemon handles S256 PKCE, state, nonce, issuer, RS256 signature,
audience, expiry and subject checks. Upstream tokens are stored in a private
daemon-owned file, never in browser storage. Refresh is serialized per
session; stale callbacks and stale refreshes cannot resurrect or overwrite a
newer session. Desktop authorization uses the system browser and the fixed
loopback callback `http://127.0.0.1:47654/callback`.

The normal first-party entry is TokenToSea `#/fantay-connect`, using the
reserved public client `fantay-design`. It still passes through explicit
TokenToSea consent and the user's spending limits. No client secret is
shipped. TokenToSea deployment sets `FANTAY_APP_OWNER_ID` to a platform-owned
account; the first customer is never made the owner of the shared client.
The new TokenToSea service view proxies model catalogs, tool catalogs,
tool actions/quotes/invocations, wallet reads and official-model operations.
It passes only the selected operation to the daemon; upstream bearer tokens
never reach the renderer. Existing Connect clients keep the legacy catalog
unless they request `includeOfficial=1`.

The account connection does not replace Vela's team/collaboration authority.
The service view is a separate account-backed entry; existing local agent
selection is not silently rewritten to a different provider.

## TokenToSea source changes

Changes are in the local `tokentosea-cn` workspace, not yet deployed:

- Platform-managed first-party Fantay registration and a login handoff page.
  Only server-configured callbacks are admitted; old pending requests and
  codes are invalidated when callbacks are removed.
- `/api/v1/connect/official/*` delegates the existing official model service.
  Each grant receives a separate internal identity and isolated run/resource
  ownership. Public Connect credentials cannot become universal API keys.
- Official executions reserve, extend, checkpoint, settle and release both
  the wallet and the OAuth grant consistently. Extensions enforce the total
  per-call cap, not only the incremental reservation. Revocation blocks new
  execution and refresh/heartbeat admission while already-incurred charges
  can still settle.
- Migration: `20261029010000_fantay_delegated_official_models`. It was applied
  only to an isolated disposable PostgreSQL database during validation.

For a hosted web deployment, set `TOKENTOSEA_REDIRECT_URI` on the Fantay
server to its exact HTTPS `/api/tokentosea/callback` URL, and list that URL in
TokenToSea's `FANTAY_WEB_CALLBACKS`. Desktop keeps the fixed loopback callback.

## Running and packaging

From the Fantay Design parent folder:

```sh
mise run studio:desktop
mise run studio:canvas
mise run studio:build:mac
