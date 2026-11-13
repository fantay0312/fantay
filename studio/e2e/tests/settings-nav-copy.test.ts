/**
 * In-app destination drift gate.
 *
 * When the daemon or the agent tells a user to go fix something —
 * "no Fal API key — configure it in Settings → …" — it names a place in the
 * app. Nothing tied that name to the screen it points at, so it drifted: media
 * errors and the od-media-generation skill kept pointing at a section called
 * "Media" after the nav item had been renamed to "Media providers"
 * (`媒体生成提供商` in zh-CN), and users following the instruction found no such
 * entry. That was V0.19.1 acceptance bug recvre8FrTE2Oa.
 *
 * `packages/contracts/src/settings-nav.ts` is now the single place a
 * destination is spelled. This gate holds the two ends together:
 *
 *   1. Each constant names something the UI ACTUALLY RENDERS as navigation.
 *   2. No producer re-inlines its own guess.
 *   3. No referenced prompt or skill names a destination that does not exist.
 *
 * ## Why this reads the rendered navigation, not the i18n dictionary
 *
 * The first version of this gate compared each constant to its i18n key's
 * value. That is too weak, and PR review caught it: `settings.externalMcpTitle`
 * ("External MCP") is still in the dictionary, but `mcpClient` lost its Settings
 * sidebar nav item and external MCP moved out to a top-level page, now Plugins.
 * So a dictionary-based check happily green-lit "Settings → External MCP" — a
 * destination no user can navigate to — and the gate meant to catch dead paths
 * would have spent the rest of its life defending one.
 *
 * A key surviving in the dictionary proves nothing about reachability. This
 * version therefore parses the actual rendered nav (`settings-nav-item` buttons
 * in `SettingsDialog.tsx`, the rows in the Fantay `Sidebar.tsx`,
 * `INTEGRATION_SURFACES` in `PluginsView.tsx`) and resolves those keys through
 * the dictionary — dictionary as a lookup, rendered markup as the source of
 * truth.
 *
 * Lives in `e2e/tests/` per the root `AGENTS.md` boundary rule — it reads
 * `apps/web`, `apps/daemon`, `packages/contracts`, and `plugins/` together,
 * which no single app package is allowed to do.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

type DestinationContracts = {
  SETTINGS_MODELS_AND_PROVIDERS: string;
  SETTINGS_MEDIA_PROVIDERS: string;
  SETTINGS_MEDIA_PROVIDERS_PATH: string;
  PLUGINS: string;
  PLUGINS_MCP: string;
  PLUGINS_MCP_PATH: string;
};

const navModules = import.meta.glob<DestinationContracts>(
  '../../packages/contracts/src/settings-nav.ts',
  { eager: true },
);
const nav = Object.values(navModules)[0];
if (!nav) {
  throw new Error(
    'destination gate could not load packages/contracts/src/settings-nav.ts via import.meta.glob; '
      + 'this almost always means the file was renamed or moved.',
  );
}

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

function read(relative: string): string {
  return readFileSync(path.join(REPO_ROOT, relative), 'utf8');
}

/** Resolve one `'key': 'value'` entry from the English locale dictionary. */
function englishLabel(key: string): string {
  const en = read('apps/web/src/i18n/locales/en.ts');
  const match = en.match(
    new RegExp(`^\\s*['"]${key.replace(/\./g, '\\.')}['"]\\s*:\\s*(['"])((?:\\\\.|(?!\\1).)*)\\1`, 'm'),
  );
  if (!match) throw new Error(`i18n key ${key} is missing from apps/web/src/i18n/locales/en.ts`);
  return match[2]!.replace(/\\(['"\\])/g, '$1');
}

/**
 * The labels the Settings sidebar actually renders as nav items.
 *
 * Sections can keep a render block after losing their nav entry (the file's own
 * comment lists workspace / mcpClient / composio / designSystems as exactly
 * that), so presence of a section constant — or of its i18n key — is not
 * evidence a user can reach it. Only a `settings-nav-item` button is.
 */
function renderedSettingsNavLabels(): readonly string[] {
  const source = read('apps/web/src/components/SettingsDialog.tsx');
  const labels = [...source.matchAll(
    /settings-nav-item[\s\S]{0,400}?<strong>\{t\(\s*'([^']+)'\s*\)\}<\/strong>/g,
  )].map((m) => englishLabel(m[1]!));
  if (labels.length === 0) {
    throw new Error(
      'could not parse any settings-nav-item labels from SettingsDialog.tsx — '
        + 'the nav markup changed shape and this gate needs updating, not deleting.',
    );
  }
  return labels;
}

/**
 * The tab labels the Settings ▸ Models & providers switch actually renders.
 *
 * Reads the markup inside `settings-execution-sticky` — the same "rendered, not
 * merely in the dictionary" rule as the sidebar parser above.
 */
function renderedProvidersTabLabels(): readonly string[] {
  const source = read('apps/web/src/components/SettingsDialog.tsx');
  const block = source.match(/className="settings-execution-sticky"[\s\S]*?<\/div>\s*<\/div>/)?.[0];
  if (!block) throw new Error('could not locate settings-execution-sticky in SettingsDialog.tsx');
  const labels = [...block.matchAll(/className="seg-title">\{t\(\s*'([^']+)'\s*\)\}<\/span>/g)]
    .map((m) => englishLabel(m[1]!));
  if (labels.length === 0) {
    throw new Error(
      'could not parse any Models & providers tab labels from SettingsDialog.tsx — '
        + 'the tab markup changed shape and this gate needs updating, not deleting.',
    );
  }
  return labels;
}

/** The top-level pages the Fantay sidebar actually renders as rows. */
function renderedSidebarLabels(): readonly string[] {
  const source = read('apps/web/src/fantay/shell/sidebar/Sidebar.tsx');
  const labels = [...source.matchAll(/<DashNavItem\b[\s\S]*?\{t\(\s*'([^']+)'\s*\)\}\s*<\/DashNavItem>/g)]
    .map((m) => englishLabel(m[1]!));
  if (labels.length === 0) {
    throw new Error(
      'could not parse any DashNavItem labels from Sidebar.tsx — the nav markup '
        + 'changed shape and this gate needs updating, not deleting.',
    );
  }
  return labels;
}

/**
 * The tab labels the Plugins page's switch renders beside 插件 and 技能.
 *
 * The id → i18n key mapping is irregular (`connectors` resolves to
 * `entry.tabConnectors`, not `integrations.tabLabel.connectors`), so this reads
 * the `labelKey`s from `INTEGRATION_SURFACES` instead of assuming a convention,
 * and requires the list to still be mapped into the markup.
 */
function renderedPluginsTabLabels(): readonly string[] {
  const source = read('apps/web/src/components/PluginsView.tsx');
  const surfaces = source.match(/const INTEGRATION_SURFACES[\s\S]*?\n\] as const;/)?.[0];
  if (!surfaces) throw new Error('could not locate INTEGRATION_SURFACES in PluginsView.tsx');
  if (!/INTEGRATION_SURFACES\.map\(/.test(source)) {
    throw new Error('PluginsView.tsx no longer renders INTEGRATION_SURFACES');
  }
  const labels = [...surfaces.matchAll(/labelKey:\s*'([^']+)'/g)].map((m) => englishLabel(m[1]!));
  if (labels.length === 0) {
    throw new Error(
      'could not parse any Plugins tab labels — the page changed shape and '
        + 'this gate needs updating, not deleting.',
    );
  }
  return labels;
}

describe('destinations quoted to users', () => {
  it('names a Settings section the sidebar actually renders', () => {
    expect(renderedSettingsNavLabels()).toContain(nav.SETTINGS_MODELS_AND_PROVIDERS);
  });

  it('names a Models & providers tab the section actually renders', () => {
    expect(renderedProvidersTabLabels()).toContain(nav.SETTINGS_MEDIA_PROVIDERS);
  });

  it('names a Plugins tab the page actually renders', () => {
    expect(renderedSidebarLabels()).toContain(nav.PLUGINS);
    expect(renderedPluginsTabLabels()).toContain(nav.PLUGINS_MCP);
  });

  // Regression guard for the review finding on PR #6831. The first version of
  // this gate would have passed with "External MCP" as a Settings destination,
  // because `settings.externalMcpTitle` is still in the dictionary. If this
  // assertion ever fails it means either the label came back to the sidebar (fine
  // — delete this test) or the gate stopped reading rendered markup (not fine).
  it('rejects a label that survives in the dictionary but renders nowhere', () => {
    const stale = englishLabel('settings.externalMcpTitle');
    expect(stale).toBe('External MCP');
    expect(renderedSettingsNavLabels()).not.toContain(stale);
  });

  // Same failure one level up: `entry.navIntegrations` outlived the Integrations
  // page's navigation entry, and the system prompt kept sending users there.
  it('rejects a top-level page that survives in the dictionary but renders nowhere', () => {
    const stale = englishLabel('entry.navIntegrations');
    expect(stale).toBe('Integrations');
    expect(renderedSidebarLabels()).not.toContain(stale);
  });

  it('writes a destination as "<Area> → <Section>"', () => {
    expect(nav.SETTINGS_MEDIA_PROVIDERS_PATH).toBe(
      `Settings → ${nav.SETTINGS_MODELS_AND_PROVIDERS} → ${nav.SETTINGS_MEDIA_PROVIDERS}`,
    );
    expect(nav.PLUGINS_MCP_PATH).toBe(`${nav.PLUGINS} → ${nav.PLUGINS_MCP}`);
  });

  it('never sends a media-credential error to a bare, unnamed "Settings"', () => {
    const source = read('apps/daemon/src/media/index.ts');
    const offenders = source
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      // Only lines that actually instruct the user, not prose comments.
      .filter(([, line]) => /configure[^\n]*\bin Settings\b|key in Settings\b/.test(line))
      .filter(([, line]) => !line.trimStart().startsWith('//'));
    expect(offenders).toEqual([]);
  });

  it('routes every media-credential error through the shared destination', () => {
    const source = read('apps/daemon/src/media/index.ts');
    // Sanity: the file really does still carry these errors, so an accidental
    // deletion cannot make the gate above vacuously pass.
    const routed = source.match(/\$\{SETTINGS_MEDIA_PROVIDERS_PATH\}/g) ?? [];
    expect(routed.length).toBeGreaterThanOrEqual(25);
  });

  it.each([
    'plugins/_official/scenarios/od-media-generation/SKILL.md',
    'apps/daemon/src/prompts/system.ts',
    'packages/contracts/src/prompts/system.ts',
    'skills/hatch-pet/SKILL.md',
    'plugins/_official/examples/hatch-pet/SKILL.md',
  ])('does not name a destination that does not exist: %s', (relative) => {
    // Markdown wraps mid-phrase, so compare against whitespace-normalized text
    // — otherwise "Settings → Media\n  providers" reads as a section named
    // "Media" and the gate reports a violation that isn't one.
    const text = read(relative).replace(/\s+/g, ' ');
    // Each area lists only what lives inside it, so "Settings → MCP" fails too.
    // Integrations has no entries: the page left the navigation, so every path
    // into it is dead.
    const destinations: Record<string, readonly string[]> = {
      Settings: [
        ...renderedSettingsNavLabels(),
        // Sub-sections folded into General keep their own heading inside it.
        'Pets',
      ],
      Plugins: renderedPluginsTabLabels(),
      Integrations: [],
    };
    for (const match of text.matchAll(/\b(Settings|Plugins|Integrations)\s*(?:→|->)\s*/g)) {
      const rest = text.slice(match.index! + match[0].length);
      // A template expression is the constant itself, already verified above.
      if (rest.startsWith('${')) continue;
      const known = destinations[match[1]!]!;
      expect(
        known.some((section) => rest.startsWith(section)),
        `${relative} points at "${match[0]}${rest.slice(0, 40)}…", which the UI does not render. `
          + `Rendered destinations in ${match[1]}: ${known.join(', ') || 'none'}.`,
      ).toBe(true);
    }
  });
});
