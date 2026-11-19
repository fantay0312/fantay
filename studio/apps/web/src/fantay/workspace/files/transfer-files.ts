// SPDX-License-Identifier: AGPL-3.0-only
// Files arriving from outside the app: dropped from the desktop (folders included, read through
// the entry API) or pasted from the clipboard. Ported from the inherited files panel
// (components/DesignFilesPanel.tsx) with the same behaviour, so a drop reads the same in both.
import { createFileSystemReadError } from '../../../utils/fileSystemErrors';

type EntryWithReader = FileSystemEntry & { createReader?: () => FileSystemDirectoryReader };
type FileEntry = FileSystemFileEntry & {
  file: (success: (file: File) => void, failure?: (error: DOMException) => void) => void;
};
type ItemWithEntry = DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null };

function fileFromEntry(entry: FileEntry): Promise<File> {
  return new Promise((resolve, reject) => {
    entry.file(resolve, (error) => reject(createFileSystemReadError('Could not read dropped file', error)));
  });
}

function readEntryBatch(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  return new Promise((resolve, reject) => {
    reader.readEntries(resolve, (error) => reject(createFileSystemReadError('Could not read dropped folder', error)));
  });
}

async function filesFromEntry(entry: FileSystemEntry): Promise<File[]> {
  if (entry.isFile) return [await fileFromEntry(entry as FileEntry)];
  if (!entry.isDirectory) return [];
  const reader = (entry as EntryWithReader).createReader?.();
  if (!reader) return [];
  const files: File[] = [];
  // A directory reader hands out its entries in batches; an empty batch is the end.
  for (;;) {
    const entries = await readEntryBatch(reader);
    if (entries.length === 0) break;
    files.push(...(await Promise.all(entries.map(filesFromEntry))).flat());
  }
  return files;
}

async function filesFromItem(item: DataTransferItem): Promise<File[]> {
  const entry = (item as ItemWithEntry).webkitGetAsEntry?.();
  if (!entry) {
    const file = item.kind === 'file' ? item.getAsFile() : null;
    return file ? [file] : [];
  }
  return filesFromEntry(entry);
}

/** Every file in a drop, walking dropped folders. Falls back to the flat list when a folder cannot be read. */
export async function filesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
  const items = Array.from(dataTransfer.items ?? []);
  const fallback = Array.from(dataTransfer.files ?? []);
  if (items.length === 0) return fallback;
  const results = await Promise.allSettled(items.map(filesFromItem));
  const rejected = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (rejected) {
    if (fallback.length > 0) return fallback;
    throw rejected.reason;
  }
  const files = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  return files.length > 0 ? files : fallback;
}

/** True when a drag carries files (and not text or a link dragged inside the page). */
export function dragHasFiles(dataTransfer: DataTransfer | null): boolean {
  return Array.from(dataTransfer?.types ?? []).includes('Files');
}

const MIME_EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'text/html': '.html',
  'text/plain': '.txt',
};

/** A pasted screenshot has no name; it gets one from the time and its type. */
function namePastedFile(file: File): File {
  if (file.name.trim()) return file;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return new File([file], `pasted-${stamp}${MIME_EXTENSIONS[file.type] ?? ''}`, { type: file.type, lastModified: file.lastModified });
}

export function filesFromClipboard(clipboard: DataTransfer | null): File[] {
  const files = Array.from(clipboard?.files ?? []);
  if (files.length > 0) return files.map(namePastedFile);
  return Array.from(clipboard?.items ?? [])
    .filter((item) => item.kind === 'file')
    .flatMap((item) => {
      const file = item.getAsFile();
      return file ? [namePastedFile(file)] : [];
    });
}

/** True for a target where the keys and the clipboard belong to the text being edited. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('[contenteditable="true"]')) return true;
  const tag = target.tagName.toLowerCase();
  return tag === 'input' || tag === 'textarea' || tag === 'select';
}
