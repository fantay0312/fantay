# Fantaydesign brand and creation update

Later the same day, TokenToSea online sharing was implemented and deployed.
Its current status supersedes the sharing limitations in this earlier record;
see [TokenToSea sharing deployment](tokentosea-share-deployment-20261029.md).

The display name is **Fantaydesign** across the web shell, desktop windows,
menus, update and recovery dialogs, diagnostics downloads, localized product
copy and bundled design-system descriptions. The F icon and pixel-scan splash
remain. Existing package IDs, file formats, `od://` links, storage keys and
the Windows uninstall registry key keep their compatibility identities.
Upstream attribution and real third-party URLs remain intact. The optional
Vela service is named Vela rather than being presented as a Fantaydesign-owned
cloud provider.

The leftover free-credit/signup promotion in Settings was removed. The main
product login remains TokenToSea; selecting the optional Vela provider keeps
its own authorization flow separate.

## Highlights source

Release builds now serve `apps/daemon/src/services/fantay-whats-new.ts` by
default. They no longer fetch upstream announcements automatically. The
matching editorial export is `docs/whats-new.json`. An explicitly configured
`OD_WHATS_NEW_URL` still works; its display text is rebranded without changing
its links. The running app version continues to come from `/api/version`.

## Requested upstream features

The screenshot's highlights match the upstream
[0.26.1 release](https://github.com/nexu-io/open-design/releases/tag/open-design-v0.26.1).
The current checkout already contains the relevant implementations:

- Skill discovery: `od-default` and the `od-next` rollout select task guidance
  and preserve it for revisions. The app keeps the previously configured
  local-agent preference.
- Public sharing: publish, stop/resume, identity recovery and anchored
  comments are present. Actual online publication still requires the existing
  sharing service and a valid account/workspace. This change does not claim
  that TokenToSea hosts public shares or that live sharing was tested.
- Motion: the shared player guards against repeated audio seeks after a
  rendering stall; previews and exports use the same timeline normalization.

This was a targeted integration audit, not a wholesale merge of the upstream
release branch. No live model call, account authorization or public upload was
performed.

## Validation

Focused checks cover localized copy and placeholders, update documents and
their source selection, home skill routing, retained share state, motion
playback and export clocks, desktop dialogs, packaging identities and Windows
payload paths. Workspace type checking and repository guards pass. Windows
native behavior remains untested on this Mac.

The Mac artifact is `.tmp/desktop/Fantaydesign.dmg`. It is a local ad-hoc-signed
test build, not a notarized public release. Build and verification logs and
UI captures live in `.tmp/brand-unification/`.

Artifact size: 432159073 bytes. SHA-256:
`2d0b8da2ee7d0c9bac1a8373158f9e57ca8ed82122c647ac20564b917169226b`.
