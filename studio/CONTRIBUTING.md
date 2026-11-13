# Contributing to Fantay

The repository is [fantay0312/fantay](https://github.com/fantay0312/fantay), with `main` as its default branch. The application is under `studio/`, and shared GitHub configuration is under `.github/` at the repository root.

## Development setup

Follow [QUICKSTART.md](QUICKSTART.md). Run application commands through mise and read [AGENTS.md](AGENTS.md) plus the guidance for the package you edit.

## Ownership

- Application features belong in their existing `apps/` modules.
- Shared web/daemon contracts belong in `packages/contracts`.
- Packaging belongs in `tools/pack`. Release preparation and storage publication belong in `tools/release`.
- Functional skills belong in `skills/`. Rendering templates belong in `design-templates/`.
- Plugin authoring follows [plugins/AGENTS.md](plugins/AGENTS.md) and its checked-in schema.

## Pull requests

Use a descriptive title and the [repository PR template](../.github/pull_request_template.md). Explain the user need, the behavior changed, and the checks performed. Include screenshots when the visible interface changes.

Keep changes focused, preserve unrelated work, and retain source licenses and attribution. Review external source imports against the specific Fantay requirement that they address.

## Validation

From the repository root, run the following checks and focused tests for affected behavior.

```sh
mise run studio:guard
mise run studio:typecheck
mise run studio:test -- pnpm --filter @open-design/daemon test tests/fantay-product-policy.test.ts
```

The GitHub validation workflow is manually triggered from Actions. It runs the guard and workspace typecheck.

## Maintenance

Use [MAINTAINERS.md](MAINTAINERS.md) for repository ownership, release preparation, and public distribution. [FANTAY.md](FANTAY.md) records application architecture and inherited-code provenance.
