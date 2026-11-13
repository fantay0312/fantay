import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { pruneOrphanDesignCaches } from '../../../src/fantay/designs/prune.js';

it('removes only deleted-project cache directories and never follows links', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'design-cache-prune-'));
  try {
    for(const id of ['live','deleted']) {
      await mkdir(path.join(root,'design-history',id),{recursive:true});
      await writeFile(path.join(root,'design-history',id,'revision'),'data');
    }
    await mkdir(path.join(root,'outside'));
    await writeFile(path.join(root,'outside','keep'),'keep');
    await symlink(path.join(root,'outside'),path.join(root,'design-history','linked'));
    expect(await pruneOrphanDesignCaches(root,id=>id==='live')).toBe(1);
    expect(await readFile(path.join(root,'design-history','live','revision'),'utf8')).toBe('data');
    expect(await readFile(path.join(root,'outside','keep'),'utf8')).toBe('keep');
    await expect(readFile(path.join(root,'design-history','deleted','revision'))).rejects.toMatchObject({code:'ENOENT'});
  } finally { await rm(root,{recursive:true,force:true}); }
});
