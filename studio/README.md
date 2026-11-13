# Fantay Desktop

Fantay is a local-first desktop workspace for AI-assisted design, projects, materials, and video creation. The application lives in `studio/` within the private [fantay0312/fantay](https://github.com/fantay0312/fantay) repository.

## Run from source

Use an account with access to the private repository and install mise. Runtime versions are defined in `studio/mise.toml`.

```sh
git clone https://github.com/fantay0312/fantay.git
cd fantay/studio
mise x -- pnpm install --frozen-lockfile
cd ..
mise run studio
```

The command launches the desktop application. Local CLI agents are discovered by the daemon. TokenToSea and BYOK connections are configured in the application.

## Workspace

- `apps/` contains the desktop shell, renderer, local daemon, and supporting services.
- `packages/` contains contracts, shared components, runtime protocols, and platform primitives.
- `tools/` contains development, packaging, fixture-service, and release commands.
- `plugins/`, `skills/`, `design-templates/`, and `design-systems/` contain the application resources.
- GitHub configuration lives at `../.github/`. The default branch is `main`.

## Development

Run these commands from the repository root.

```sh
mise run studio:start
mise run studio:status
mise run studio:stop
mise run studio:guard
mise run studio:typecheck
```

Run focused tests for the affected packages through `mise run studio:test -- <command>`.

## Downloads and maintenance

The [Fantay website](https://design.tokentosea.com) provides product information and downloads. Public installers use the Fantay CDN. The private GitHub repository stores source code and maintainer release artifacts.

- [Quickstart](QUICKSTART.md)
- [Contributing](CONTRIBUTING.md)
- [Maintainer and release guide](MAINTAINERS.md)
- [Application architecture and development notes](FANTAY.md)
- [Agent guidance](AGENTS.md)

## Attribution

Fantay includes code originating from OpenDesign and other open-source projects. Original licenses and authorship are recorded in [LICENSE](LICENSE), [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), and the relevant source files.
