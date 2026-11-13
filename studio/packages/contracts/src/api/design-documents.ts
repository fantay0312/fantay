// SPDX-License-Identifier: Apache-2.0
/**
 * Project-scoped design documents: `.fig` (editable) and `.op` (read-only)
 * project files, by default under `designs/`, served by
 * `/api/projects/:id/designs*` with sha256 compare-and-swap writes, covers and
 * a ledger of documents imported from the legacy global design-canvas store.
 *
 * Errors use the existing ApiErrorCodes: `CONFLICT` with DesignConflictDetails,
 * `PAYLOAD_TOO_LARGE`, `UNSUPPORTED_MEDIA_TYPE`, `BAD_REQUEST` with
 * `details.reason` in INVALID_DESIGN_PATH | INVALID_DESIGN_DATA |
 * PRECONDITION_REQUIRED (sent with HTTP 428) | INVALID_COVER,
 * `PROJECT_NOT_FOUND`, `FILE_NOT_FOUND`, `NOT_FOUND`.
 */
import type { DesignDocumentFormat } from '../runtime/design-editor-bridge.js';

export type { DesignDocumentFormat };

export const DESIGN_DOCUMENTS_DIR = 'designs';
export const DESIGN_DOCUMENT_MAX_BYTES = 64 * 1024 * 1024;
export const DESIGN_COVER_MAX_BYTES = 8 * 1024 * 1024;
export const DESIGN_COVER_MAX_EDGE = 4096;
export const DESIGN_HISTORY_LIMIT = 20;
/** Request header of `PUT …/designs/cover`, also a response header of `GET …/designs/content`. */
export const DESIGN_SHA256_HEADER = 'x-design-sha256';

export interface DesignDocumentSummary {
  projectId: string;
  path: string;
  name: string;
  format: DesignDocumentFormat;
  size: number;
  mtime: number;
  /** designRevision(size, mtime): changes whenever the file changes; cache key for covers. */
  revision: string;
  coverUrl: string;
  sha256?: string;
}
export interface DesignDocumentListResponse {
  designs: DesignDocumentSummary[];
}
export interface DesignDocumentSaveResponse {
  design: DesignDocumentSummary & { sha256: string };
  created: boolean;
  previousSha256: string | null;
}
export interface DesignConflictDetails {
  reason: 'DESIGN_REVISION_MISMATCH';
  /** sha256 of the bytes now on disk; `null` when the file no longer exists. */
  currentSha256: string | null;
  path: string;
}
export interface DesignMigrationRecord {
  legacyId: string;
  legacySha256: string;
  projectId: string;
  path: string;
  sha256: string;
  migratedAt: string;
}
export interface DesignMigrationListResponse {
  migrations: DesignMigrationRecord[];
}
export interface ImportLegacyDesignRequest {
  legacyId: string;
  path?: string;
}
export interface ImportLegacyDesignResponse {
  design: DesignDocumentSummary & { sha256: string };
  migration: DesignMigrationRecord;
  alreadyImported: boolean;
}

const DESIGN_EXTENSION = /\.(fig|op)$/i;
/** Length cap of designFileNameFromTitle (UTF-16 code units; a surrogate pair is never split). */
const DESIGN_FILE_NAME_MAX_LENGTH = 120;
/**
 * UTF-8 byte cap of designFileNameFromTitle. APFS and ext4 limit a file name to
 * 255 bytes; 150 leaves room for `.fig`, a `-N` suffix and the daemon's
 * temporary write name (`.<name>.fx-tmp-<uuid>`), so 50 CJK characters fit.
 */
const DESIGN_FILE_NAME_MAX_BYTES = 150;
const DEFAULT_DESIGN_FILE_NAME = 'design';

function lastPathSegment(path: string): string {
  const segments = String(path ?? '').split(/[\\/]/);
  return segments[segments.length - 1] ?? '';
}

/** True when the last path segment ends in `.fig` or `.op` (any case). */
export function isDesignDocumentPath(path: string): boolean {
  return DESIGN_EXTENSION.test(lastPathSegment(path));
}

