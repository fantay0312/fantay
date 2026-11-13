# Project boards and media operations

Each project owns a revisioned board. The HTTP API and od CLI use the same
store and authorization. The current UI assembly is separate work: the
presence of the backend does not mean the board tab is enabled.

Use od board --help for note, frame, selection, viewport, sync and import
commands. Commands accept --project, --daemon-url and --json. Mutations use
revision checks and never silently replace a newer edit. Importing the same
legacy design twice returns the existing node. A corrupt legacy document is
reported as invalid; a missing document is reported as not-found.

## Local media processing

POST /api/projects/:id/media/ops and od board media perform the same local
FFmpeg operations. They require project writeFiles authority, including for
imported-folder projects, and serialize against other public-file writes.

- crop: --input image.png --x 0 --y 0 --width 200 --height 100
- split: --input image.png --rows 2 --cols 3 --output-prefix parts/tile
- scale (also named upscale): --input image.png --factor 2, or --width/--height
- frame: --input clip.mp4 --time 0.5 --output frames/preview.png

Pass --project PROJECT_ID and optionally --json. Paths are relative to the
project. Absolute paths, traversal, unsupported media and output collisions
are rejected. Crops must fit the source; scale output edges are limited to
8192 pixels; splits allow up to 8 × 8 pieces. Split filenames use one-based
row/column suffixes, such as tile-r1c1.png. Outputs default to media-ops/.
Image processing is local resizing, not AI super-resolution.

Exit codes: 0 success; 2 invalid arguments; 64 daemon unreachable;
67 missing input; 68 missing project; 1 other failure.

No generation provider is called by these operations. Image/video generation
uses od board generate and requires a separately configured provider.
