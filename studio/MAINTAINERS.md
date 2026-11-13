# Fantay maintenance and releases

## Repository

- Source repository is `fantay0312/fantay`, currently private, on branch `main`.
- Git operations run from the parent of `studio/`.
- Maintainer ownership is recorded in `../.github/CODEOWNERS`.
- External changes are reviewed for a specific Fantay requirement before import.

## Checks

Run `mise run studio:guard`, `mise run studio:typecheck`, and focused tests from the repository root. The manual GitHub workflow is `../.github/workflows/ci.yml`.

## Installer preparation

Build and validate platform installers through `tools/pack`. Prepare versioned assets from `studio/` using the verified installer paths.

```sh
mise x -- node --experimental-strip-types tools/release/src/fantay-prepare.ts --version 1.0.0 --mac-arm64 /absolute/Fantay.dmg --out .tmp/fantay-release/1.0.0
```

The output includes versioned installers, SHA-256 checksums, CDN metadata, private GitHub metadata, and `publish-plan.json`.

## Distribution

- Public downloads and update metadata use `https://static.tokentosea.com/fantay-design`.
- The public update channel uses CDN metadata and its verified installer URLs.
- GitHub release artifacts in the private repository require repository access. Use them for maintainer archives.
- Publish immutable versioned assets first, verify checksums and read-back, and update `releases/stable/latest/metadata.json` last.
- Packaged updates are enabled through an explicitly configured Fantay `OD_UPDATE_METADATA_URL` after the feed and platform installer have been verified.

## Content and bootstrap publication

`tools-release export-catalog`, `render-catalog-previews`, and `pack-catalog` prepare content from the `studio/` application tree. `publish-catalog` uses explicitly supplied `RELEASE_STORAGE_*` settings.

`publish-dsh-bootstrap` prepares the third-party DeepSeek Harness installer wrappers for explicitly configured Fantay storage. The CMD template uses a sibling PowerShell file locally and receives a versioned installer URL during publication.

## Update highlights

The default highlight card comes from `apps/daemon/src/services/fantay-whats-new.ts`. Hosted highlight documents can be validated using `docs/whats-new.json` and the repository guard. See [docs/whats-new.md](docs/whats-new.md).
