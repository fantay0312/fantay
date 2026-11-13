import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { createAttributionService } from '../src/routes/attribution.js';
import { createAnalyticsService } from '../src/analytics.js';
import { readInstallationFile, writeInstallationFile } from '../src/installation.js';

it('does not persist or transmit new attribution, even with legacy opt-in and ledger credentials',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fantay-attribution-'));
  try {
    const fetcher=vi.fn();
    const service=createAttributionService({paths:{RUNTIME_DATA_DIR:root},analytics:createAnalyticsService({dataDir:root,env:{}}),appConfig:{readAppConfig:async()=>({installationId:'legacy',telemetry:{metrics:true}})},env:{OD_ATTRIBUTION_LEDGER_URL:'https://example.test',OD_ATTRIBUTION_LEDGER_TOKEN:'test'},fetchImpl:fetcher});
    expect((await service.claim({token:'old-token',source:'mac_where_froms'})).status).toBe('invalid');
    expect(await service.bridgeUrl('https://design.tokentosea.com')).toBeNull();
    expect(await readInstallationFile(root)).toEqual({});
    expect(fetcher).not.toHaveBeenCalled();
  } finally {await rm(root,{recursive:true,force:true});}
});

it('does not replay an old pending attribution record',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fantay-old-attribution-'));
  try {
    const pending={token:'old-token',source:'mac_where_froms',capturedAt:'2026-01-01T00:00:00Z'};
    await writeInstallationFile(root,{pendingAttribution:pending});
    const fetcher=vi.fn();
    const service=createAttributionService({paths:{RUNTIME_DATA_DIR:root},analytics:createAnalyticsService({dataDir:root,env:{}}),appConfig:{readAppConfig:async()=>({telemetry:{metrics:true}})},fetchImpl:fetcher});
    expect(await service.processPending()).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  } finally {await rm(root,{recursive:true,force:true});}
});
