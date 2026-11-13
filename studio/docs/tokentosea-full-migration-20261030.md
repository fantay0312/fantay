# TokenToSea cloud migration — 2026-10-30

This is a **local implementation and validation record**, not a production release.
At the end of the initial migration, the installed desktop package and online
services had not been upgraded. The subsequent local desktop update is recorded
in [desktop-update-20261030.md](desktop-update-20261030.md); online deployment
remains separate.

## Replaced dependencies

| Previous Vela dependency | Current implementation |
| --- | --- |
| Separate account and device-login process | Shared TokenToSea OAuth identity; browser and desktop account events refresh the same consumers |
| Vela ACP process wrapping OpenCode | Independent pinned OpenCode 1.18.18; daemon-owned, revocable inference access for each run |
| Model catalog and Vela plan eligibility | TokenToSea catalog, real grant limits and wallet; no invented Vela subscription tiers |
| Managed image/video CLI | TokenToSea official catalog, prepare/invoke/poll and archived output assets |
| Workspace/member authority | TokenToSea-authenticated collaboration service in `apps/share` |
| Resource push/pull and team catalog | Immutable, checked snapshots with owner/project binding, version checks and correlated batch receipts |
| Team comments, presence and events | Authoritative member identity, comment cursors, presence expiry and a persistent event journal |
| Public-share publish/stop/resume and legacy share helpers | The existing TokenToSea share service, including compatible publication receipts and viewer redirects |
| Invitation creation and continuation | One-use TokenToSea invitation links; the UI does not claim an email was sent |
| Stock-photo search | TokenToSea endpoint backed by Wikimedia Commons with author and license metadata |
| Vela package acquisition | Independent `opencode-ai` dependency and native runtime; packaged verification rejects a retained Vela binary |
| Upstream promotional inbox | Retired; bundled Fantaydesign release notes remain the product announcement source |

The old `amr` selection and `vela/...` model prefixes remain accepted as migration
identifiers. Some internal source filenames and test fixtures retain upstream names.
They are not an instruction to load Vela credentials or launch its executable.

## Account and execution boundaries

- OAuth credentials stay in `@fantay/tokentosea`. They are never delivered to the
  renderer or OpenCode. The local inference capability pins the account and model,
  and is revoked when its run finishes or the account logs out/starts reauthorization.
- The migrated `fantay_session` cookie covers the daemon API. Older narrow cookies
  are read and promoted without copying the provider credentials into a browser.
- Signed-out HTTP requests cannot use remembered background identities. A background
  operation needs one unambiguous account for its workspace; multiple possible
  accounts are rejected rather than selected arbitrarily.
- Model calls retain the actual catalog listing ID, price revision, idempotency key
  and OAuth spending limits. Agent execution lists only token-priced models whose
  catalog declares tool calling. Media availability comes from the live official
  catalog. Unsupported parameters fail rather than silently changing a requested ratio.
- OpenCode runs with its own account-specific config/data/state directories and
  external plugins disabled. The app continues to provide its selected MCP tools.

## Collaboration and files

The sharing service now owns a separate collaboration database and checked blobs.
It verifies the TokenToSea identity on requests, then verifies workspace membership
and project authority. A team viewer can comment and read shared content; only the
project owner can replace its source files. Resource IDs cannot be reused to publish
a different private project's bytes into an existing shared resource.

Snapshots are limited to 20 MiB and 1,000 files. Per-workspace-member history is
limited to 1,000 versions and 2 GiB. Each workspace admits at most 100 members.
Paths, hashes, symlinks, source ownership and versions are checked. Rejected pushes
do not retain newly created blobs. Downloads use temporary files and preserve the
existing staged-publication boundaries.

Invite links are single-use, expire after seven days, and can be used by their
holder. They do not prove ownership of an email address. An invitation already used
by a removed member cannot be used to rejoin. Only the owner may invite an admin.

Existing local files and upstream cloud data are not bulk moved, deleted or assigned
to a guessed TokenToSea identity. Old cloud records need an explicit, separately
reviewed data-import path if they must be copied.

## CLI and packaging

`od tokentosea login|status|logout` uses the running daemon. `od resource` also goes
through its guarded local CLI route and requires an explicit workspace. Its help
works without a daemon. The compatibility `od amr` command selects the TokenToSea
implementation.

The runtime dependency is `opencode-ai@1.18.18`. Platform packages supply OpenCode
directly; no Vela executable is copied. The MIT notice is retained in
`licenses/opencode-MIT.txt`. Package identity checks retain version/hash/path checks
and reject a Vela executable in the output.

## Validation and release boundary

Validation includes:

- Real OpenCode execution through the local TokenToSea proxy, including a write-tool
  call and subsequent answer. The model replies were supplied by a local test server.
- Local HTTP integration of team publishing, authorized staged download, public-share
  stop/resume, comments and shared-resource v1/v2 updates with batch correlation.
- Regression tests for signed-out requests, cross-project resource reuse, failure
  cleanup, account-bound inference, cancellation, model availability and asset hosts.
- A real, read-only Commons search that returned licensed image metadata.
- Focused frontend, contract, prompt, packaging and service tests, type checks and
  the repository guard. The normal full daemon/web test suites were not run.
- An isolated daemon startup and healthy TokenToSea status endpoints. The user's
  existing runtime data was not used for these checks.

Final isolated startup returned HTTP 200 for health, TokenToSea account status,
and the agent directory. The directory reported `tokentosea` available and did
not advertise `amr`; the retired `/api/integrations/vela/status` returned 404.
The isolated daemon was stopped after acceptance. The local account CLI status
and resource help were also exercised.

No real model generation was billed, no code was committed or pushed, no online
service was deployed, and no replacement desktop installer was distributed.

Before online acceptance, deploy the updated sharing/collaboration service and the
TokenToSea API changes. Confirm the already-prepared delegated-official-model
migration and endpoints are present; the earlier sharing-only deployment did not
establish that. Then validate a real account's consent, model execution and team
workflow. Windows execution and a fresh desktop-package install still require
environment-specific acceptance.
