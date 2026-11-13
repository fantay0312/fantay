// SPDX-License-Identifier: AGPL-3.0-only
// Lookups over the workspace file list shared by the board faces: one index per `files` array (the host passes a
// new array whenever a file changes), so a hundred faces do not rebuild a map on every render.
import type { ProjectFile } from '@open-design/contracts';

const INDEX = new WeakMap<readonly ProjectFile[], ReadonlyMap<string, ProjectFile>>();
const PATHS = new WeakMap<readonly ProjectFile[], ReadonlySet<string>>();

/** name → file (directories excluded). */
export function projectFileIndex(files: readonly ProjectFile[]): ReadonlyMap<string, ProjectFile> {
  let index = INDEX.get(files);
  if (!index) {
    const map = new Map<string, ProjectFile>();
    for (const file of files) if (file.type !== 'dir') map.set(file.name, file);
    index = map;
    INDEX.set(files, index);
  }
  return index;
}

/** Project file paths for root-relative asset detection (null while the list is empty). */
export function projectFilePathSet(files: readonly ProjectFile[]): ReadonlySet<string> | null {
  if (files.length === 0) return null;
  let paths = PATHS.get(files);
  if (!paths) {
    paths = new Set(projectFileIndex(files).keys());
    PATHS.set(files, paths);
  }
  return paths;
}

export function projectFileFor(files: readonly ProjectFile[], path: string | null | undefined): ProjectFile | undefined {
  if (!path) return undefined;
  return projectFileIndex(files).get(path);
}

export function basenameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const slash = trimmed.lastIndexOf('/');
  return slash >= 0 ? trimmed.slice(slash + 1) : trimmed;
}

export function dirnameOf(path: string): string | undefined {
  const slash = path.lastIndexOf('/');
  return slash > 0 ? path.slice(0, slash) : undefined;
}
