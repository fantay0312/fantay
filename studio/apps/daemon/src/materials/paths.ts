// Path rules for indexed material files.
//
// Indexed paths are relative to the library's PARENT and start with the
// library folder name (`素材库/交互组件/…`), which is how the archive CLI keeps
// working after the whole archive moves. Resolution mirrors `Library.resolve`
// in `素材库/导览支持/scripts/fantasy_design.py`: reject absolute paths and any
// `..` part, resolve against `dirname(root)`, require containment in the root.
// Serving and copying add the stronger guard used by the plugin asset route
// (`routes/plugins/assets.ts`): no symlink in any segment below the root, and
// a realpath re-check.

import { lstat, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import type { MaterialCatalog, MaterialRecord } from './catalog.js';
import { missingFile, unsafePath } from './errors.js';
import { isPathInsideOrSame } from './root.js';

export { isPathInsideOrSame };

/** Python `Path(value).parts` on POSIX: split on `/`, drop empty and `.` parts. */
export function posixParts(value: string): string[] {
  return value.split('/').filter((part) => part !== '' && part !== '.');
}

export function toPosixRelative(from: string, to: string): string {
  return path.relative(from, to).split(path.sep).join('/');
}

/** Lexical resolution of an indexed (`素材库/…`) path; throws `unsafe-path`. */
export function resolveIndexedPath(catalog: Pick<MaterialCatalog, 'root' | 'base'>, relative: unknown): string {
  if (typeof relative !== 'string' || relative.length === 0) {
    throw unsafePath(`Unsafe indexed path: ${String(relative)}`);
  }
  if (relative.includes('\0') || path.isAbsolute(relative) || posixParts(relative).includes('..')) {
    throw unsafePath(`Unsafe indexed path: ${relative}`);
  }
  const resolved = path.resolve(catalog.base, relative);
  if (!isPathInsideOrSame(resolved, catalog.root)) {
    throw unsafePath(`Path leaves library: ${relative}`);
  }
  return resolved;
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Realpath of `target`, or of its longest existing prefix plus the missing tail. */
export async function realpathOrExistingPrefix(target: string): Promise<string> {
  try {
    return await realpath(target);
  } catch (error) {
    if (!isMissingError(error)) throw error;
  }
  let current = target;
  const tail: string[] = [];
  while (true) {
    const parent = path.dirname(current);
    tail.unshift(path.basename(current));
    if (parent === current) return target;
    current = parent;
    try {
      const real = await realpath(current);
      return path.join(real, ...tail);
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
  }
}

/**
 * Like Python `Path.resolve()` + `within(...)`: follow symlinks and require
 * the real location to stay inside `container`. Missing paths are checked
 * through their longest existing prefix.
 */
export async function assertRealInside(target: string, container: string, label: string): Promise<string> {
  const real = await realpathOrExistingPrefix(target);
  if (!isPathInsideOrSame(real, container)) throw unsafePath(`Path leaves library: ${label}`);
  return real;
}

/**
 * True when `root` is `target` or one of its existing ancestors, compared by
 * device + inode. Path containment cannot see aliases that realpath keeps,
 * such as the macOS firmlink `/System/Volumes/Data/Users/…` for `/Users/…`.
 */
export async function isInsideByIdentity(target: string, root: string): Promise<boolean> {
  const rootInfo = await stat(root, { bigint: true });
  let current = path.resolve(target);
  while (true) {
    try {
      const info = await stat(current, { bigint: true });
      if (info.dev === rootInfo.dev && info.ino === rootInfo.ino) return true;
    } catch (error) {
      if (!isMissingError(error)) throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/**
 * Reject a symlink in any segment from `root` down to `target` (the plugin
 * asset guard). A missing segment raises `missing-file`.
 */
export async function assertNoSymlinkSegments(target: string, root: string, label: string): Promise<void> {
  if (!isPathInsideOrSame(target, root)) throw unsafePath(`Path leaves library: ${label}`);
  let current = root;
  const segments = path.relative(root, target).split(path.sep).filter(Boolean);
  try {
    const rootInfo = await lstat(current);
    if (rootInfo.isSymbolicLink()) throw unsafePath(`Symlinked library root is not served: ${label}`);
    for (const segment of segments) {
      current = path.join(current, segment);
      const info = await lstat(current);
      if (info.isSymbolicLink()) throw unsafePath(`Material files are not served through symlinks: ${label}`);
    }
  } catch (error) {
    if (isMissingError(error)) throw missingFile(`Missing local file: ${label}`);
    throw error;
  }
}

export async function isRegularFile(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function isDirectory(target: string): Promise<boolean> {
  try {
    return (await stat(target)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * `Library.collection_root`: the record's `collection_path`, else the
 * `素材库/<category>/<entry>/` folder of a nested entry. Null when the record
 * has no collection directory (single files) or it is missing.
 */
export async function materialCollectionRoot(
  catalog: Pick<MaterialCatalog, 'root' | 'base'>,
  record: MaterialRecord,
): Promise<string | null> {
  let candidate: string | null = null;
  const collectionPath = record.collection_path;
  if (typeof collectionPath === 'string' && collectionPath) {
    candidate = resolveIndexedPath(catalog, collectionPath);
  } else {
    const parts = posixParts(record.path);
    if (parts.length > 3) candidate = resolveIndexedPath(catalog, parts.slice(0, 3).join('/'));
  }
  if (!candidate) return null;
  await assertRealInside(candidate, catalog.root, String(collectionPath || record.path));
  return (await isDirectory(candidate)) ? candidate : null;
}
