// SPDX-License-Identifier: Apache-2.0
// Project design documents (spec 06 §7.3): `.fig`/`.op` project files with sha256 compare-and-swap writes, revision
// history, covers, and the import of legacy design-canvas documents into projects. Project files resolve through the
// daemon's confined project paths (`resolveProjectFilePath` / `resolveProjectWritePath`, projects.ts); history, covers
// and the migration ledger live under the explicit runtime data root (root AGENTS.md data directory contract).
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  DESIGN_COVER_MAX_BYTES,
  DESIGN_COVER_MAX_EDGE,
  DESIGN_DOCUMENT_MAX_BYTES,
  DESIGN_HISTORY_LIMIT,
  DESIGN_SHA256_HEADER,
  designCoverApiPath,
  designFileNameFromTitle,
  designFormatForPath,
  designNameFromPath,
  designRevision,
  isDesignDocumentPath,
  uniqueDesignPath,
  type DesignDocumentFormat,
  type DesignDocumentSummary,
  type DesignMigrationRecord,
} from '@open-design/contracts';

import { ensureProject, listFiles, resolveProjectFilePath, resolveProjectWritePath } from '../../projects.js';
import type { CanvasStore } from '../../services/design-canvas.js';
import { DesignConflictError, DesignInputError } from './errors.js';
import {
  KeyedSerialQueue,
  isSha256Hex,
  readFileIfExists,
  readFileSnapshot,
  sha256Hex,
  writeContentAddressedFile,
  writeFileAtomic,
} from './files.js';
import { appendDesignMigration, readDesignMigrations } from './ledger.js';
import { designCoverPaths, designHistoryDir, validateDesignPath, validateExistingDesignPath } from './paths.js';
import { extractFigThumbnail, readPngSize, sniffDesignFormat } from './sniff.js';

export { DesignConflictError, DesignInputError } from './errors.js';
export type { DesignConflictReason, DesignInputErrorDetails, DesignInputReason } from './errors.js';

/** The part of the legacy global store the service reads (`CanvasStore`, services/design-canvas.ts). Never written. */
export type LegacyDesignStore = Pick<CanvasStore, 'read'>;

export interface DesignServiceOptions {
  /** PROJECTS_DIR (managed projects; imported folders use their `metadata.baseDir`). */
  projectsRoot: string;
  /** RUNTIME_DATA_DIR: history, covers and the migration ledger. */
  runtimeDataDir: string;
  legacyStore: LegacyDesignStore;
  historyLimit?: number;
  maxBytes?: number;
  now?: () => number;
}

export type DesignWritePrecondition = { ifMatch: string } | { ifNoneMatch: '*' };
export type DesignSummaryWithSha = DesignDocumentSummary & { sha256: string };

export interface DesignReadResult {
  bytes: Buffer;
  sha256: string;
  summary: DesignSummaryWithSha;
}

export interface DesignWriteResult {
  summary: DesignSummaryWithSha;
  created: boolean;
  previousSha256: string | null;
}

export interface DesignCoverResult {
  png: Buffer;
  source: 'cover' | 'thumbnail';
  /** Strong ETag (quoted sha256 of the PNG bytes). */
  etag: string;
}

export interface DesignLegacyImportResult {
  summary: DesignSummaryWithSha;
  migration: DesignMigrationRecord;
  alreadyImported: boolean;
}

export interface LegacyDesignInfo {
  legacyId: string;
  name: string;
  format: DesignDocumentFormat;
  /** sha256 of the decoded document bytes (equals the legacy record's `sha256` for documents CanvasStore wrote). */
  legacySha256: string;
}

interface LegacyDesignDocument extends LegacyDesignInfo {
  bytes: Buffer;
}

interface DocumentFingerprint {
  size: number;
  mtimeMs: number;
  ino: number;
  sha256: string;
  /** Embedded `.fig` thumbnail, once looked up (`null` = none). */
  thumbnail?: Buffer | null;
}

interface StoredCover {
  png: Buffer;
  pngSha256: string;
  docSha256: string;
}

const LEGACY_ID = /^[A-Za-z0-9_-]{1,80}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const HISTORY_FILE = /^[a-f0-9]{64}\.(?:fig|op)$/;
/** Generated import paths retried after a concurrent create (`<name>`, `<name>-2`, … like 04 §4.7). */
const IMPORT_PATH_ATTEMPTS = 50;
const FINGERPRINT_CACHE_LIMIT = 64;
/** Larger embedded thumbnails are re-extracted per request rather than cached (bounds the cache to ~32 MiB). */
const CACHED_THUMBNAIL_MAX_BYTES = 512 * 1024;
const LEDGER_QUEUE_KEY = 'ledger';

function errnoCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null ? (error as NodeJS.ErrnoException).code : undefined;
}

/** Turns the project-path helpers' failures into INVALID_DESIGN_PATH; other errors pass through. */
function asPathError(error: unknown, designPath: string): unknown {
  if (error instanceof DesignInputError || error instanceof DesignConflictError) return error;
  const code = errnoCode(error);
  if (code === 'EPATHESCAPE' || code === 'ENAMETOOLONG' || code === 'EISDIR' || code === 'ENOTDIR' || code === 'EINVAL') {
    return new DesignInputError('INVALID_DESIGN_PATH', `${designPath} is not a usable project path (${code})`);
  }
  if (error instanceof Error && /path escapes project dir|hidden path segments|invalid file name|reserved project path/.test(error.message)) {
    return new DesignInputError('INVALID_DESIGN_PATH', `${designPath}: ${error.message}`);
  }
  return error;
}

function notFound(designPath: string): DesignInputError {
  return new DesignInputError('DESIGN_NOT_FOUND', `${designPath} is not a project file`);
}

function documentKey(projectId: string, designPath: string): string {
  // Case- and normalization-insensitive file systems (macOS, Windows) map these paths to one file.
  return `doc\0${projectId}\0${designPath.normalize('NFC').toLowerCase()}`;
}

export class DesignDocumentService {
  private readonly projectsRoot: string;
  private readonly runtimeDataDir: string;
  private readonly legacyStore: LegacyDesignStore;
  private readonly historyLimit: number;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly queue = new KeyedSerialQueue();
  private readonly fingerprints = new Map<string, DocumentFingerprint>();
  private historyStamp = 0;

  constructor(opts: DesignServiceOptions) {
    this.projectsRoot = opts.projectsRoot;
    this.runtimeDataDir = opts.runtimeDataDir;
    this.legacyStore = opts.legacyStore;
    this.historyLimit = Math.max(1, Math.floor(opts.historyLimit ?? DESIGN_HISTORY_LIMIT));
    this.maxBytes = Math.max(1, Math.floor(opts.maxBytes ?? DESIGN_DOCUMENT_MAX_BYTES));
    this.now = opts.now ?? (() => Date.now());
  }

  // ---- summaries ---------------------------------------------------------------------------------------

  private summary(projectId: string, designPath: string, size: number, mtime: number): DesignDocumentSummary {
    const revision = designRevision(size, mtime);
    return {
      projectId,
      path: designPath,
      name: designNameFromPath(designPath),
      format: designFormatForPath(designPath) ?? 'fig',
      size,
      mtime,
      revision,
      coverUrl: designCoverApiPath(projectId, designPath, revision),
    };
  }

  /** Every `.fig`/`.op` file of the project, in project-file-list order (newest first). Nothing is hashed. */
  async list(projectId: string, metadata?: unknown): Promise<DesignDocumentSummary[]> {
    const files = (await listFiles(this.projectsRoot, projectId, { metadata })) as Array<{ name?: unknown; size?: unknown; mtime?: unknown }>;
    const designs: DesignDocumentSummary[] = [];
    for (const file of files) {
      if (typeof file.name !== 'string' || !isDesignDocumentPath(file.name)) continue;
      designs.push(this.summary(projectId, file.name, Number(file.size) || 0, Number(file.mtime) || 0));
    }
    return designs;
  }

  // ---- resolution ----------------------------------------------------------------------------------------

  /** Absolute path of an existing project file, or `null` when it does not exist. */
  private async resolveExisting(projectId: string, designPath: string, metadata: unknown): Promise<string | null> {
    try {
      const resolved = (await resolveProjectFilePath(this.projectsRoot, projectId, designPath, metadata)) as { filePath: string };
      return resolved.filePath;
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw asPathError(error, designPath);
    }
  }

  private async resolveWritable(projectId: string, designPath: string, metadata: unknown): Promise<string> {
    try {
      await ensureProject(this.projectsRoot, projectId, metadata);
      return (await resolveProjectWritePath(this.projectsRoot, projectId, designPath, metadata)) as string;
    } catch (error) {
      throw asPathError(error, designPath);
    }
  }

