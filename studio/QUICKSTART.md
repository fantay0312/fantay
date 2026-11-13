# Fantay quickstart

## Install dependencies

Install mise, then clone the private repository with an authorized GitHub account.

```sh
git clone https://github.com/fantay0312/fantay.git
cd fantay/studio
mise x -- pnpm install --frozen-lockfile
cd ..
```

`studio/mise.toml` selects Node 24 and pnpm 10.33.2. The root `mise.toml` provides workspace commands.

## Launch the desktop application

```sh
mise run studio
```

For background operation, use `mise run studio:start`, `mise run studio:status`, and `mise run studio:stop`.

Configure TokenToSea, BYOK, or an installed CLI agent in the application. Projects, credentials, and runtime state use the daemon data-directory contract in [AGENTS.md](AGENTS.md#daemon-data-directory-contract).

## Validate a change

```sh
mise run studio:guard
mise run studio:typecheck
mise run studio:test -- pnpm --filter @open-design/daemon test tests/fantay-product-policy.test.ts
```

Choose focused test files for the behavior being changed. Package names and `od` remain the established CLI and workspace interfaces.

## Build installers

```sh
mise run studio:build:mac
```

The Windows task is `mise run studio:build:windows` on Windows. See [MAINTAINERS.md](MAINTAINERS.md) for release preparation and distribution.
