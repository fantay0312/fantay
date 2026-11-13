import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { prepareFantayRelease } from '../src/fantay-prepare.ts';
import { putStorageObject } from '../src/storage/s3-upload.ts';
afterEach(()=>vi.unstubAllGlobals());
it('prepares matching checksums and independently downloadable GitHub metadata',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'fantay-distribution-'));
  try {
    const source=join(dir,'test.dmg');await writeFile(source,'fixture installer');
    const out=await prepareFantayRelease(['--version','1.2.3','--mac-arm64',source,'--out',join(dir,'out')]);
    const primary=JSON.parse(await readFile(join(out,'metadata.json'),'utf8'));
    const github=JSON.parse(await readFile(join(out,'github/metadata.json'),'utf8'));
    const a=primary.platforms.mac.artifacts.dmg,b=github.platforms.mac.artifacts.dmg;
    expect(a.sha256).toBe(createHash('sha256').update('fixture installer').digest('hex'));
    expect(b.sha256).toBe(a.sha256);
    expect(a.fallbackUrls).toEqual([b.url]);
    expect(b.url).toBe('https://github.com/fantay0312/fantay/releases/download/v1.2.3/Fantay-1.2.3-mac-arm64.dmg');
    expect(primary.platforms.win).toBeUndefined();
  } finally { await rm(dir,{recursive:true,force:true}); }
});
it('signs COS requests with the virtual host and without a repeated bucket path',async()=>{
  const fetcher=vi.fn().mockResolvedValue(new Response('',{status:200}));vi.stubGlobal('fetch',fetcher);
  await putStorageObject({addressingStyle:'virtual',accessKeyId:'test-id',secretAccessKey:'test-secret',bucket:'public-123',endpointUrl:'https://cos.ap-nanjing.myqcloud.com',region:'ap-nanjing',body:Buffer.from('asset'),objectKey:'fantay-design/releases/1.2.3/installer.dmg',contentType:'application/octet-stream',cacheControl:'public, max-age=31536000'});
  expect(fetcher.mock.calls[0]?.[0].toString()).toBe('https://public-123.cos.ap-nanjing.myqcloud.com/fantay-design/releases/1.2.3/installer.dmg');
  expect(fetcher.mock.calls[0]?.[1].headers.host).toBe('public-123.cos.ap-nanjing.myqcloud.com');
});
