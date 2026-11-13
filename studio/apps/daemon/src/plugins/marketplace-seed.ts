import fs from 'node:fs';
import { safeExternalFetch } from './plugin-asset-cache.js';
import path from 'node:path';

export const OFFICIAL_MARKETPLACE_ID = 'official';
export const OFFICIAL_PLUGIN_SOURCE_REPO = 'github:fantay0312/fantay@main/studio';

export interface MarketplaceSeedEntry {
  name: string;
  [key: string]: unknown;
}

export interface MarketplaceSeedConfig {
  trust: 'official' | 'restricted';
  url: string;
}

export interface MarketplaceSeedFetchResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
}

export interface MarketplaceSeedHelpers {
  defaultMarketplaceSeedConfig(id: string): MarketplaceSeedConfig;
  bundledPluginRegistrySource(sourcePath: string): string;
  marketplaceSeedManifestText(id: string, bundledMarketplaceEntries: readonly MarketplaceSeedEntry[]): Promise<string | null>;
  createMarketplaceFetcher(
    seedId: string | null | undefined,
    bundledMarketplaceEntries: readonly MarketplaceSeedEntry[],
  ): (url: string) => Promise<MarketplaceSeedFetchResponse>;
}

export interface MarketplaceSeedHelperDeps {
  bundledPluginsDir: string;
  projectRoot: string;
  pluginRegistryDir: string;
  marketplaceManifestUrlForRegistry(id: string): string;
  marketplaceRegistryIdFromUrl(url: string): string | null;
  fetchImpl?: typeof fetch;
}

export function createMarketplaceSeedHelpers(deps: MarketplaceSeedHelperDeps): MarketplaceSeedHelpers {
  const fetchImpl = deps.fetchImpl ?? fetch;

  function defaultMarketplaceSeedConfig(id: string): MarketplaceSeedConfig {
    return {
      trust: id === OFFICIAL_MARKETPLACE_ID ? 'official' : 'restricted',
      url: deps.marketplaceManifestUrlForRegistry(id),
    };
  }

  function bundledPluginRegistrySource(sourcePath: string): string {
    if (isPathWithin(deps.bundledPluginsDir, sourcePath)) {
      return path.resolve(sourcePath);
    }
    const rel = path.relative(deps.projectRoot, sourcePath).split(path.sep).join('/');
    if (!rel || rel.startsWith('..')) return sourcePath;
    return `${OFFICIAL_PLUGIN_SOURCE_REPO}/${rel}`;
  }

  async function marketplaceSeedManifestText(
    id: string,
    bundledMarketplaceEntries: readonly MarketplaceSeedEntry[],
  ): Promise<string | null> {
    if (id === OFFICIAL_MARKETPLACE_ID) {
      return JSON.stringify({ specVersion: '1.0.0', version: '1.0.0', name: 'Fantay', owner: { name: 'Fantay', url: 'https://design.tokentosea.com' }, metadata: { bundledPreinstallCount: bundledMarketplaceEntries.length }, plugins: bundledMarketplaceEntries });
    }
    const manifestPath = path.join(deps.pluginRegistryDir, id, 'open-design-marketplace.json');
    if (!fs.existsSync(manifestPath)) return null;
    const manifestText = await fs.promises.readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestText) as { plugins?: MarketplaceSeedEntry[] };
    if (!Array.isArray(manifest?.plugins)) return manifestText;
    const sourcePrefix = `${OFFICIAL_PLUGIN_SOURCE_REPO}/`;
    manifest.plugins = manifest.plugins.map((entry) => {
      if (typeof entry.source !== 'string' || !entry.source.startsWith(sourcePrefix)) return entry;
      const localPath = path.resolve(deps.projectRoot, entry.source.slice(sourcePrefix.length));
      if (!isPathWithin(path.join(deps.projectRoot, 'plugins'), localPath) || !fs.existsSync(localPath)) return entry;
      return { ...entry, source: localPath };
    });
    return JSON.stringify(manifest);
  }

  function createMarketplaceFetcher(
    seedId: string | null | undefined,
    bundledMarketplaceEntries: readonly MarketplaceSeedEntry[],
  ): (url: string) => Promise<MarketplaceSeedFetchResponse> {
    return async (url) => {
      const registryId = deps.marketplaceRegistryIdFromUrl(url);
      if (registryId && (!seedId || registryId === seedId)) {
        const manifestText = await marketplaceSeedManifestText(registryId, bundledMarketplaceEntries);
        if (manifestText != null) {
          return {
            ok: true,
            status: 200,
            text: async () => manifestText,
          };
        }
      }
      if (registryId) return { ok: false, status: 404, text: async () => 'Bundled catalog unavailable' };
      const response = await safeExternalFetch(url, {}, fetchImpl);
      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
      };
    };
  }

  return {
    defaultMarketplaceSeedConfig,
    bundledPluginRegistrySource,
    marketplaceSeedManifestText,
    createMarketplaceFetcher,
  };
}

function isPathWithin(base: string, target: string): boolean {
  const relativePath = path.relative(path.resolve(base), path.resolve(target));
  return (
    relativePath === '' ||
    (relativePath.length > 0 &&
      !relativePath.startsWith('..') &&
      !path.isAbsolute(relativePath))
  );
}
