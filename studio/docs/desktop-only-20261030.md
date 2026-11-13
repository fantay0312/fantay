# FantayDesign desktop-only product — 2026-10-30

The user explicitly retired the standalone browser edition. FantayDesign is
a desktop product; future previews and acceptance should use the desktop
window rather than offer a localhost workbench URL.

## Implementation

- `ClientApp` mounts the workbench only behind `DesktopAppGate`. A normal
  browser sees a short desktop-app handoff and can use the established
  `opendesign://workspace/open` deep link. The desktop pet surface uses the
  same boundary.
- The gate uses the validated `@open-design/host` bridge, not the user agent,
  a URL parameter or browser storage. It is a product-entry restriction, not
  a replacement for server-side authorization.
- `apps/web` remains the Electron renderer. Removing that package would break
  the desktop application. OAuth callbacks, local CLI/MCP APIs and public
  deliverable sharing remain available.
- `mise run studio` and `mise run studio:start` launch the desktop application.
- Internal browser renderer tests may explicitly set
  `NEXT_PUBLIC_FANTAY_RENDERER_DEV=1` in development. Production builds ignore
  that flag. The shared Playwright test harness sets it for its renderer tests.
- Product documentation now identifies the desktop-only distribution and
  separates the preserved upstream OpenDesign web/Docker reference material.

## Verification

- Eight focused checks passed: ordinary browser denial, invalid host denial,
  macOS/Windows/Linux desktop hosts, explicit development mode, production
  rejection of that mode, and host-boundary enforcement.
- Repository guard and full workspace typecheck passed.
- The isolated desktop runtime reached `data-od-app-mounted="1"`, reported
  `windowVisible: true`, and displayed the main workspace. The desktop video
  overview remains available.
- The previous web-only preview runtime was stopped and restarted with its
  desktop host. The in-app-browser control returned `browser.user is
  unavailable`, so its old tab could not be closed through that control; this
  did not prevent stopping the standalone preview or validating the desktop.

This is a local source/runtime change. The application in `/Applications`
has not been replaced, and no commit, push or deployment was performed.
