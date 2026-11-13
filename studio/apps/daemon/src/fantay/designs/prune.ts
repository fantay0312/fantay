// SPDX-License-Identifier: Apache-2.0
import { lstat, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { isSafeId } from '../../projects.js';

/** Bounded startup cleanup of daemon-owned caches, never imported project directories. */
export async function pruneOrphanDesignCaches(runtimeDataDir: string, hasProject: (id: string) => boolean): Promise<number> {
  let removed = 0;
  for (const name of ['design-history', 'design-covers']) {
    const root = path.join(runtimeDataDir, name);
    const info = await lstat(root).catch(error => {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    });
    if (!info?.isDirectory() || info.isSymbolicLink()) continue;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !isSafeId(entry.name) || hasProject(entry.name)) continue;
      await rm(path.join(root, entry.name), { recursive:true, force:true });
      removed++;
    }
  }
  return removed;
}