export function designFormatForPath(path: string): DesignDocumentFormat | null {
  const match = DESIGN_EXTENSION.exec(lastPathSegment(path));
  if (!match) return null;
  return match[1]!.toLowerCase() === 'op' ? 'op' : 'fig';
}

/** Basename without its extension: `designs/首页.fig` -> `首页`. */
export function designNameFromPath(path: string): string {
  const base = lastPathSegment(path);
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

/**
 * File base name for a design title. Same rules as the daemon's project file
 * `sanitizeName` (apps/daemon/src/projects.ts), so `designs/<name>.fig` is a
 * canonical project path: Unicode letters and digits, `.`, `_` and `-` stay;
 * whitespace runs become `-`; path separators and every other character become
 * `_`; a leading dot run becomes `_`. The result is capped at 120 characters
 * (UTF-16 code units) and 150 UTF-8 bytes, never splitting a code point, so
 * the cut stays canonical; an empty title gives `design` (the daemon would
 * invent `file-<time>`). Pass the title without an extension.
 */
export function designFileNameFromTitle(title: string): string {
  const cleaned = String(title ?? '')
    .replace(/[\\/]/g, '_')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}._-]/gu, '_')
    .replace(/^\.+/, '_')
    .trim();
  return capLength(cleaned, DESIGN_FILE_NAME_MAX_LENGTH, DESIGN_FILE_NAME_MAX_BYTES) || DEFAULT_DESIGN_FILE_NAME;
}

/**
 * Longest prefix of at most `maxLength` UTF-16 code units and `maxBytes` UTF-8
 * bytes that ends on a code point boundary.
 */
function capLength(value: string, maxLength: number, maxBytes: number): string {
  let out = '';
  let bytes = 0;
  for (const char of value) {
    const size = utf8Size(char.codePointAt(0) ?? 0);
    if (out.length + char.length > maxLength || bytes + size > maxBytes) break;
    out += char;
    bytes += size;
  }
  return out;
}

function utf8Size(codePoint: number): number {
  if (codePoint < 0x80) return 1;
  if (codePoint < 0x800) return 2;
  return codePoint < 0x10000 ? 3 : 4;
}

/** Key for comparing project paths the way case- and normalization-insensitive file systems (macOS, Windows) do. */
function comparablePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+/, '')
    .normalize('NFC')
    .toLowerCase();
}

/**
 * First free path `<dir>/<base>.<format>`, then `<base>-2`, `<base>-3`, …
 * `dir` defaults to `designs` (`''` = project root). `baseName` goes through
 * designFileNameFromTitle (a no-op for names it produced), and paths that
 * differ only in case or Unicode normalization count as taken.
 */
export function uniqueDesignPath(
  baseName: string,
  format: DesignDocumentFormat,
  existingPaths: Iterable<string>,
  dir: string = DESIGN_DOCUMENTS_DIR,
): string {
  const base = designFileNameFromTitle(baseName);
  const extension = format === 'op' ? 'op' : 'fig';
  const folder = String(dir ?? '')
    .replace(/\\/g, '/')
    .replace(/^(?:\.\/)+/, '')
    .replace(/^\/+|\/+$/g, '');
  const prefix = folder ? `${folder}/` : '';
  const taken = new Set<string>();
  for (const existing of existingPaths) {
    if (typeof existing === 'string') taken.add(comparablePath(existing));
  }
  for (let attempt = 1; ; attempt += 1) {
    const candidate = `${prefix}${attempt === 1 ? base : `${base}-${attempt}`}.${extension}`;
    if (!taken.has(comparablePath(candidate))) return candidate;
  }
}

/** `${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}`. */
export function designRevision(size: number, mtimeMs: number): string {
  return `${size.toString(16)}-${Math.floor(mtimeMs).toString(16)}`;
}

/** `GET` path of a design's cover PNG; `revision` (DesignDocumentSummary.revision) is a cache buster. */
export function designCoverApiPath(projectId: string, path: string, revision?: string): string {
  const coverPath = `/api/projects/${encodeURIComponent(projectId)}/designs/cover?path=${encodeURIComponent(path)}`;
  return revision ? `${coverPath}&v=${encodeURIComponent(revision)}` : coverPath;
}
