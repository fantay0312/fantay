import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { MovieError } from './store.js';
import { listNativeProjectRecords, nativeRuntimeDir, type NativeProjectRecord } from './native-editor.js';

export interface NativeLibraryProject {
  id: string; name: string; path: string; updatedAt: number; projectId?: string; thumbnailBase64?: string;
}

const cache = new Map<string, { at: number; records: Promise<NativeProjectRecord[]> }>();
export function refreshNativeLibrary(dataDir: string): void { cache.delete(dataDir); }
function records(dataDir: string): Promise<NativeProjectRecord[]> {
  const current = cache.get(dataDir);
  if (current && Date.now() - current.at < 3000) return current.records;
  const next = listNativeProjectRecords(dataDir).then(rows => {
    const entry = cache.get(dataDir); if (entry?.records === next) entry.at = Date.now();
    return rows;
  }).catch(error => { cache.delete(dataDir); throw error; });
  cache.set(dataDir, { at: Number.POSITIVE_INFINITY, records: next });
  return next;
}

/** The native document owner reads its registry; the daemon never opens protected document folders. */
export async function nativeLibrary(dataDir: string, load: () => Promise<NativeProjectRecord[]> = () => records(dataDir)): Promise<NativeLibraryProject[]> {
  const rows = await load();
  let bindings: Record<string, string> = {};
  try { bindings = JSON.parse(await readFile(path.join(nativeRuntimeDir(dataDir), 'projects.json'), 'utf8')); } catch {}
  const entries: NativeLibraryProject[] = [];
  const seen = new Set<string>();
  for (const row of rows.slice(0, 10000)) {
    if (typeof row.path !== 'string' || !path.isAbsolute(row.path) || path.extname(row.path).toLowerCase() !== '.palmier' || row.isAccessible === false) continue;
    const nativePath = path.normalize(row.path);
    if (seen.has(nativePath)) continue;
    seen.add(nativePath);
    const projectId = bindings[nativePath];
    entries.push({
      id: createHash('sha256').update(nativePath).digest('hex').slice(0, 32),
      name: typeof row.name === 'string' ? row.name : path.basename(nativePath, path.extname(nativePath)),
      path: nativePath, updatedAt: typeof row.lastOpenedAt === 'number' ? row.lastOpenedAt : 0,
      ...(typeof projectId === 'string' ? { projectId } : {}),
      ...(typeof row.thumbnailBase64 === 'string' && row.thumbnailBase64.length < 1_400_000 ? { thumbnailBase64: row.thumbnailBase64 } : {}),
    });
  }
  return entries.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function nativeProjectThumbnail(project: NativeLibraryProject): Promise<Buffer> {
  if (!project.thumbnailBase64) throw new MovieError('Video project thumbnail not found', 404);
  const bytes = Buffer.from(project.thumbnailBase64, 'base64');
  if (bytes.length > 1_000_000 || bytes[0] !== 0xff || bytes[1] !== 0xd8) throw new MovieError('Invalid video project thumbnail', 400);
  return bytes;
}
