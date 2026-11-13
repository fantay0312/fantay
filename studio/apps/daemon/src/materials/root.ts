// Effective material library root.
//
// The library (素材库) is an external, read-only integration input — the same
// category as an external tool home — not daemon data, so it never derives
// from the daemon data root. It is resolved on every request (cheap realpath +
// stat) so a library that appears, moves or gets its index rebuilt is picked
// up without restarting the daemon, and so tests can point one server at
// different fixture libraries.
//
// Precedence:
//   1. `FANTASY_DESIGN_LIBRARY` (the variable the archive CLI already honors).
//      When set it is authoritative: a broken value disables the feature with
//      a reason instead of silently falling back to another folder.
//   2. The fork default: a `素材库/` folder next to the repository root. Skipped
//      in packaged builds, where there is no repository checkout.

import fs from 'node:fs';
import path from 'node:path';

import type {
  MaterialLibraryRootSource,
  MaterialLibraryUnavailableReason,
} from '@open-design/contracts';

import { expandHomePrefix } from '../home-expansion.js';

export const MATERIAL_LIBRARY_ENV = 'FANTASY_DESIGN_LIBRARY';
export const MATERIAL_LIBRARY_FOLDER = '素材库';
export const MATERIAL_SUPPORT_DIR = '导览支持';
export const MATERIAL_INDEX_FILE = 'search-index.json';
export const MATERIAL_RECORDS_FILE = 'assets.jsonl';

export interface MaterialLibraryRootInput {
  env: NodeJS.ProcessEnv | Record<string, string | undefined>;
  /** Repository root used for the sibling default; null disables it. */
  projectRoot: string | null;
  /** Packaged builds have no repository checkout, so no sibling default. */
  packaged: boolean;
  /** Daemon data root(s), raw and canonical; the library must not overlap them. */
  dataRoots: readonly string[];
  /** Generated indexes live in daemon data while their source folder stays external. */
  indexDirectory?: string;
  requireIndex?: boolean;
}

export type MaterialLibraryRootResolution =
  | { ok: true; root: string; source: MaterialLibraryRootSource }
  | {
      ok: false;
      root: string | null;
      source: MaterialLibraryRootSource | null;
      reason: MaterialLibraryUnavailableReason;
      message: string;
    };

/** `child` is `parent` or lives below it (lexical; pass realpaths for symlink safety). */
export function isPathInsideOrSame(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

function realpathOrSelf(value: string): string {
  try {
    // native: same on-disk case as fs/promises realpath in paths.ts, so containment checks agree.
    return fs.realpathSync.native(value);
  } catch {
    return path.resolve(value);
  }
}

function overlapsDataRoot(root: string, dataRoots: readonly string[]): boolean {
  return dataRoots
    .filter((entry) => typeof entry === 'string' && entry.length > 0)
    .map(realpathOrSelf)
    .some((dataRoot) => isPathInsideOrSame(root, dataRoot) || isPathInsideOrSame(dataRoot, root));
}

function unavailable(
  root: string | null,
  source: MaterialLibraryRootSource | null,
  reason: MaterialLibraryUnavailableReason,
  message: string,
): MaterialLibraryRootResolution {
  return { ok: false, root, source, reason, message };
}

function checkCandidate(
  candidate: string,
  source: MaterialLibraryRootSource,
  dataRoots: readonly string[],
  input: Pick<MaterialLibraryRootInput, 'indexDirectory' | 'requireIndex'> = {},
): MaterialLibraryRootResolution {
  let root: string;
  try {
    root = fs.realpathSync.native(candidate);
  } catch {
    return unavailable(candidate, source, 'missing-root', `Material library folder not found: ${candidate}`);
  }
  let isDirectory = false;
  try {
    isDirectory = fs.statSync(root).isDirectory();
  } catch {
    isDirectory = false;
  }
  if (!isDirectory) {
    return unavailable(root, source, 'missing-root', `Material library path is not a directory: ${root}`);
  }
  if (overlapsDataRoot(root, dataRoots)) {
    return unavailable(
      root,
      source,
      'not-configured',
      'The material library must not overlap the daemon data directory.',
    );
  }
  if (input.requireIndex === false) return { ok: true, root, source };
  const indexPath = path.join(input.indexDirectory ?? path.join(root, MATERIAL_SUPPORT_DIR), MATERIAL_INDEX_FILE);
  let hasIndex = false;
  try {
    hasIndex = fs.statSync(indexPath).isFile();
  } catch {
    hasIndex = false;
  }
  if (!hasIndex) {
    return unavailable(
      root,
      source,
      'missing-index',
      `Missing ${MATERIAL_SUPPORT_DIR}/${MATERIAL_INDEX_FILE}; rebuild it with \`mise run catalog\` in ${path.join(root, MATERIAL_SUPPORT_DIR)}.`,
    );
  }
  return { ok: true, root, source };
}

export function resolveMaterialLibraryRoot(input: MaterialLibraryRootInput): MaterialLibraryRootResolution {
  const configured = input.env[MATERIAL_LIBRARY_ENV]?.trim();
  if (configured) {
    const expanded = expandHomePrefix(configured);
    if (!path.isAbsolute(expanded)) {
      return unavailable(null, 'env', 'not-configured', `${MATERIAL_LIBRARY_ENV} must be an absolute path.`);
    }
    return checkCandidate(expanded, 'env', input.dataRoots, input);
  }
  if (!input.packaged && input.projectRoot) {
    const sibling = path.join(path.dirname(path.resolve(input.projectRoot)), MATERIAL_LIBRARY_FOLDER);
    if (fs.existsSync(sibling)) return checkCandidate(sibling, 'sibling', input.dataRoots, input);
  }
  return unavailable(
    null,
    null,
    'not-configured',
    `No material library configured. Set ${MATERIAL_LIBRARY_ENV} to the absolute path of a ${MATERIAL_LIBRARY_FOLDER} folder.`,
  );
}
