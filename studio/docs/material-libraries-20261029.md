# Multiple material libraries

The Materials page and the project material picker let the owner connect
ordinary folders or existing indexed archives, browse all libraries together,
or select one library. The selection survives reopening the view. A connected
folder can be named when it is added through the management form. Removing a
connection does not remove or change the original files.

An ordinary folder is scanned automatically when added. Its generated index
stays in daemon data, with immutable scan generations; the source folder is
not modified. Images, video, audio, fonts, SVG, HTML, Markdown and other files
are indexed from their names, paths and metadata. Hidden files, dependency/cache
directories and symlinks are skipped. Empty folders can be connected; adding
more than 50,000 files fails explicitly instead of claiming a partial scan is
complete. The management panel can rescan added/deleted files. Existing
`导览支持/search-index.json` archives retain their richer original metadata.

The sidebar and `/materials` now open the full content page. The narrow drawer
is reserved for inserting materials inside a project. The former legacy redirect
to the drawer was removed to honor the user's corrected navigation requirement.

## Ownership and identity

`apps/daemon/src/materials/libraries.ts` owns the connection registry and
aggregates the existing per-library service. The registry is derived from the
injected daemon data root; all daemon data path rules remain in `AGENTS.md`.
Sources are canonicalized, duplicate and symlinked selections are collapsed,
and registry writes are serialized and atomically renamed.

The environment/sibling default remains compatible. Explicitly connected
libraries use stable root-derived IDs, and API record IDs include their library
ID so two archives can contain the same record ID. Detail, children, thumbnails,
reference packets and copies keep the source identity. Previous raw references
to the default archive remain resolvable when it is explicitly connected.
An unavailable source remains listed while healthy sources can still be used.
Copy destinations are checked against every connected archive.

## API and CLI

- `GET /api/materials/libraries`: connected sources, status and counts.
- `POST /api/materials/libraries`: `{root, name?}`; local-request guard required.
- `DELETE /api/materials/libraries/:id`: disconnect only; local-request guard required.
- `POST /api/materials/libraries/:id/scan`: regenerate an ordinary folder's index.
- Existing summary/search accept optional `libraryId`; omitted means all sources.
- Existing detail/thumbnail/context/apply routes accept the returned qualified IDs.
- `od materials libraries`, `add-library <folder> [--name <name>]`, and
  `remove-library <id>` support `--json`.
- `od materials summary/search --library <id>` scopes the existing commands.
- `od materials scan-library <id>` rescans an ordinary folder.

The shared browser controls refresh both summary and search after connection
changes. Search invalidation is explicit because React can batch a fast
summary reload without ever committing an intermediate loading state.

## Verification

Focused daemon checks cover canonical duplicates, concurrent registration,
restart persistence, identical record IDs across archives, global pagination,
scoped lookup, unavailable sources, protected copy destinations, legacy IDs,
HTTP registration/disconnection, real thumbnail/copy routes and CLI parity.
Focused web checks cover folder selection/cancel, global/single-source switching,
restored selection, connection removal, grid invalidation, the existing picker
and all locale keys. Repository guard and root type checking passed.

The initial release below used no renderer automation. The folder-scanning and
full-page correction adds an isolated Playwright witness using temporary test
folders; it does not control the user's browser or desktop. The test verifies
the real sidebar route, content width, folder registration/rescanning and reload
persistence. A second case checks the reasoning selector's non-repeating arrow.

## Initial multi-library desktop acceptance (before the folder/full-page correction)

The existing `fantay` namespace and runtime data were retained. The updated
Mac package was installed and opened, and sidecar status confirmed a visible
`Fantaydesign` window. The existing Fantay archive was connected through the
HTTP API: 1,240 records, 365 matches for `组件`, correct scoped record identity,
detail paths and a successful thumbnail response. A second stop/start retained
the connection and passed the same reads. Evidence is in
`.tmp/material-libraries-20261029/acceptance.json` and the lifecycle JSON logs.

Final checks: 113 daemon tests, 32 web tests and one picker test passed; root
type checking and guard passed. The installed bundle passed
`codesign --verify --deep --strict`.

Package: `.tmp/desktop/Fantaydesign.dmg`, 434505661 bytes, SHA-256
`4e0d46d68cb628248ff477ba99118df89c0b2f762c41881ef1bbb11f49291251`.
The previous package remains at
`.tmp/desktop/Fantaydesign-before-material-libraries-20261029.dmg`.

The first packaging attempt under the Documents tree failed when a generated
GPU helper acquired `com.apple.FinderInfo`. Moving only the generated build
tree to a temporary directory, clearing its extended attributes, and rebuilding
there with `COPYFILE_DISABLE=1` resolved the nested-signature failure. No source
archive or user runtime data was cleared.

## Folder scanning, full-page navigation and reasoning selector correction

The follow-up desktop package was installed in the same `fantay` namespace.
The existing 1,240-item archive remained connected. The packaged API accepted
an ordinary temporary folder with no prepared index, served its SVG thumbnail,
rescanned additions/removals, and disconnected it while retaining its files.
The temporary acceptance source was removed after verification.

Validation passed: 115 focused daemon tests, 232 focused web tests, two actual
browser UI workflows, root type checking and guard. The isolated UI workflows
verified the real sidebar entry, full-width materials layout at desktop and
narrow widths, ordinary folder registration/rescanning and reload persistence.
They also checked the reasoning selector at 40px high / at most 320px wide,
Chinese labels and one non-repeating chevron in both light and dark themes.

The arrow defect came from the Fantay legacy select override restoring an
SVG background without the repeat/position/size contract. The override now
keeps that contract, and the reasoning field uses the shared Select primitive
instead of adding a second standalone chevron.

Final package SHA-256:
`3415a665985e6ab7c2d6f671cb0400ce3be8639fe6da06b3082f57c336a0ad9a`.
The previous package is retained as
`.tmp/desktop/Fantaydesign-before-folders-and-select-20261029.dmg`.
Current acceptance records are `folder-acceptance.json`, `folder-start.json`
and `acceptance.json` under `.tmp/material-libraries-20261029/`. Both the built
and installed app passed strict deep signature verification; no public release
or notarization was performed.
