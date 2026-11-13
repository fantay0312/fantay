# Project design documents

Project .fig and .op files are managed by the design-document API and
od canvas. Global legacy documents remain readable without --project.
Use od canvas --help for import, export, cover, migrate and migrations.
Imports into projects use canonical paths and compare-and-swap preconditions;
exports refuse to overwrite an existing local output file.

The CLI returns JSON. Invalid flags exit 2; an unreachable daemon exits 64;
a missing project exits 68; other failures exit 1. Invalid canonical paths
include the server's suggested path when available.

The OpenPencil engine is pinned to 0.16.0. Its source provenance, licence,
and local patch list are in apps/canvas/THIRD_PARTY.md and the vendored
manifest. Before a 0.17 upgrade: compare its serialization and bridge APIs,
review every recorded patch, run the canvas suite, prove .fig round trips,
verify failed imports preserve the open document, and inspect both themes.
Do not claim the patch list is complete by adding an unimplemented patch.

.op viewing and conversion use the separate ZSeven SDK. The known CanvasKit
compatibility issue and conversion UI work remain in the UI handoff.
They do not justify silently changing the OpenPencil engine dependency.

Revision history and cover caches derive from the daemon data root described
in AGENTS.md. Startup removes cache directories only for deleted project IDs;
it does not traverse symbolic links or delete imported project folders.
