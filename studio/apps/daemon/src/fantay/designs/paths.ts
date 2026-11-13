// SPDX-License-Identifier: Apache-2.0
// Design document paths (spec 06 §7.3). Project paths go through the daemon's project-path rules
// (`validateProjectPath` / `sanitizePath`, apps/daemon/src/projects.ts). Daemon-owned data (history, covers, the
// legacy migration ledger) lives under the explicit runtime data root the caller passes (RUNTIME_DATA_DIR, see the
// root AGENTS.md "Daemon data directory contract"); nothing here falls back to env or cwd.
import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  designFileNameFromTitle,
  designFormatForPath,
  designNameFromPath,
  isDesignDocumentPath,
} from '@open-design/contracts';

import { isSafeId, sanitizePath, validateProjectPath } from '../../projects.js';
import { DesignInputError } from './errors.js';

/** File-name limit of APFS, ext4 and NTFS, in UTF-8 bytes (NTFS counts UTF-16 units; bytes are the stricter bound). */
export const FILE_NAME_MAX_BYTES = 255;
/** Bytes the atomic-write temp name adds around a basename: `.` + basename + `.fx-tmp-` + 36-char uuid (B14). */
export const DESIGN_TEMP_NAME_EXTRA_BYTES = 45;
/** Longest basename (with extension) a new design file may have, so its temp name still fits FILE_NAME_MAX_BYTES. */
export const DESIGN_FILE_NAME_MAX_BYTES = FILE_NAME_MAX_BYTES - DESIGN_TEMP_NAME_EXTRA_BYTES;

function invalidPath(message: string, suggestion?: string): DesignInputError {
  return new DesignInputError('INVALID_DESIGN_PATH', message, suggestion ? { suggestion } : {});
}

/** `validateProjectPath`, then the design-document rules shared by reads and writes. Returns the normalized path. */
function normalizeDesignPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.trim() === '') throw invalidPath('path is required');
  let normalized: string;
  try {
    normalized = validateProjectPath(raw);
  } catch (error) {
    throw invalidPath(`invalid design path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isDesignDocumentPath(normalized)) throw invalidPath('design documents are .fig or .op files');
  return normalized;
}

/**
 * Path of a design document the request may create: a project path whose segments are already canonical
 * (`sanitizePath(p) === p`), ending in `.fig`/`.op`, with a basename short enough for the atomic-write temp name.
 * Otherwise `DesignInputError('INVALID_DESIGN_PATH')` with `details.suggestion` = the canonical form when one exists.
 */
export function validateDesignPath(raw: unknown): string {
  const normalized = normalizeDesignPath(raw);
  let canonical: string;
  try {
    canonical = sanitizePath(normalized);
  } catch (error) {
    throw invalidPath(`invalid design path: ${error instanceof Error ? error.message : String(error)}`);
  }
  const basename = canonical.slice(canonical.lastIndexOf('/') + 1);
  if (Buffer.byteLength(basename, 'utf8') > DESIGN_FILE_NAME_MAX_BYTES) {
    const dir = canonical.includes('/') ? canonical.slice(0, canonical.lastIndexOf('/')) : '';
    const shortened = `${designFileNameFromTitle(designNameFromPath(canonical))}.${designFormatForPath(canonical) ?? 'fig'}`;
    throw invalidPath(
      `design file names are limited to ${DESIGN_FILE_NAME_MAX_BYTES} UTF-8 bytes`,
      dir ? `${dir}/${shortened}` : shortened,
    );
  }
  if (canonical !== raw) throw invalidPath(`design paths must be canonical; use ${canonical}`, canonical);
  return canonical;
}

/**
 * Path of a design document that may already exist (reads, covers, `If-Match` updates). Existing files keep the name
 * they have on disk (an imported folder or an agent may have written `designs/My Design.fig`), so only the
 * project-path rules apply, plus: no hidden segment (dot files never appear in the project file list, and the
 * atomic-write temp files are dot files) and a `.fig`/`.op` extension. Returns the normalized path.
 */
export function validateExistingDesignPath(raw: unknown): string {
  const normalized = normalizeDesignPath(raw);
  if (normalized.split('/').some((segment) => segment.startsWith('.'))) {
    throw invalidPath('hidden path segments are not design documents');
  }
  return normalized;
}

function requireDataRoot(runtimeDataDir: string): string {
  if (typeof runtimeDataDir !== 'string' || !path.isAbsolute(runtimeDataDir)) {
    throw new Error('design storage needs the absolute daemon data root (RUNTIME_DATA_DIR)');
  }
  return runtimeDataDir;
}

function requireProjectId(projectId: string): string {
  if (!isSafeId(projectId)) throw new Error('invalid project id');
  return projectId;
}

function sha1(value: string): string {
  return createHash('sha1').update(value, 'utf8').digest('hex');
}

/** `<RUNTIME_DATA_DIR>/design-history/<projectId>/<sha1(path).slice(0,16)>` */
export function designHistoryDir(runtimeDataDir: string, projectId: string, designPath: string): string {
  return path.join(requireDataRoot(runtimeDataDir), 'design-history', requireProjectId(projectId), sha1(designPath).slice(0, 16));
}

/** `<RUNTIME_DATA_DIR>/design-covers/<projectId>/<sha1(path)>.png|.json` */
export function designCoverPaths(runtimeDataDir: string, projectId: string, designPath: string): { png: string; meta: string } {
  const base = path.join(requireDataRoot(runtimeDataDir), 'design-covers', requireProjectId(projectId), sha1(designPath));
  return { png: `${base}.png`, meta: `${base}.json` };
}

/**
 * `<RUNTIME_DATA_DIR>/design-canvas/.migrations.json`. The dot name never matches `CanvasStore.list()`'s
 * `/^[\w-]+\.json$/` filter nor a legacy document id, so the legacy store does not see the ledger.
 */
export function designMigrationLedgerPath(runtimeDataDir: string): string {
  return path.join(requireDataRoot(runtimeDataDir), 'design-canvas', '.migrations.json');
}
