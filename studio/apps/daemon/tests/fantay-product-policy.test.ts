import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { readAppConfig, writeAppConfig, automaticDiagnosticsConsent } from '../src/app-config.js';
import { createAnalyticsService, readPosthogConfig } from '../src/analytics.js';
import { readRunTelemetrySinkConfig, readTelemetrySinkConfig } from '../src/langfuse-trace.js';
import { createAttributionService } from '../src/routes/attribution.js';
import { DiagnosticRelay } from '../src/integrations/diagnostic-relay.js';
import { createMarketplaceSeedHelpers } from '../src/plugins/marketplace-seed.js';

describe('Fantay product privacy and bundled sources', () => {
  it('overrides old opt-ins and refuses new telemetry opt-ins', async () => {
    const dir=await mkdtemp(join(tmpdir(),'fantay-policy-'));
    try {
      await writeFile(join(dir,'app-config.json'),JSON.stringify({installationId:'legacy',telemetry:{metrics:true,content:true}}));
      expect((await readAppConfig(dir)).telemetry).toMatchObject({metrics:false,content:false});
      expect((await readAppConfig(dir)).installationId).toBeNull();
      await writeAppConfig(dir,{telemetry:{metrics:true,content:true}});
      expect((await readAppConfig(dir)).telemetry?.metrics).toBe(false);
      expect(automaticDiagnosticsConsent(dir)).toBe(false);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it('does not initialize analytics, telemetry sinks or relay requests even when configured', async () => {
    const env={POSTHOG_KEY:'test',POSTHOG_HOST:'https://example.test',LANGFUSE_PUBLIC_KEY:'public',LANGFUSE_SECRET_KEY:'secret',OPEN_DESIGN_TELEMETRY_RELAY_URL:'https://example.test/api/langfuse'};
    expect(readPosthogConfig(env)).toBeNull();
    expect(readTelemetrySinkConfig(env)).toBeNull();
    expect(readRunTelemetrySinkConfig(env)).toBeNull();
    const analytics=createAnalyticsService({dataDir:'/unused',env});
    await analytics.captureSafety({eventName:'test',appVersion:'1.0.0',properties:{}});
    const fetcher=vi.fn();
    await expect(new DiagnosticRelay('https://example.test',()=>true,fetcher).register(new AbortController().signal)).rejects.toThrow('reporting_disabled');
    expect(fetcher).not.toHaveBeenCalled();
    const attribution=createAttributionService({analytics,env,paths:{RUNTIME_DATA_DIR:'/unused'},appConfig:{readAppConfig:async()=>({telemetry:{metrics:true}})},fetchImpl:fetcher});
    expect((await attribution.claim({token:'old',source:'mac_where_froms'})).status).toBe('invalid');
    expect(await attribution.processPending()).toBeNull();
    expect(await attribution.bridgeUrl('https://design.tokentosea.com')).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('builds the official catalog from local registered plugins and never fetches it remotely', async () => {
    const dir=await mkdtemp(join(tmpdir(),'fantay-catalog-'));
    try {
      await mkdir(join(dir,'plugins'),{recursive:true});
      const fetcher=vi.fn();
      const h=createMarketplaceSeedHelpers({bundledPluginsDir:join(dir,'plugins'),projectRoot:dir,pluginRegistryDir:join(dir,'registry'),marketplaceManifestUrlForRegistry:id=>'https://example.test/'+id,marketplaceRegistryIdFromUrl:()=> 'official',fetchImpl:fetcher});
      const local=join(dir,'plugins','demo');
      expect(h.bundledPluginRegistrySource(local)).toBe(local);
      expect(h.bundledPluginRegistrySource(join(dir, 'external', 'demo')))
        .toBe('github:fantay0312/fantay@main/studio/external/demo');
      const response=await h.createMarketplaceFetcher('official',[{name:'demo',source:local}])('https://example.test/official');
      expect(response.ok).toBe(true);
      expect(JSON.parse(await response.text()).plugins).toEqual([{name:'demo',source:local}]);
      expect(fetcher).not.toHaveBeenCalled();
    } finally { await rm(dir,{recursive:true,force:true}); }
  });

  it('loads checked-in community plugins locally while retaining explicit third-party sources', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fantay-community-'));
    try {
      const localPlugin = join(dir, 'plugins', 'community', 'demo');
      const registry = join(dir, 'registry', 'community');
      await mkdir(localPlugin, { recursive: true });
      await mkdir(registry, { recursive: true });
      await writeFile(join(registry, 'open-design-marketplace.json'), JSON.stringify({
        plugins: [
          { name: 'community/demo', source: 'github:fantay0312/fantay@main/studio/plugins/community/demo' },
          { name: 'external/example', source: 'github:example/plugins@v1' },
        ],
      }));
      const helpers = createMarketplaceSeedHelpers({
        bundledPluginsDir: join(dir, 'plugins', '_official'),
        projectRoot: dir,
        pluginRegistryDir: join(dir, 'registry'),
        marketplaceManifestUrlForRegistry: id => `https://example.test/${id}`,
        marketplaceRegistryIdFromUrl: () => 'community',
      });
      const manifest = JSON.parse((await helpers.marketplaceSeedManifestText('community', []))!);
      expect(manifest.plugins[0].source).toBe(localPlugin);
      expect(manifest.plugins[1].source).toBe('github:example/plugins@v1');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
