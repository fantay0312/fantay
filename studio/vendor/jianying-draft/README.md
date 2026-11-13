# Pinned draft-format compatibility runtime

This is the independently verified FantayDesign draft lab 0.1.0 from
`fantay-design/doc/剪映`, frozen on 2026-11-03. The JavaScript files are retained
as a tested compatibility runtime, with integration patches for the bundled
ffprobe path and subtitle error redaction. Application
policy, version discovery, project authority and UI live in TypeScript in the
daemon, contracts and renderer. `worker.ts` runs the runtime in an isolated
Node 24 process and uses no global CLI or external documentation directory.

Upstream generation provenance and the two local patches are in
`vendor/provenance.json`. MIT licenses and source notices are in `licenses/`.
No Jianying engine libraries, commercial resources, research repositories or
precompiled native executables are redistributed. Native code is compiled
against the locally installed matching application into the daemon data root.

The root pack resource inventory includes this entire directory. Update the
Windows resource-tree determinant when changing its shipped content inventory.
