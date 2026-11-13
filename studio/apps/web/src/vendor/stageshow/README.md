# Stageshow kit (vendored)

`kit/` from the `stageshow` skill in [benjitaylor/skills](https://github.com/benjitaylor/skills), MIT (`LICENSE`).
The project's copy of the skill is recorded in `skills-lock.json` at the workspace root.

Differences from upstream, so an update can be redone by hand:

- `brands/` and `parts/BrandMark.*` are removed: third-party artwork the product has no use for, under its own terms.
- Seven files start with `// @ts-nocheck`, because upstream does not build under this app's `noUncheckedIndexedAccess`.

Import from the module you need (`./stage`, `./motion`, `./window`, `./parts`), not from `index.ts`: the barrel pulls in
every stylesheet, phones and message bubbles included. The demos built on this are in `src/fantay/stageshow/`.
