# Fantay distribution tools

This package retains the catalog publisher, DeepSeek bootstrap publisher and Fantay release preparation.

## Commands

Run these through mise from the Studio root.

- `pnpm tools-release export-catalog` exports the product content catalog.
- `pnpm tools-release render-catalog-previews` renders catalog previews.
- `pnpm tools-release pack-catalog` creates the checksummed content package.
- `pnpm tools-release publish-catalog` publishes a prepared catalog.
- `pnpm tools-release publish-dsh-bootstrap` publishes DeepSeek bootstrap installers.
- `node --experimental-strip-types tools/release/src/fantay-prepare.ts --version <version> --mac-arm64 <installer.dmg>` prepares Fantay installer copies, checksums and the CDN/GitHub publication plan.

Publication commands require the operator's explicit authorization. Local application builds and installer checks remain in `tools/pack`. The shared launcher-version-floor helper remains available to updater verification.

Historical branch-release commands and their tests are preserved in the workspace archive at `doc/achieve/studio-own-brand-20261107`.
