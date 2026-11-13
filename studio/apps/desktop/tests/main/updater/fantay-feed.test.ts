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
  it.each([
    'https://releases.open-design.ai/stable/latest/metadata.json',
    'https://s3.nexu.space/releases/stable/latest/metadata.json',
    'https://github.com/nexu-io/open-design/releases/latest/download/metadata.json',
    'https://api.github.com/repos/nexu-io/open-design/releases/latest',
    'https://raw.githubusercontent.com/nexu-io/open-design/main/metadata.json',
  ])('rejects the inherited upstream feed %s', (url) => {
    const result = resolveDesktopUpdaterConfig({
      source: SIDECAR_SOURCES.PACKAGED,
      env: { OD_UPDATE_METADATA_URL: url, OD_UPDATE_ENABLED: '1' },
    });
    expect(result.enabled).toBe(false);
    expect(result.metadataUrl).toContain('https://static.tokentosea.com/fantay-design/releases/');
  });
  const config=()=>resolveDesktopUpdaterConfig({source:SIDECAR_SOURCES.PACKAGED,env:{OD_UPDATE_METADATA_URL:'https://static.tokentosea.com/fantay-design/releases/stable/latest/metadata.json'}});
  it('keeps private GitHub releases out of automatic metadata fallback', async () => {
    const fetcher = vi.fn().mockRejectedValue(new Error('network'));
    expect(config().metadataFallbackUrls).toEqual([]);
    await expect(fetchReleaseMetadata(fetcher, config())).rejects.toThrow('network');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('does not contact the mirror when the domestic feed works',async()=>{
    const fetcher=vi.fn().mockResolvedValue(new Response(JSON.stringify({channel:'stable'})));
    await fetchReleaseMetadata(fetcher,config()); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('downloads the same verified installer from an explicitly supplied public mirror',async()=>{
    const dir=await mkdtemp(join(tmpdir(),'fantay-mirror-'));
    const bytes='verified installer fixture';
    const sha256=createHash('sha256').update(bytes).digest('hex');
    const mirror='https://mirror.example.test/releases/v1.1.0/test.dmg';
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
