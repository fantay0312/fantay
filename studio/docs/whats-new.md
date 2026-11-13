# Fantay update highlights

Release builds read the bundled highlight document in `apps/daemon/src/services/fantay-whats-new.ts`. The document identity controls the show-once card. Development builds show no card unless an explicit source is configured.

## Hosted content

`OD_WHATS_NEW_URL` can select a Fantay-hosted document or a local test fixture. Inherited OpenDesign service and repository addresses are ignored. An unreachable or malformed source produces no highlight.

`docs/whats-new.json` is a validated example for hosted publication. The repository guard checks its fields with the same parser used by the daemon.

```json
{
  "id": "fantay-release-id",
  "title": "Fantay update",
  "body": "Describe the shipped change.",
  "linkUrl": "https://design.tokentosea.com",
  "ctaLabel": "Visit Fantay"
}
```

Optional `imageUrl` and `linkUrl` fields use HTTPS. Optional `locales` entries can override `title`, `body`, `linkUrl`, and `ctaLabel`. Publishing an empty object retires a hosted highlight. Change `id` when a new highlight should appear.

The daemon exposes `GET /api/whats-new`, also available through `od whats-new --json`. Publication is an explicit maintenance task using the configured Fantay distribution service.
