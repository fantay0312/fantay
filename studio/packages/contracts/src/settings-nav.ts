// Names of the in-app destinations that non-UI surfaces send users to.
//
// The daemon's provider errors and the agent's system prompt both tell users
// where to go and fix something ("configure it in Settings → …"). Those strings
// are written far away from the screens they name, so they drift: an error kept
// pointing at a section called "Media" long after the nav item was renamed, and
// users hunting for it found nothing (V0.19.1 acceptance bug recvre8FrTE2Oa).
//
// Every such destination must be spelled here, once, and every producer must
// read it from here rather than inlining its own guess. Each constant's value
// is the ENGLISH label the app renders, so it stays verifiable:
// `e2e/tests/settings-nav-copy.test.ts` resolves the labels the UI ACTUALLY
// RENDERS as navigation and fails the build when a constant names something
// unreachable.
//
// That gate deliberately checks the rendered navigation rather than the i18n
// dictionary. A key can survive in the dictionary long after nothing renders
// it — which is exactly how `Settings → External MCP` stayed in the prompt
// after external MCP moved out of Settings entirely.
//
// These are English labels. A localized client renders the same destination
// under its own translation, so a destination quoted to the user in another
// language should be the translation of this label, not this literal.

/** How a destination is written when pointing a user at it: `Settings → Privacy`. */
export function destinationPath(...segments: readonly string[]): string {
  return segments.join(' → ');
}

/** The Settings nav item that hosts the CLI, API and media provider tabs — `settings.envConfigure`. */
export const SETTINGS_MODELS_AND_PROVIDERS = 'Models & providers';

/** The tab of that section where media/API-generation credentials are entered — `settings.mediaProviders`. */
export const SETTINGS_MEDIA_PROVIDERS = 'Media providers';

/** `Settings → Models & providers → Media providers` — the destination for every missing-credential error. */
export const SETTINGS_MEDIA_PROVIDERS_PATH = destinationPath(
  'Settings',
  SETTINGS_MODELS_AND_PROVIDERS,
  SETTINGS_MEDIA_PROVIDERS,
);

/** The top-level Plugins page — `entry.navPlugins`. NOT a Settings section. */
export const PLUGINS = 'Plugins';

/** The Plugins page tab that adds/reconnects external MCP servers — `integrations.tabLabel.mcp`. */
export const PLUGINS_MCP = 'MCP';

/**
 * `Plugins → MCP` — where a user reconnects an external MCP server.
 *
 * NOT under Settings. `McpClientSection` still has a Settings render block, but
 * it lost its sidebar nav item and is now reachable there only through an
 * `initialSection` deep link, so telling a user to open "Settings → External
 * MCP" sends them somewhere they cannot navigate to.
 *
 * NOT "Integrations" either. That page no longer has a navigation entry: its
 * tabs moved into the Plugins page's switch, and only the `/integrations` route
 * and the `integrations.*` i18n keys keep the old name.
 */
export const PLUGINS_MCP_PATH = destinationPath(PLUGINS, PLUGINS_MCP);
