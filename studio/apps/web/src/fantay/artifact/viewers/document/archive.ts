// SPDX-License-Identifier: AGPL-3.0-only
// A ZIP container read with limits, for the formats that are one (Word, OpenDocument, EPUB). The
// file is untrusted: the directory is listed without inflating anything, the number of entries and
// their declared total size are capped, and an entry is only inflated when it is asked for by name
// and fits the caller's limit. fflate allocates exactly the declared size, so an entry that lies
// about its size fails instead of growing. No DOM: this runs in workers and in tests.
import { unzipSync } from 'fflate';

import { ReadError } from './xml';

export interface ArchiveEntry {
  name: string;
  /** Declared size after inflating. */
  size: number;
  compressedSize: number;
}

export interface ArchiveLimits {
  maxEntries: number;
  /** Sum of the declared inflated sizes. */
  maxTotalBytes: number;
}

export interface BoundedArchive {
  readonly entries: ReadonlyMap<string, ArchiveEntry>;
  /** The entry's exact name for a path, forgiving a difference in letter case. Null when absent. */
  resolve(path: string): string | null;
  /** The inflated bytes, or null when the entry is absent, too large, encrypted or damaged. */
  read(path: string, maxBytes: number): Uint8Array | null;
  /** The entry as text (UTF-8, or UTF-16 when it starts with that byte-order mark). */
  readText(path: string, maxBytes: number): string | null;
}

/** True when the bytes start like a ZIP file. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length > 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && (bytes[2] === 0x03 || bytes[2] === 0x05);
}

export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Lists the archive. Throws `ReadError('invalid')` for a damaged file and `'too-large'` over the limits. */
export function openArchive(bytes: Uint8Array, limits: ArchiveLimits): BoundedArchive {
  if (!looksLikeZip(bytes)) throw new ReadError('invalid');
  const entries = new Map<string, ArchiveEntry>();
  let total = 0;
  let overLimit = false;
  try {
    unzipSync(bytes, {
      filter: (file) => {
        if (file.name.endsWith('/')) return false;
        if (entries.size >= limits.maxEntries) {
          overLimit = true;
          return false;
        }
        total += file.originalSize;
        entries.set(file.name, { name: file.name, size: file.originalSize, compressedSize: file.size });
        return false;
      },
    });
  } catch {
    throw new ReadError('invalid');
  }
  if (overLimit || total > limits.maxTotalBytes) throw new ReadError('too-large');

  const byLowerCase = new Map<string, string>();
  for (const name of entries.keys()) byLowerCase.set(name.toLowerCase(), name);

  const resolve = (path: string): string | null => {
    if (entries.has(path)) return path;
    return byLowerCase.get(path.toLowerCase()) ?? null;
  };

  const read = (path: string, maxBytes: number): Uint8Array | null => {
    const name = resolve(path);
    const entry = name ? entries.get(name) : undefined;
    if (!name || !entry || entry.size > maxBytes) return null;
    try {
      return unzipSync(bytes, { filter: (file) => file.name === name })[name] ?? null;
    } catch {
      return null;
    }
  };

  return {
    entries,
    resolve,
    read,
    readText: (path, maxBytes) => {
      const data = read(path, maxBytes);
      return data ? decodeText(data) : null;
    },
  };
}
