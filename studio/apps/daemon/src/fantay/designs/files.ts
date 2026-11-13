// SPDX-License-Identifier: Apache-2.0
// File helpers of the design-document service: atomic replace (temp file beside the target, fsync, rename) and a
// keyed serial queue. Temp names are dot files (`.<basename>.fx-tmp-<uuid>`, amendment B14), which the project file
// list skips.
import { createHash, randomUUID } from 'node:crypto';
import { open, readFile, rename, rm, utimes } from 'node:fs/promises';
import path from 'node:path';

import { FILE_NAME_MAX_BYTES } from './paths.js';

export function sha256Hex(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
}

/** Temp path for an atomic write of `target`: `.<basename>.fx-tmp-<uuid>`, or `.fx-tmp-<uuid>` when that name would be too long. */
export function atomicTempPath(target: string): string {
  const dir = path.dirname(target);
  const id = randomUUID();
  const preferred = `.${path.basename(target)}.fx-tmp-${id}`;
  return path.join(dir, Buffer.byteLength(preferred, 'utf8') <= FILE_NAME_MAX_BYTES ? preferred : `.fx-tmp-${id}`);
}

/** Writes `bytes` to `target` atomically: create-only temp file in the same directory, fsync, rename over the target. */
export async function writeFileAtomic(target: string, bytes: Buffer | string): Promise<void> {
  const temp = atomicTempPath(target);
  const handle = await open(temp, 'wx');
  try {
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Content-addressed variant of `writeFileAtomic`: an existing `target` is kept (same name = same bytes). Either way the
 * file's mtime is set to `stamp`, so "newest by mtime" follows the order of the calls.
 */
export async function writeContentAddressedFile(target: string, bytes: Buffer, stamp: Date): Promise<void> {
  try {
    await utimes(target, stamp, stamp);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await writeFileAtomic(target, bytes);
  await utimes(target, stamp, stamp);
}

/** File bytes, or `null` when the file does not exist. */
export async function readFileIfExists(file: string): Promise<Buffer | null> {
  try {
    return await readFile(file);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export interface FileSnapshot {
  bytes: Buffer;
  size: number;
  mtimeMs: number;
  ino: number;
}

/**
 * Bytes and stat of one open file (same inode, so an atomic replace during the read cannot mix two versions).
 * `null` when the file does not exist or is not a regular file.
 */
export async function readFileSnapshot(file: string): Promise<FileSnapshot | null> {
  const handle = await open(file, 'r').catch((error: unknown) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') return null;
    throw error;
  });
  if (!handle) return null;
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) return null;
    const bytes = await handle.readFile();
    return { bytes, size: bytes.length, mtimeMs: stats.mtimeMs, ino: stats.ino };
  } finally {
    await handle.close();
  }
}

/** Runs tasks one at a time per key; tasks with different keys run concurrently. A failed task does not block the next. */
export class KeyedSerialQueue {
  private readonly tails = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    const result = previous.then(task);
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return result;
  }
}
