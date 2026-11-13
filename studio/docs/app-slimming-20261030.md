# FantayDesign size reduction — 2026-10-30

The installed macOS app was slimmed from the existing, verified application.
It was not rebuilt from unrelated uncommitted application changes.
The app version, internal bundle identity, public FantayDesign name and data
locations are unchanged.

## Results

| Item | Before | After |
| --- | ---: | ---: |
| Installed app, allocated bytes | 1,378,050,048 | 1,180,262,400 |
| Active DMG | 531,039,100 | 474,319,633 |
| Historical backups | 17 old copies, about 23.19 GB | One current baseline, about 1.79 GB |

The app is approximately 14.4% smaller on disk. The DMG is approximately
10.7% smaller. The backup directory reduction is about 21.4 GB; this is a
directory allocation comparison, not a guarantee about APFS snapshot space.

The sole rollback copy is
`~/Library/Application Support/Fantaydesign/backups/desktop-slim-baseline-20261030`.
It contains the previously installed application, a checked namespace snapshot
and the native video project folder. Its SQLite snapshot passed `quick_check`.

## What changed

- Removed 115,971,480 bytes of ONNX native binaries for other operating systems
  and CPU architectures. The complete macOS ARM64 runtime remains available.
- Hardlinked 43,683,050 bytes of identical Next.js, CanvasKit and esbuild files.
  All original paths remain. Files with different bytes, modes or ownership,
  and symbolic links, are not deduplicated.
- Removed a 14,568,162-byte duplicate native resource bundle after comparing
  its 121 resource files against the flattened application resources.
- Removed 18,114,640 bytes of native debug symbols with `strip -S`. All 45
  non-debug code, data and Swift reflection sections remained byte-identical.

The source packaging hook applies architecture pruning and path-preserving
deduplication before signing. The native build script keeps one resource tree
and strips debug symbols before signing. Speech/MLX resources, the OpenCode
runtime, design content, licenses and the complete native source archive remain.

Before signing, all 16,228 retained non-native-executable files matched the
original app. Only the explicitly listed foreign binaries, duplicate resource
tree and debug metadata were removed or changed.

## Validation

- Twelve focused packaging tests passed, including runtime-path preservation,
  hardlink idempotence, mismatched-file protection and target-architecture guards.
- Packaging type checks, repository guard and native build-script syntax checks passed.
- The staged, mounted and installed app passed strict deep code-signature checks.
- The DMG and installed copy retain the expected hardlinks.
- Packaged Next.js/React, esbuild compilation and ONNX native loading passed.
- Installed health, project list, agent directory, home/settings/movie pages,
  both CanvasKit URLs, a native project cover and native project opening passed.
- The native editor ran in hosted mode, opened the existing project and closed
  it successfully without showing a separate home window.
- Host project IDs, identity bytes and saved-session count are unchanged.
  Native project paths are unchanged. Native opening/closing saves view state,
  so whole-file byte equality is not used as a native-project-content claim.

The active installer is `.tmp/desktop/Fantaydesign.dmg`. SHA-256:
`d8fde6102da60f5703b5b8fb6328b0553aa6f90738c2cce4681b192323660fbd`.
Detailed evidence is under `.tmp/app-slim-20261030/`.
No code was committed or pushed and no cloud service was deployed.
