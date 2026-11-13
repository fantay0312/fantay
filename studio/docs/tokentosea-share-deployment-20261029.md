# TokenToSea sharing deployment

Public site: **https://design.tokentosea.com**. The site runs an independent
sharing service; the privileged local design daemon is not exposed publicly.

## Runtime and ownership

- `apps/share` owns the HTTPS-facing share API, public viewer, account dashboard
  and comments. `packages/tokentosea` owns the shared OAuth client used by this
  service and the local daemon.
- TokenToSea client ID: `fantay-design`, public client, S256 PKCE. The web
  callback is `https://design.tokentosea.com/api/auth/callback`; the existing
  desktop callback remains `http://127.0.0.1:47654/callback`.
- The web comment login requests only `openid profile offline_access`.
  Every publish/comment/state mutation revalidates its current access token
  through TokenToSea's `GET /api/v1/connect/fantay/identity`. That endpoint
  rejects grants for other OAuth clients. User IDs and author names never
  come from the publish/comment request body.
- The main TokenToSea API was changed only in the OAuth service and controller.
  Its existing full-source build has unrelated Feishu/shared-type gaps. The
  two modified modules were compiled with its existing TypeScript settings,
  syntax-checked, audience-tested, backed up and deployed individually. No
  unrelated local TokenToSea changes were uploaded.

## Server layout

- Service: `fantay-share.service`, unprivileged user `fantay-share`.
- Node: `/opt/fantay-runtime/node-v24.21.0-linux-x64/bin/node`.
- Releases: `/opt/fantay-share/releases/`; active symlink:
  `/opt/fantay-share/current`.
- Active server release: `20261029-share-3`.
- Persistent SQLite database, immutable artifact versions and OAuth sessions:
  `/var/lib/fantay-share`, private to the service user.
- Settings: `/etc/fantay-share.env`, root-readable only. Never copy its content
  into source control or logs.
- Listener: `127.0.0.1:47800`. Caddy terminates HTTPS using its automatically
  issued certificate and forwards only this site's traffic to that listener.
- Caddy include: `/etc/caddy/fantay-share.caddy`. Original site configuration
  is retained, with backups before each share release.

## Local app integration

The artifact Share panel uses `/api/tokentosea/shares/...`. The daemon builds
the dependency plan locally, then sends only those files to the fixed sharing
origin. The old Vela public-share reads/writes are inactive on this surface.
Canvas shares reuse the same panel and publish a saved HTML snapshot. Comments
are refreshed in the panel without requiring a Vela workspace.

Limits are explicit: 20 MiB per publication, 500 files, 1 GiB and 500 versions
per account, 20 GiB total. Quota is reserved before file staging and checked
again in the commit transaction. At most two large uploads are read at once.
A share holds at most 500 non-deleted comments; excess submissions are refused
instead of being silently hidden.

## Security and lifecycle

Owner checks govern updating, stopping and restoring a share. The alias stays
stable across updates. Stop returns HTTP 410 for metadata, comments and all
artifact versions; resume keeps the same URL and snapshot. Comment drafts
carry the snapshot version, so a changed publication requires reselection.

Public HTML runs with an opaque sandbox origin, no authenticated network
access and no service-worker access. Direct raw-HTML requests receive the same
HTTP CSP protection as iframe previews. Login cookies are host-only,
HttpOnly, Secure, SameSite=Lax; cookie mutations also require same-origin and
CSRF-token checks. Bearer tokens stay in the daemon/server, not the renderer.

## Verification

- Real TokenToSea login returned the `fantay` account to the new domain.
- The account published a deliberately public, non-private verification
  artifact and posted a targeted comment. A forged request author was ignored;
  the returned author was `fantay`.
- Stopping returned 410 for both metadata and raw artifact; restoring retained
  its URL and version.
- The user independently opened the deployed viewer and supplied a screenshot
  showing interactive content, the correct comment, and the isolation probe.
- The equivalent local viewer was exercised in a browser: the counter works
  and selecting a heading returns its exact target to the comment panel.
- Focused tests cover OAuth state/nonce/refresh isolation, app-audience checks,
  upload path/hash/size validation, account ownership, idempotency, quotas,
  stopped access, comment limits and the no-Vela frontend integration.

The verification artifact is explicitly labeled as a test, contains no
private project material, and is not represented as a user-created design.

The deployed database and immutable assets were snapshotted under
`/var/backups/fantay-share/20261029-deployed`. The internal system-owned fixture
was stopped; the owner's clearly labeled acceptance example remains available
for review.

Client package: `.tmp/desktop/Fantaydesign.dmg`, 432282924 bytes, SHA-256
`1b92e7fd0d89e83d925ad50e3be675dfea2676c09b64b4f7afe979d320774e37`.
The earlier download filename remains a symlink to this package. It was built
and signature-checked; it is not notarized for public distribution.

The user asked to stop Computer Use. The control session was reset and no
further screen operations were performed. On the subsequent explicit request,
the new package was installed and launched through the packaging CLI while
preserving the existing runtime data.

Desktop acceptance used sidecar status and backend checks only. The user
completed the desktop OAuth authorization manually; its account was `fantay`.
The installed TokenToSea client passed identity validation, publication,
idempotent retry, comment author/anchor readback, stop (HTTP 410), and restore
of the same link. The test publication was stopped afterwards. The probe did
not modify the desktop credential file and did not automate the renderer,
Chrome, or the user's screen. Results: `.tmp/desktop-check/result.json`.
