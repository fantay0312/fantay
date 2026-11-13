// SPDX-License-Identifier: Apache-2.0
// Content-addressed board cover blobs (spec 04 §4.6): magic-byte sniffing, write-once storage under
// `<RUNTIME_DATA_DIR>/fantay/board-covers/<projectId>/<sha256>.<ext>`, reads and garbage collection.
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isSafeId } from '../../projects.js';
import {
  boardCoverDir,
  boardCoverFile,
  boardCoversRoot,
  isBoardCoverDigest,
  type BoardCoverFileExtension,
} from './paths.js';

export type BoardCoverMime = 'image/webp' | 'image/png' | 'image/jpeg';
export const BOARD_COVER_MIMES: readonly BoardCoverMime[] = ['image/webp', 'image/png', 'image/jpeg'];
export const BOARD_COVER_EXTENSION_BY_MIME: Readonly<Record<BoardCoverMime, BoardCoverFileExtension>> = {
  'image/webp': 'webp',
  'image/png': 'png',
  'image/jpeg': 'jpg',
};
const MIME_BY_EXTENSION: Readonly<Record<BoardCoverFileExtension, BoardCoverMime>> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
};

/** A project's cover dir is collected once it holds more than this many files. */
export const BOARD_COVER_GC_MAX_FILES = 300;
/** Unreferenced covers younger than this survive a collection (an upload may not be patched onto its node yet). */
export const BOARD_COVER_GC_MIN_AGE_MS = 10 * 60 * 1000;
/** Delay of the one-shot sweep of cover dirs whose project row is gone. */
export const BOARD_COVER_ORPHAN_SWEEP_DELAY_MS = 30 * 1000;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_MAGIC = [0xff, 0xd8, 0xff];
const RIFF_MAGIC = [0x52, 0x49, 0x46, 0x46];
const WEBP_MAGIC = [0x57, 0x45, 0x42, 0x50];

function startsWith(bytes: Uint8Array, magic: readonly number[], offset = 0): boolean {
  if (bytes.length < offset + magic.length) return false;
  return magic.every((value, index) => bytes[offset + index] === value);
}

/** PNG `89 50 4E 47 0D 0A 1A 0A`, JPEG `FF D8 FF`, WebP `RIFF ???? WEBP`; anything else is null. */
export function sniffBoardCoverMime(bytes: Uint8Array): BoardCoverMime | null {
  if (startsWith(bytes, PNG_MAGIC)) return 'image/png';
  if (startsWith(bytes, JPEG_MAGIC)) return 'image/jpeg';
  if (startsWith(bytes, RIFF_MAGIC) && startsWith(bytes, WEBP_MAGIC, 8)) return 'image/webp';
  return null;
}

/** `Content-Type` → cover mime (parameters and case ignored), or null for anything that is not a cover type. */
export function normalizeBoardCoverContentType(value: unknown): BoardCoverMime | null {
  if (typeof value !== 'string') return null;
  const mime = value.split(';')[0]!.trim().toLowerCase();
  return (BOARD_COVER_MIMES as readonly string[]).includes(mime) ? (mime as BoardCoverMime) : null;
}

export function boardCoverDigest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Writes the bytes once (`wx`; an existing identical blob is fine) and returns their digest. */
export async function writeBoardCover(
  runtimeDataDir: string,
  projectId: string,
  bytes: Uint8Array,
  mime: BoardCoverMime,
): Promise<{ digest: string; file: string; created: boolean }> {
  const digest = boardCoverDigest(bytes);
  const file = boardCoverFile(runtimeDataDir, projectId, digest, BOARD_COVER_EXTENSION_BY_MIME[mime]);
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await writeFile(file, bytes, { flag: 'wx' });
    return { digest, file, created: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return { digest, file, created: false };
    throw error;
  }
}

/** Reads a stored cover by digest (any of the three extensions), or null when it is absent or the input is invalid. */
export async function readBoardCover(
  runtimeDataDir: string,
  projectId: string,
  digest: string,
): Promise<{ bytes: Buffer; mime: BoardCoverMime } | null> {
  if (!isSafeId(projectId) || !isBoardCoverDigest(digest)) return null;
  for (const ext of Object.keys(MIME_BY_EXTENSION) as BoardCoverFileExtension[]) {
    try {
      const bytes = await readFile(boardCoverFile(runtimeDataDir, projectId, digest, ext));
      return { bytes, mime: MIME_BY_EXTENSION[ext] };
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') continue;
      throw error;
    }
  }
  return null;
}

/** `<digest>.<ext>` → digest, or null for a foreign file name. */
function coverDigestOfFileName(name: string): string | null {
  const match = /^([a-f0-9]{64})\.(webp|png|jpg)$/.exec(name);
  return match ? match[1]! : null;
}

export interface BoardCoverGcOptions {
  now: number;
  maxFiles?: number;
  minAgeMs?: number;
}

/**
 * Collects one project's cover dir when it holds more than `maxFiles` files: deletes covers older than `minAgeMs`
 * (by file mtime) that no node of the board references. Returns the deleted file names.
 */
export async function gcBoardCovers(
  runtimeDataDir: string,
  projectId: string,
  referencedDigests: ReadonlySet<string>,
  opts: BoardCoverGcOptions,
): Promise<string[]> {
  const maxFiles = opts.maxFiles ?? BOARD_COVER_GC_MAX_FILES;
  const minAgeMs = opts.minAgeMs ?? BOARD_COVER_GC_MIN_AGE_MS;
  const dir = boardCoverDir(runtimeDataDir, projectId);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  if (names.length <= maxFiles) return [];
  const deleted: string[] = [];
  for (const name of names.sort()) {
    const digest = coverDigestOfFileName(name);
    if (!digest || referencedDigests.has(digest)) continue;
    const file = path.join(dir, name);
    try {
      const info = await stat(file);
      if (!info.isFile() || opts.now - info.mtimeMs <= minAgeMs) continue;
      await unlink(file);
      deleted.push(name);
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error;
    }
  }
  return deleted;
}

/** Deletes `<root>/<projectId>` dirs whose project no longer exists. Returns the removed project ids. */
export async function gcOrphanBoardCoverDirs(
  runtimeDataDir: string,
  projectExists: (projectId: string) => boolean,
): Promise<string[]> {
  const root = boardCoversRoot(runtimeDataDir);
  let entries: Array<{ name: string; isDirectory(): boolean }>;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
    throw error;
  }
  const removed: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeId(entry.name) || projectExists(entry.name)) continue;
    await rm(path.join(root, entry.name), { recursive: true, force: true });
    removed.push(entry.name);
  }
  return removed;
}