  private remember(file: string, fingerprint: DocumentFingerprint): void {
    this.fingerprints.delete(file);
    this.fingerprints.set(file, fingerprint);
    while (this.fingerprints.size > FINGERPRINT_CACHE_LIMIT) {
      const oldest = this.fingerprints.keys().next().value;
      if (oldest === undefined) break;
      this.fingerprints.delete(oldest);
    }
  }

  /**
   * sha256 (and the cached thumbnail) of a document, reused while size, mtime and inode are unchanged. Used for
   * covers only; compare-and-swap writes always hash the bytes on disk. `bytes` is set when the file was read.
   */
  private async fingerprint(file: string): Promise<(DocumentFingerprint & { bytes?: Buffer }) | null> {
    let stats;
    try {
      stats = await stat(file);
    } catch (error) {
      const code = errnoCode(error);
      if (code === 'ENOENT' || code === 'ENOTDIR') return null;
      throw error;
    }
    if (!stats.isFile()) return null;
    const cached = this.fingerprints.get(file);
    if (cached && cached.size === stats.size && cached.mtimeMs === stats.mtimeMs && cached.ino === stats.ino) return cached;
    const snapshot = await readFileSnapshot(file);
    if (!snapshot) return null;
    const fingerprint: DocumentFingerprint = { size: snapshot.size, mtimeMs: snapshot.mtimeMs, ino: snapshot.ino, sha256: sha256Hex(snapshot.bytes) };
    this.remember(file, fingerprint);
    return { ...fingerprint, bytes: snapshot.bytes };
  }

  // ---- read / stat -----------------------------------------------------------------------------------------

  async read(projectId: string, designPath: string, metadata?: unknown): Promise<DesignReadResult> {
    const normalized = validateExistingDesignPath(designPath);
    const file = await this.resolveExisting(projectId, normalized, metadata);
    const snapshot = file ? await readFileSnapshot(file) : null;
    if (!file || !snapshot) throw notFound(normalized);
    const sha256 = sha256Hex(snapshot.bytes);
    this.remember(file, { size: snapshot.size, mtimeMs: snapshot.mtimeMs, ino: snapshot.ino, sha256 });
    return {
      bytes: snapshot.bytes,
      sha256,
      summary: { ...this.summary(projectId, normalized, snapshot.size, snapshot.mtimeMs), sha256 },
    };
  }

  /** Summary of an existing design document, or `null` (missing file or a path that is not a design document). */
  async stat(projectId: string, designPath: string, metadata?: unknown): Promise<DesignDocumentSummary | null> {
    let normalized: string;
    try {
      normalized = validateExistingDesignPath(designPath);
    } catch {
      return null;
    }
    const file = await this.resolveExisting(projectId, normalized, metadata).catch(() => null);
    if (!file) return null;
    const stats = await stat(file).catch(() => null);
    if (!stats?.isFile()) return null;
    return this.summary(projectId, normalized, stats.size, stats.mtimeMs);
  }

  // ---- write -----------------------------------------------------------------------------------------------

