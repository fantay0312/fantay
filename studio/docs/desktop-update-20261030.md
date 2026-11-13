# FantayDesign desktop update — 2026-10-30

The installed macOS app at `/Applications/FantayDesign.app` was replaced and
relaunched. The package version remains `0.25.1`; the installed bytes contain
the TokenToSea migration and the interface corrections below.

## User decisions and changes

- Public branding is **FantayDesign**, with an uppercase D. This supersedes
  the earlier `Fantaydesign` display-name convention. The About panel, window
  title, display name and copyright use the corrected name.
- Settings navigation uses one fixed icon column and left-aligned labels.
  The narrow-window navigation now has the container its scrolling rules require.
- The native video project library belongs in the main **Video and animation**
  area. Existing projects and covers are listed there, linked projects are
  deduplicated, and the native project picker remains available.
- The actual native timeline editor keeps its own window. Hosted startup,
  returning home and closing the last project do not show a second native home.

## Packaging and integration details

The internal Electron bundle/executable identity and the existing
`Library/Application Support/Fantaydesign/namespaces/fantay` data root remain
stable. Changing the internal bundle name caused an early startup failure on
this Mac; display branding is set separately.

Native launch arguments use `--fantay-data-dir=<path>`. A separate bare path
was treated as an input document by macOS and opened an error dialog.

The native editor owns registry and cover reads. The daemon obtains the
library through the native project service, rather than directly opening the
protected Documents folder from a background Electron helper. The native
service waits for registry initialization before answering. The user also
confirmed granting the macOS Documents access prompt during verification.

OpenCode `1.18.18` is included independently. No Vela executable is present.
The live agent directory advertises `tokentosea` as available and does not
advertise `amr` or `vela`.

## Verification

- Web, daemon, desktop, packaged-app and packaging type checks passed.
- Settings, film-library, native-launch and desktop-bridge regression tests
  passed, including project deduplication and returning to the main library.
- Native library/RPC tests, desktop menu tests and packaged window-title
  tests passed. The native app compiled and the launch-argument checks passed.
- Repository guard and the focused layout detector passed.
- The read-only DMG and installed app passed strict deep signature checks.
- Installed health, TokenToSea status, agent directory, native library and
  project-cover endpoints returned HTTP 200.
- An existing native project opened through the installed daemon. Native
  status confirmed one visible editor, hosted mode and no home window. Closing
  it saved successfully, left zero open projects and did not show the home.
- Three host project IDs and two saved identity sessions were retained; the
  identity file digest is unchanged. Native project JSON is semantically
  identical after the open/save/close check (serialization formatting changed).

The original app and data are retained under
`~/Library/Application Support/Fantaydesign/backups/desktop-20261030-230834`.
The installer is `.tmp/desktop/Fantaydesign.dmg` (531039100 bytes), SHA-256:
`8dcd3fb850b1ff25eb40167557caa82e970676f650b8e663300074b876a8042f`.
Detailed local evidence is in `.tmp/desktop-update-20261030/`.

This was a local macOS update. No commit, push, cloud deployment or paid model
generation was performed. Updated collaboration services still require their
separate deployment. No new browser or computer-use automation was used.
