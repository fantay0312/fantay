# Desktop workspace unification — 2026-10-30

The user rejected the previous account-only repair and requested the full
desktop layout, palette and density be aligned with Palmier. This supersedes
the visual-acceptance wording in earlier progress notes.

## Scope delivered

- Desktop host palette now follows the native editor's light/dark surfaces,
  neutral active controls, system UI font, compact radii and separators.
  Artwork and embedded preview documents keep their own design tokens.
- The host sidebar is 220 px with a 36 px top row. Home is a stable, left-aligned
  workspace; settings has one navigation column and flat provider rows instead
  of nested floating cards. Shell-published geometry matches the actual CSS.
- A Mac video project opens its native timeline automatically once. The host
  keeps shared account/agent execution mounted and shows the project/media
  page, not another disabled timeline. Native chat/generation returns do not
  reopen the editor or steal focus.
- The original native AgentMessageView/Markdown renderer is reused. Chat has a
  compact header, an empty state, and scrolling that respects older messages.
  Available channels are grouped; unavailable channels are collapsed together.
- Native AI sidebar has a 320 px readable minimum and an automatic 320 px cap;
  manual expansion remains possible. Media/inspector widths hold as the viewer
  takes extra space. Initial split sizing waits for the real visible window,
  and old provisional layouts no longer override the new default.
- Native Home/Settings have consistent opaque surfaces, compact account identity
  and structured account settings. Account/model actions continue through the
  existing TokenToSea host session. No Google/Clerk login was reintroduced.
- `DesktopNativeBridge` is mounted above page routing in App. Account, channel
  and appearance sync therefore stays active in Settings and other non-movie
  pages. Switching dark → system while remaining in Settings was verified
  against the native snapshot; the final preference was restored to system.
- Cold native startup waits up to 60 seconds for the MCP service rather than
  failing after 7.5 seconds. Explicit open focuses the editor; background tool
  calls reuse the bound project without bringing a window forward.

## Validation

- Web/daemon typechecks, native build and repository guard passed.
- Focused shell/channel/native-entry tests passed, including automatic open
  once, suppression of focus stealing for bridge actions, and desktop geometry.
  The final global-bridge run passed 23 tests across three files.
- Installed the rebuilt main/native app at `/Applications/Fantaydesign.app`,
  preserving the previous bundle and all project data.
- Confirmed one settings navigation column, corrected Home width and neutral
  palette in actual installed screenshots.
- Confirmed automatic native project open, native chat display, 320 px AI column
  in windowed and fullscreen layouts, playback and editable audio properties.
- A real Codex read through the hidden host execution reported two video clips
  and two audio clips. Project starts/durations remained unchanged.
- TokenToSea account action returns to the host account page; both surfaces were
  signed out during acceptance. No paid media generation was invoked.

Artifacts under `.tmp/palmier-alignment`:

- `unified-home-final.png`, `unified-settings-final.png`.
- `unified-editor-dark-final.jpg` (native UI after layout correction).
- `unified-ai-chat.json`, `unified-flow-inspect.json`.
- `unified-global-sync-verified.json`, `unified-global-bridge-tests.log`.
- `unified-final-tests.log`, `unified-final-guard.log`.
- `unified-delivery-package.log`, `unified-final-install.json`.

Final installer: `.tmp/desktop/Fantaydesign.dmg`.
SHA-256: `f546d42d180b7f3aa121ba84aa1c1c9888e8db13dd359e851f8ab59ffb31eac6`.
Local ad-hoc bundle signature verification passed. Formal notarization and
Windows-native acceptance are outside this local Mac delivery. No commit,
push, remote deployment, or deletion of user projects was performed.
