import { describe, expect, it, vi } from 'vitest';
import { fetchReleaseMetadata } from '../../../src/main/updater/feed.js';
import { resolveDesktopUpdaterConfig } from '../../../src/main/updater/config.js';
import { SIDECAR_SOURCES } from '@open-design/sidecar-proto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createDesktopUpdater } from '../../../src/main/updater.js';
describe('Fantay update mirrors',()=>{
  it('does not accept a retired upstream feed from inherited configuration',()=>{
    expect(resolveDesktopUpdaterConfig({source:SIDECAR_SOURCES.PACKAGED,env:{OD_UPDATE_METADATA_URL:'https://releases.open-design.ai/stable/latest/metadata.json'}}).enabled).toBe(false);
  });
  const config=()=>resolveDesktopUpdaterConfig({source:SIDECAR_SOURCES.PACKAGED,env:{OD_UPDATE_METADATA_URL:'https://static.tokentosea.com/fantay-design/releases/stable/latest/metadata.json'}});
  it('uses GitHub when the domestic feed is unavailable',async()=>{
    const fetcher=vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValueOnce(new Response(JSON.stringify({channel:'stable',releaseVersion:'1.0.0'})));
    expect(await fetchReleaseMetadata(fetcher,config())).toMatchObject({releaseVersion:'1.0.0'});
    expect(fetcher.mock.calls[1]?.[0]).toBe('https://github.com/fantay0312/fantay/releases/latest/download/metadata.json');
  });
  it('does not contact the mirror when the domestic feed works',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({channel:'stable'})));
    await fetchReleaseMetadata(fetcher,config()); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('downloads the same verified installer from GitHub after the primary artifact fails',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'fantay-mirror-'));
    const bytes='verified installer fixture';
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const mirror='https://github.com/fantay0312/fantay/releases/download/v1.1.0/test.dmg';
    const metadata={channel:'stable',releaseVersion:'1.1.0',platforms:{mac:{enabled:true,arch:'arm64',artifacts:{dmg:{name:'test.dmg',url:'https://primary.example.test/test.dmg',fallbackUrls:[mirror],sha256,size:bytes.length}}}}};
    const fetcher=vi.fn(async(input: string | URL | Request)=>{
      const url=String(input);
      if(url.endsWith('metadata.json'))return new Response(JSON.stringify(metadata));
      if(url===mirror)return new Response(bytes,{headers:{'Content-Length':String(bytes.length)}});
      return new Response('missing',{status:404});
    });
    try {
      const updater=createDesktopUpdater({source:SIDECAR_SOURCES.TOOLS_PACK,arch:'arm64',platform:'darwin',downloadRoot:dir,env:{OD_UPDATE_ENABLED:'1',OD_UPDATE_AUTO_DOWNLOAD:'1',OD_UPDATE_CURRENT_VERSION:'1.0.0',OD_UPDATE_METADATA_URL:'https://primary.example.test/metadata.json'}},{fetch:fetcher,logger:{info:()=>{},warn:()=>{},error:()=>{}}});
      const status=await updater.checkForUpdates();
      expect(status.state).toBe('downloaded');
      expect(status.checksum?.value).toBe(sha256);
      expect(await readFile(status.downloadPath!,'utf8')).toBe(bytes);
      expect(fetcher.mock.calls.some(([url])=>url===mirror)).toBe(true);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
});
