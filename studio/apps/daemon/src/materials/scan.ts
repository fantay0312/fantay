// Index ordinary folders without writing into them or executing their contents.
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MATERIAL_INDEX_FILE, MATERIAL_RECORDS_FILE } from './root.js';
import type { MaterialRecord } from './catalog.js';
import { invalidRequest } from './errors.js';

const EXCLUDED_DIRS = new Set(['node_modules', '__pycache__', 'venv', 'target', 'dist', 'build']);
const EXCLUDED_FILES = new Set(['Thumbs.db', 'desktop.ini']);
const MAX_FILES = 50_000;
const IMAGE_TYPES = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.avif']);
const VIDEO_TYPES = new Set(['.mp4', '.mov', '.webm', '.m4v', '.mkv', '.avi']);
const AUDIO_TYPES = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg']);
const FONT_TYPES = new Set(['.otf', '.ttf', '.woff', '.woff2']);

function kindFor(extension: string): string {
  if (IMAGE_TYPES.has(extension)) return 'image';
  if (VIDEO_TYPES.has(extension)) return 'video';
  if (AUDIO_TYPES.has(extension)) return 'audio';
  if (FONT_TYPES.has(extension)) return 'font';
  if (extension === '.svg') return 'svg';
  if (extension === '.html' || extension === '.htm') return 'html';
  if (extension === '.md' || extension === '.mdx') return 'markdown';
  return 'file';
}

export interface FolderScanResult { generation: string; directory: string; count: number; scannedAt: string }

export async function scanMaterialFolder(root: string, indexRoot: string): Promise<FolderScanResult> {
  const generation = randomUUID();
  const directory = path.join(indexRoot, generation);
  const scannedAt = new Date().toISOString();
  const assets: MaterialRecord[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const handle = await opendir(current);
    for await (const entry of handle) {
      if (entry.name.startsWith('.') || EXCLUDED_FILES.has(entry.name) || entry.isSymbolicLink()) continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) pending.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (assets.length >= MAX_FILES) throw invalidRequest('This folder has more than 50,000 files. Choose a smaller subfolder.');
      let info;
      try { info = await lstat(absolutePath); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (!info.isFile() || info.isSymbolicLink()) continue;
      const relative = path.relative(root, absolutePath).split(path.sep).join('/');
      const indexedPath = relative;
      const extension = path.extname(entry.name).toLowerCase();
      const kind = kindFor(extension);
      const directoryName = path.posix.dirname(relative);
      const record: MaterialRecord = {
        id: `file-${createHash('sha256').update(relative).digest('hex').slice(0, 24)}`,
        title: entry.name, kind,
        category: directoryName === '.' ? path.basename(root) : relative.split('/')[0]!,
        collection: directoryName === '.' ? path.basename(root) : directoryName,
        path: indexedPath, license: '',
        description: relative,
        tags: [extension.slice(1), directoryName === '.' ? '' : directoryName].filter(Boolean),
        collection_path: directoryName,
        file_size: info.size, file_modified_at: info.mtime.toISOString(),
        capabilities: { material: 'source_file', preview_entry: kind === 'html', design_tokens: false,
          source_manifest: false, license_document: false },
      };
      if ((kind === 'image' || kind === 'svg') && info.size <= 8 * 1024 * 1024) record.thumbnail = indexedPath;
      assets.push(record);
    }
  }
  assets.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  await mkdir(directory, { recursive: true });
  try {
    await writeFile(path.join(directory, MATERIAL_INDEX_FILE), JSON.stringify({ schema_version: 1, scanned_at: scannedAt, assets }));
    await writeFile(path.join(directory, MATERIAL_RECORDS_FILE), assets.map((record) => JSON.stringify(record)).join('\n') + '\n');
  } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  return { generation, directory, count: assets.length, scannedAt };
}