  private checkDocumentBytes(bytes: Buffer, format: DesignDocumentFormat, designPath: string): void {
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      throw new DesignInputError('INVALID_DESIGN_DATA', 'the design document is empty');
    }
    if (bytes.length > this.maxBytes) {
      throw new DesignInputError('DESIGN_TOO_LARGE', `design documents are limited to ${this.maxBytes} bytes`);
    }
    if (!sniffDesignFormat(bytes, format)) {
      throw new DesignInputError(
        'INVALID_DESIGN_DATA',
        format === 'fig' ? `${designPath} is not a .fig document (expected a ZIP or fig-kiwi file)` : `${designPath} is not a .op (JSON) document`,
      );
    }
  }

  /**
   * Compare-and-swap write. `{ifNoneMatch:'*'}` creates (the path must be canonical and free); `{ifMatch}` replaces
   * the document whose current bytes hash to that sha256. Serialized per document, atomic (temp + fsync + rename),
   * and the replaced bytes go to the history first.
   */
  async write(
    projectId: string,
    designPath: string,
    bytes: Buffer,
    precondition: DesignWritePrecondition,
    metadata?: unknown,
  ): Promise<DesignWriteResult> {
    const create = 'ifNoneMatch' in precondition;
    const normalized = create ? validateDesignPath(designPath) : validateExistingDesignPath(designPath);
    const format = designFormatForPath(normalized) ?? 'fig';
    this.checkDocumentBytes(bytes, format, normalized);
    const expected = create ? null : String((precondition as { ifMatch: string }).ifMatch).toLowerCase();
    return this.queue.run(documentKey(projectId, normalized), async () => {
      const target = await this.resolveWritable(projectId, normalized, metadata);
      let current: Buffer | null;
      try {
        current = await readFileIfExists(target);
      } catch (error) {
        throw asPathError(error, normalized);
      }
      const currentSha = current ? sha256Hex(current) : null;
      if (create ? current !== null : currentSha !== expected) throw new DesignConflictError(currentSha, normalized);
      const nextSha = sha256Hex(bytes);
      if (current && currentSha && currentSha !== nextSha) await this.pushHistory(projectId, normalized, format, current, currentSha);
      try {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFileAtomic(target, bytes);
      } catch (error) {
        throw asPathError(error, normalized);
      }
      const stats = await stat(target);
      this.remember(target, { size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, sha256: nextSha });
      return {
        summary: { ...this.summary(projectId, normalized, stats.size, stats.mtimeMs), sha256: nextSha },
        created: current === null,
        previousSha256: currentSha,
      };
    });
  }

  private nextHistoryStamp(): Date {
    this.historyStamp = Math.max(this.now(), this.historyStamp + 1);
    return new Date(this.historyStamp);
  }

  /** Keeps `<sha256>.<ext>` of the replaced bytes, then trims the folder to the newest `historyLimit` by mtime. */
  private async pushHistory(projectId: string, designPath: string, format: DesignDocumentFormat, bytes: Buffer, sha256: string): Promise<void> {
    const dir = designHistoryDir(this.runtimeDataDir, projectId, designPath);
    await mkdir(dir, { recursive: true });
    await writeContentAddressedFile(path.join(dir, `${sha256}.${format}`), bytes, this.nextHistoryStamp());
    const names = (await readdir(dir)).filter((name) => HISTORY_FILE.test(name));
    if (names.length <= this.historyLimit) return;
    const entries = await Promise.all(
      names.map(async (name) => ({ name, mtimeMs: (await stat(path.join(dir, name)).catch(() => null))?.mtimeMs ?? 0 })),
    );
    entries.sort((a, b) => b.mtimeMs - a.mtimeMs || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries.slice(this.historyLimit)) await rm(path.join(dir, entry.name), { force: true });
  }

  // ---- covers ----------------------------------------------------------------------------------------------

  private async readStoredCover(projectId: string, designPath: string): Promise<StoredCover | null> {
    const paths = designCoverPaths(this.runtimeDataDir, projectId, designPath);
    const rawMeta = await readFileIfExists(paths.meta);
    if (!rawMeta) return null;
    let meta: { docSha256?: unknown; pngSha256?: unknown };
    try {
      meta = JSON.parse(rawMeta.toString('utf8')) as typeof meta;
    } catch {
      return null;
    }
    if (!isSha256Hex(meta.docSha256) || !isSha256Hex(meta.pngSha256)) return null;
    const png = await readFileIfExists(paths.png);
    if (!png) return null;
    const pngSha256 = sha256Hex(png);
    // A cover replaced between the two reads is ignored rather than served under the wrong document revision.
    if (pngSha256 !== meta.pngSha256) return null;
    return { png, pngSha256, docSha256: meta.docSha256 };
  }

  /**
   * The stored cover while it was rendered from the current bytes, else the `.fig`'s embedded thumbnail, else
   * `null`.
   */
  async readCover(projectId: string, designPath: string, metadata?: unknown): Promise<DesignCoverResult | null> {
    const normalized = validateExistingDesignPath(designPath);
    const file = await this.resolveExisting(projectId, normalized, metadata);
    if (!file) return null;
    const document = await this.fingerprint(file);
    if (!document) return null;
    const stored = await this.readStoredCover(projectId, normalized);
    if (stored && stored.docSha256 === document.sha256) {
      return { png: stored.png, source: 'cover', etag: `"${stored.pngSha256}"` };
    }
    if (designFormatForPath(normalized) !== 'fig') return null;
    let thumbnail = document.thumbnail;
    if (thumbnail === undefined) {
      const bytes = document.bytes ?? (await readFileSnapshot(file))?.bytes;
      thumbnail = bytes ? await extractFigThumbnail(bytes) : null;
      const cached = this.fingerprints.get(file);
      if (cached && cached.sha256 === document.sha256 && (!thumbnail || thumbnail.length <= CACHED_THUMBNAIL_MAX_BYTES)) {
        cached.thumbnail = thumbnail;
      }
    }
    return thumbnail ? { png: thumbnail, source: 'thumbnail', etag: `"${sha256Hex(thumbnail)}"` } : null;
  }

  /** Stores a cover PNG rendered from the document whose sha256 is `docSha256`; a changed document → stale conflict. */
  async writeCover(projectId: string, designPath: string, png: Buffer, docSha256: string, metadata?: unknown): Promise<void> {
    const normalized = validateExistingDesignPath(designPath);
    const expected = typeof docSha256 === 'string' ? docSha256.trim().toLowerCase() : '';
    if (!isSha256Hex(expected)) {
      throw new DesignInputError('INVALID_COVER', `${DESIGN_SHA256_HEADER} must be the sha256 of the document the cover was rendered from`);
    }
    if (!Buffer.isBuffer(png) || png.length === 0) throw new DesignInputError('INVALID_COVER', 'the cover image is empty');
    if (png.length > DESIGN_COVER_MAX_BYTES) {
      throw new DesignInputError('INVALID_COVER', `cover images are limited to ${DESIGN_COVER_MAX_BYTES} bytes`);
    }
    const size = readPngSize(png);
    if (!size) throw new DesignInputError('INVALID_COVER', 'covers must be PNG images');
    if (size.width > DESIGN_COVER_MAX_EDGE || size.height > DESIGN_COVER_MAX_EDGE) {
      throw new DesignInputError('INVALID_COVER', `cover images are limited to ${DESIGN_COVER_MAX_EDGE}×${DESIGN_COVER_MAX_EDGE} px`);
    }
    await this.queue.run(documentKey(projectId, normalized), async () => {
      const file = await this.resolveExisting(projectId, normalized, metadata);
      const document = file ? await this.fingerprint(file) : null;
      const currentSha = document?.sha256 ?? null;
      if (currentSha !== expected) throw new DesignConflictError(currentSha, normalized, 'DESIGN_COVER_STALE');
      const paths = designCoverPaths(this.runtimeDataDir, projectId, normalized);
      await mkdir(path.dirname(paths.png), { recursive: true });
      await writeFileAtomic(paths.png, png);
      const meta = {
        path: normalized,
        docSha256: expected,
        pngSha256: sha256Hex(png),
        width: size.width,
        height: size.height,
        updatedAt: new Date(this.now()).toISOString(),
      };
      await writeFileAtomic(paths.meta, `${JSON.stringify(meta)}\n`);
    });
  }

  // ---- legacy design-canvas documents ----------------------------------------------------------------------

  private async loadLegacy(legacyId: string): Promise<LegacyDesignDocument | null> {
    if (typeof legacyId !== 'string' || !LEGACY_ID.test(legacyId)) return null;
    let doc: unknown;
    try {
      doc = await this.legacyStore.read(legacyId);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new DesignInputError('INVALID_DESIGN_DATA', `legacy design document ${legacyId} is not readable`);
      }
      throw error;
    }
    if (doc === null || typeof doc !== 'object') return null;
    const record = doc as { name?: unknown; format?: unknown; data?: unknown };
    const invalid = (why: string) => new DesignInputError('INVALID_DESIGN_DATA', `legacy design document ${legacyId} ${why}`);
    if (record.format !== 'fig' && record.format !== 'op') throw invalid('has no .fig/.op format');
    if (typeof record.data !== 'string' || !BASE64.test(record.data)) throw invalid('has no base64 data');
    const bytes = Buffer.from(record.data, 'base64');
    if (bytes.length === 0) throw invalid('is empty');
    if (!sniffDesignFormat(bytes, record.format)) throw invalid(`is not a .${record.format} document`);
    return {
      legacyId,
      name: typeof record.name === 'string' ? record.name : '',
      format: record.format,
      bytes,
      legacySha256: sha256Hex(bytes),
    };
  }

  /** Name, format and content sha256 of a legacy document; `null` when unknown. Throws INVALID_DESIGN_DATA when unusable. */
  async legacyInfo(legacyId: string): Promise<LegacyDesignInfo | null> {
    const legacy = await this.loadLegacy(legacyId);
    return legacy ? { legacyId: legacy.legacyId, name: legacy.name, format: legacy.format, legacySha256: legacy.legacySha256 } : null;
  }

  /** The newest ledger record of this import whose target still holds the recorded bytes. */
  private async findImported(projectId: string, legacy: LegacyDesignDocument, metadata: unknown): Promise<{ record: DesignMigrationRecord; summary: DesignSummaryWithSha } | null> {
    const records = (await readDesignMigrations(this.runtimeDataDir))
      .filter((record) => record.legacyId === legacy.legacyId && record.legacySha256 === legacy.legacySha256 && record.projectId === projectId)
      .reverse();
    for (const record of records) {
      let normalized: string;
      try {
        normalized = validateExistingDesignPath(record.path);
      } catch {
        continue;
      }
      const file = await this.resolveExisting(projectId, normalized, metadata).catch(() => null);
      const document = file ? await this.fingerprint(file) : null;
      if (!document || document.sha256 !== record.sha256) continue;
      return { record, summary: { ...this.summary(projectId, normalized, document.size, document.mtimeMs), sha256: document.sha256 } };
    }
    return null;
  }

  /**
   * Copies a legacy design-canvas document into the project (create-only) and records it in the migration ledger.
   * `designPath` = explicit target (must be canonical and free; else `PATH_EXISTS`), or `designs/<name>.<ext>` made
   * unique. Idempotent: the same document bytes already imported into this project, with the target still holding
   * them, give `alreadyImported: true`. The legacy store is only read.
   */
  async importLegacy(projectId: string, legacyId: string, designPath: string | undefined, metadata?: unknown): Promise<DesignLegacyImportResult> {
    return this.queue.run(`import\0${projectId}\0${legacyId}`, async () => {
      const legacy = await this.loadLegacy(legacyId);
      if (!legacy) throw new DesignInputError('LEGACY_NOT_FOUND', `legacy design document ${String(legacyId)} not found`);
      const explicitPath = designPath === undefined || designPath === '' ? null : validateDesignPath(designPath);
      if (explicitPath && designFormatForPath(explicitPath) !== legacy.format) {
        const suggestion = `${explicitPath.slice(0, explicitPath.lastIndexOf('.'))}.${legacy.format}`;
        throw new DesignInputError('INVALID_DESIGN_PATH', `a .${legacy.format} document needs a .${legacy.format} path`, { suggestion });
      }
      const existing = await this.findImported(projectId, legacy, metadata);
      if (existing) return { summary: existing.summary, migration: existing.record, alreadyImported: true };

      let written: DesignWriteResult | null = null;
      if (explicitPath) {
        try {
          written = await this.write(projectId, explicitPath, legacy.bytes, { ifNoneMatch: '*' }, metadata);
        } catch (error) {
          if (!(error instanceof DesignConflictError)) throw error;
          throw new DesignInputError('PATH_EXISTS', `${explicitPath} already exists`, { path: explicitPath, currentSha256: error.currentSha256 });
        }
      } else {
        const files = (await listFiles(this.projectsRoot, projectId, { metadata })) as Array<{ name?: unknown }>;
        const taken = new Set(files.flatMap((file) => (typeof file.name === 'string' ? [file.name] : [])));
        const base = designFileNameFromTitle(legacy.name);
        for (let attempt = 1; written === null; attempt += 1) {
          const candidate = uniqueDesignPath(base, legacy.format, taken);
          try {
            written = await this.write(projectId, candidate, legacy.bytes, { ifNoneMatch: '*' }, metadata);
          } catch (error) {
            if (!(error instanceof DesignConflictError) || attempt >= IMPORT_PATH_ATTEMPTS) throw error;
            taken.add(candidate);
          }
        }
      }
      const migration: DesignMigrationRecord = {
        legacyId: legacy.legacyId,
        legacySha256: legacy.legacySha256,
        projectId,
        path: written.summary.path,
        sha256: written.summary.sha256,
        migratedAt: new Date(this.now()).toISOString(),
      };
      await this.queue.run(LEDGER_QUEUE_KEY, () => appendDesignMigration(this.runtimeDataDir, migration, this.now()));
      return { summary: written.summary, migration, alreadyImported: false };
    });
  }

  /** The migration ledger, oldest first. */
  listMigrations(): Promise<DesignMigrationRecord[]> {
    return readDesignMigrations(this.runtimeDataDir);
  }
}
