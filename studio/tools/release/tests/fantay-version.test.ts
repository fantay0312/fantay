import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { expect, it } from 'vitest';
import { FANTAY_RELEASES } from '@open-design/contracts';
import { FANTAY_VERSION_PACKAGES, syncFantayVersion, validateFantayReleases } from '../src/fantay-version.js';

it('synchronizes only version fields and creates matching detailed artifacts idempotently',async()=>{
  const root=await mkdtemp(join(tmpdir(),'fantay-version-'));
  const fixture=[FANTAY_RELEASES[0]!];
  try {
    for(const name of FANTAY_VERSION_PACKAGES){const file=join(root,name);await mkdir(dirname(file),{recursive:true});await writeFile(file,'{\n  "version": "0.25.1",\n  "unrelated": "keep"\n}\n');}
    await expect(syncFantayVersion(true,root,fixture)).rejects.toThrow('out of sync');
    const changes=await syncFantayVersion(false,root,fixture);
    expect(changes).toContain('docs/releases/26.1114.1.md');
    expect(JSON.parse(await readFile(join(root,'apps/packaged/package.json'),'utf8'))).toEqual({version:'26.1114.1',unrelated:'keep'});
    expect(await syncFantayVersion(false,root,fixture)).toEqual([]);
    expect(await syncFantayVersion(true,root,fixture)).toEqual([]);
    expect(await readFile(join(root,'docs/releases/index.html'),'utf8')).toContain('本地准备，尚未发布');
    const january={...structuredClone(FANTAY_RELEASES[0]!),version:'27.0101.1',date:'2027-01-01'};
    await syncFantayVersion(false,root,[january]);
    expect(JSON.parse(await readFile(join(root,'apps/packaged/package.json'),'utf8')).version).toBe('27.101.1');
    expect(await readFile(join(root,'docs/releases/27.0101.1.md'),'utf8')).toContain('27.0101.1');
  }finally{await rm(root,{recursive:true,force:true});}
});

it('rejects duplicate version records and missing manga before writes',()=>{
  expect(()=>validateFantayReleases([...FANTAY_RELEASES,...FANTAY_RELEASES])).toThrow('sequence');
  const release=structuredClone(FANTAY_RELEASES[0]!);release.manga.copy.en.chapters=[];
  expect(()=>validateFantayReleases([release])).toThrow('manga');
});
