import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { claimPackagedDownloadAttribution, discoverPackagedDownloadAttribution } from '../src/download-attribution.js';
import { captureStartupFailure } from '../src/startup-telemetry.js';
it('never sends packaged startup or crash telemetry even when a key is present',async()=>{
  const fetchImpl=vi.fn();
  await captureStartupFailure({posthogKey:'configured-test-key',posthogHost:'https://example.test',distinctId:'legacy',event:'packaged_runtime_failed',properties:{}},{fetchImpl});
  expect(fetchImpl).not.toHaveBeenCalled();
});
it('never discovers or claims packaged download attribution even when an installer observation exists',async()=>{
  const installerObservationRoot=await mkdtemp(join(tmpdir(),'od-no-attribution-'));
  const fetchSpy=vi.spyOn(globalThis,'fetch');
  try {
    await writeFile(join(installerObservationRoot,'download-attribution.json'),JSON.stringify({token:'oddl_policy_off_123',rawUrl:null}));
    const paths={installerObservationRoot} as Parameters<typeof discoverPackagedDownloadAttribution>[0];
    expect(await discoverPackagedDownloadAttribution(paths)).toBeNull();
    await claimPackagedDownloadAttribution({
      attribution:{token:'oddl_policy_off_123',rawUrl:null,source:'installer_observation_file',platform:'unknown'},
      daemonUrl:'http://127.0.0.1:17000',
      installerObservationRoot,
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
    await rm(installerObservationRoot,{force:true,recursive:true});
  }
});
