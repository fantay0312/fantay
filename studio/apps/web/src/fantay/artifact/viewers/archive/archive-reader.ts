// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code packages/client-runtime/src/zip/zipDirectory.ts, zip/boundedZip.ts and
// apps/web/src/components/files/binaryPreview.worker.ts @ c5e6b24f (MIT): walking the ZIP directory
// with every length checked before anything is allocated, the entry and size limits, and the TAR
// header reader (checksum, ustar prefix, GNU long names, pax records).
// Changed here: listing inflates nothing (t3code unpacks every entry through JSZip); one entry is
// inflated on demand through fflate under a hard output cap; ZIP64, legacy name encodings (GBK),
// encryption and link flags are read; TAR is scanned as a stream, so a .tar.gz is listed without
// holding the unpacked tar; a path that would leave the folder is reported, not thrown.
//
// What is inside an archive, read without unpacking it. Pure: no DOM and no worker globals, so the
// worker and the tests share it. The archive is untrusted: every offset is checked against the
// buffer, entries are counted, nothing is written anywhere and links are named but never followed.
import { Gunzip, Inflate } from 'fflate';

/** Entries past this are not listed; the listing says so. */
export const ARCHIVE_MAX_ENTRIES = 20_000;
/** A longer path is not a path anyone meant; the entry is dropped and counted as unsafe. */
export const ARCHIVE_MAX_PATH = 1024;
export const ARCHIVE_TEXT_PEEK_BYTES = 1024 * 1024;
export const ARCHIVE_IMAGE_PEEK_BYTES = 8 * 1024 * 1024;
/** Saving one entry out of the archive unpacks at most this much. */
export const ARCHIVE_SAVE_BYTES = 64 * 1024 * 1024;
/** How far a gzip stream is followed while listing. Nothing of it is kept past `RETAIN_BYTES`. */
export const ARCHIVE_MAX_STREAM_BYTES = 2 * 1024 * 1024 * 1024;
/** An unpacked tar up to this size stays in memory, so its entries open without unpacking again. */
const RETAIN_BYTES = 48 * 1024 * 1024;
const DEFAULT_BUDGET_MS = 12_000;
const INFLATE_STEP = 32 * 1024;

export type ArchiveFormat = 'zip' | 'tar' | 'tar.gz' | 'gz';

/**
 * Why an archive or one of its entries could not be read. The viewer words these itself.
 * `invalid`: not this format, or damaged. `encrypted`: needs a password. `too-large`: over the cap
 * it was asked to stay under. `unsupported`: a compression method this reader does not have.
 * `timeout`: took too long. `missing`: no such entry, or an entry with no bytes (a folder, a link).
 */
export type ArchiveFailure = 'invalid' | 'encrypted' | 'too-large' | 'unsupported' | 'timeout' | 'missing';

export class ArchiveError extends Error {
  constructor(readonly code: ArchiveFailure) {
    super(code);
  }
}

export interface ArchiveEntry {
  /** What `read` takes. Stable for one opened archive. */
  id: number;
  /** Clean relative path: `/` separated, no leading slash, no `.` or `..` parts. */
  path: string;
  kind: 'file' | 'dir' | 'link';
  /** Unpacked size in bytes, as the archive states it. */
  size: number;
  /** Size inside the archive; null where the format does not say (tar). */
  packedSize: number | null;
  /** Milliseconds since the epoch, or null. */
  modified: number | null;
  encrypted: boolean;
  /** Where a link points, when the archive says. Shown, never followed. */
  linkTarget: string | null;
}

export interface ArchiveListing {
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  /** Entries that are not folders. */
  fileCount: number;
  /** Sum of the unpacked sizes of the files. */
  totalSize: number;
  /** True when the archive holds more entries than `ARCHIVE_MAX_ENTRIES`. */
  truncated: boolean;
  /** Entries whose stored path was absolute, climbed out with `..`, or was too long. */
  unsafePaths: number;
  /** Entries that need a password. */
  encryptedCount: number;
}

export interface OpenedArchive {
  listing: ArchiveListing;
  /** The unpacked bytes of one file. Throws `ArchiveError`; `too-large` when over `limit`. */
  read(id: number, limit: number): Uint8Array<ArrayBuffer>;
}

export interface OpenArchiveOptions {
  /** The format the file name suggests; the bytes decide when they disagree. */
  hint?: ArchiveFormat;
  maxEntries?: number;
  /** Time allowed for listing, in ms. */
  budgetMs?: number;
}

// ── names and paths ─────────────────────────────────────────────────────────────────────────────

function isAscii(bytes: Uint8Array): boolean {
  for (let index = 0; index < bytes.length; index += 1) if ((bytes[index] ?? 0) >= 0x80) return false;
  return true;
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let index = 0; index < bytes.length; index += 1) out += String.fromCharCode(bytes[index] ?? 0);
  return out;
}

function tryDecode(label: string, bytes: Uint8Array): string | null {
  try {
    return new TextDecoder(label, { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * An entry name as text. Archives rarely say which encoding they used: UTF-8 when the archive
 * claims it or the bytes are valid UTF-8, then GBK (what Windows tools in China write), then
 * byte-for-byte so a name is always shown.
 */
export function decodeEntryName(bytes: Uint8Array, declaredUtf8 = false): string {
  if (isAscii(bytes)) return latin1(bytes);
  if (declaredUtf8) return new TextDecoder().decode(bytes);
  return tryDecode('utf-8', bytes) ?? tryDecode('gbk', bytes) ?? latin1(bytes);
}

export interface CleanPath {
  path: string;
  /** The stored path was absolute or climbed out of the archive's folder. */
  unsafe: boolean;
  /** The stored path ended in a slash. */
  dir: boolean;
}

/**
 * The path an entry is listed under. A stored path may be absolute or contain `..` to write outside
 * the folder it is unpacked into; nothing is unpacked here, so such a path is made relative for
 * display and flagged.
 */
export function cleanArchivePath(raw: string, backslashes = false): CleanPath {
  let text = raw;
  const nul = text.indexOf('\0');
  if (nul !== -1) text = text.slice(0, nul);
  if (backslashes) text = text.replace(/\\/g, '/');
  let unsafe = text.startsWith('/');
  if (/^[A-Za-z]:/.test(text)) {
    unsafe = true;
    text = text.slice(2);
  }
  const dir = text.endsWith('/');
  const parts: string[] = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      unsafe = true;
      continue;
    }
    parts.push(part);
  }
  return { path: parts.join('/'), unsafe, dir };
}

interface RawEntry {
  rawPath: string;
  backslashes: boolean;
  kind: 'file' | 'dir' | 'link';
  size: number;
  packedSize: number | null;
  modified: number | null;
  encrypted: boolean;
  linkTarget: string | null;
}

function buildListing(format: ArchiveFormat, raw: readonly RawEntry[], truncated: boolean): ArchiveListing {
  const byPath = new Map<string, ArchiveEntry>();
  let unsafePaths = 0;
  raw.forEach((item, id) => {
    const clean = cleanArchivePath(item.rawPath, item.backslashes);
    if (clean.unsafe) unsafePaths += 1;
    if (clean.path === '') return;
    if (clean.path.length > ARCHIVE_MAX_PATH) {
      if (!clean.unsafe) unsafePaths += 1;
      return;
    }
    const kind = item.kind === 'file' && clean.dir ? 'dir' : item.kind;
    // The same path stored twice: the later one is what unpacking would leave behind.
    byPath.set(`${kind === 'dir' ? 'd' : 'f'}:${clean.path}`, {
      id,
      path: clean.path,
      kind,
      size: kind === 'file' ? item.size : 0,
      packedSize: kind === 'file' ? item.packedSize : null,
      modified: item.modified,
      encrypted: item.encrypted,
      linkTarget: item.linkTarget,
    });
  });
  const entries = [...byPath.values()];
  let fileCount = 0;
  let totalSize = 0;
  let encryptedCount = 0;
  for (const entry of entries) {
    if (entry.kind === 'dir') continue;
    fileCount += 1;
    totalSize += entry.size;
    if (entry.encrypted) encryptedCount += 1;
  }
  return { format, entries, fileCount, totalSize, truncated, unsafePaths, encryptedCount };
}

// ── inflate, bounded ────────────────────────────────────────────────────────────────────────────

function concat(chunks: readonly Uint8Array[], total: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Raw DEFLATE, stopped the moment the output passes `limit` (the stored size is not trusted). */
function inflateBounded(data: Uint8Array, limit: number): Uint8Array<ArrayBuffer> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const stream = new Inflate((chunk) => {
    total += chunk.length;
    if (total > limit) throw new ArchiveError('too-large');
    chunks.push(chunk);
  });
  try {
    // Fed in small steps, so a bomb is cut off after one step's worth of output.
    for (let offset = 0; offset < data.length || offset === 0; offset += INFLATE_STEP) {
      stream.push(data.subarray(offset, offset + INFLATE_STEP), offset + INFLATE_STEP >= data.length);
    }
  } catch (error) {
    throw error instanceof ArchiveError ? error : new ArchiveError('invalid');
  }
  return concat(chunks, total);
}

/** Feeds a gzip stream to `onChunk` until it returns false, the input ends or the time is up. */
function gunzipStream(bytes: Uint8Array, deadline: number, onChunk: (chunk: Uint8Array) => boolean): void {
  let stopped = false;
  const stream = new Gunzip((chunk) => {
    if (!stopped && !onChunk(chunk)) stopped = true;
  });
  try {
    for (let offset = 0; offset < bytes.length && !stopped; offset += INFLATE_STEP) {
      stream.push(bytes.subarray(offset, offset + INFLATE_STEP), offset + INFLATE_STEP >= bytes.length);
      if (Date.now() > deadline) throw new ArchiveError('timeout');
    }
  } catch (error) {
    throw error instanceof ArchiveError ? error : new ArchiveError('invalid');
  }
}

// ── zip ─────────────────────────────────────────────────────────────────────────────────────────

const ZIP_END = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_END = 0x06064b50;
const ZIP_CENTRAL = 0x02014b50;
const ZIP_LOCAL = 0x04034b50;

interface ZipRecord {
  offset: number;
  packed: number;
  size: number;
  method: number;
  encrypted: boolean;
  readable: boolean;
}

function safeNumber(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new ArchiveError('invalid');
  return Number(value);
}

interface ZipDirectory {
  start: number;
  end: number;
  /** Bytes in front of the archive (a self-extracting stub) shift every stored offset by this. */
  shift: number;
}

function findZipDirectory(view: DataView): ZipDirectory {
  const length = view.byteLength;
  for (let at = length - 22; at >= Math.max(0, length - 65_557); at -= 1) {
    if (view.getUint32(at, true) !== ZIP_END) continue;
    if (at + 22 + view.getUint16(at + 20, true) > length) continue;
    let count = view.getUint16(at + 10, true);
    let size = view.getUint32(at + 12, true);
    let offset = view.getUint32(at + 16, true);
    let directoryEnd = at;
    if (count === 0xffff || size === 0xffffffff || offset === 0xffffffff) {
      const locator = at - 20;
      if (locator < 0 || view.getUint32(locator, true) !== ZIP64_LOCATOR) throw new ArchiveError('invalid');
      const record = safeNumber(view.getBigUint64(locator + 8, true));
      if (record + 56 > length || view.getUint32(record, true) !== ZIP64_END) throw new ArchiveError('invalid');
      count = safeNumber(view.getBigUint64(record + 32, true));
      size = safeNumber(view.getBigUint64(record + 40, true));
      offset = safeNumber(view.getBigUint64(record + 48, true));
      directoryEnd = record;
    }
    if (offset + size > directoryEnd) throw new ArchiveError('invalid');
    if (count === 0 || size === 0) return { start: offset, end: offset, shift: 0 };
    const stored = offset + 4 <= length && view.getUint32(offset, true) === ZIP_CENTRAL;
    const shifted = directoryEnd - size;
    if (!stored && shifted !== offset && view.getUint32(shifted, true) === ZIP_CENTRAL) {
      return { start: shifted, end: directoryEnd, shift: shifted - offset };
    }
    if (!stored) throw new ArchiveError('invalid');
    return { start: offset, end: offset + size, shift: 0 };
  }
  throw new ArchiveError('invalid');
}

/** MS-DOS date and time, which a ZIP stores in the local time of whoever made it. */
function dosTime(date: number, time: number): number | null {
  if (date === 0) return null;
  const value = new Date(
    1980 + (date >>> 9),
    ((date >>> 5) & 0x0f) - 1,
    date & 0x1f,
    time >>> 11,
    (time >>> 5) & 0x3f,
    (time & 0x1f) * 2,
  ).getTime();
  return Number.isNaN(value) ? null : value;
}

function openZip(bytes: Uint8Array, maxEntries: number): OpenedArchive {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const directory = findZipDirectory(view);
  const records: ZipRecord[] = [];
  const raw: RawEntry[] = [];
  let truncated = false;

  for (let at = directory.start; at < directory.end; ) {
    if (at + 46 > directory.end || view.getUint32(at, true) !== ZIP_CENTRAL) {
      if (records.length === 0) throw new ArchiveError('invalid');
      break; // A damaged tail: what was read so far is still worth showing.
    }
    if (records.length >= maxEntries) {
      truncated = true;
      break;
    }
    const host = view.getUint8(at + 5);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    let packed = view.getUint32(at + 20, true);
    let size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const attributes = view.getUint32(at + 38, true);
    let offset = view.getUint32(at + 42, true);
    const nameStart = at + 46;
    const extraStart = nameStart + nameLength;
    const next = extraStart + extraLength + commentLength;
    if (next > directory.end) {
      if (records.length === 0) throw new ArchiveError('invalid');
      break;
    }
    // Names of a strongly encrypted directory are masked: there is nothing to list.
    if (flags & 0x2000) throw new ArchiveError('encrypted');

    let name = decodeEntryName(bytes.subarray(nameStart, extraStart), (flags & 0x0800) !== 0);
    let modified = dosTime(view.getUint16(at + 14, true), view.getUint16(at + 12, true));
    for (let field = extraStart; field + 4 <= extraStart + extraLength; ) {
      const id = view.getUint16(field, true);
      const fieldLength = view.getUint16(field + 2, true);
      const body = field + 4;
      if (body + fieldLength > extraStart + extraLength) break;
      if (id === 0x0001) {
        // ZIP64: only the values that overflowed are present, in this order.
        let cursor = body;
        const take = (): number => {
          if (cursor + 8 > body + fieldLength) throw new ArchiveError('invalid');
          const value = safeNumber(view.getBigUint64(cursor, true));
          cursor += 8;
          return value;
        };
        if (size === 0xffffffff) size = take();
        if (packed === 0xffffffff) packed = take();
        if (offset === 0xffffffff) offset = take();
      } else if (id === 0x7075 && fieldLength > 5) {
        // Info-ZIP Unicode path: the real name when the main one is in a legacy encoding.
        name = new TextDecoder().decode(bytes.subarray(body + 5, body + fieldLength));
      } else if (id === 0x5455 && fieldLength >= 5 && view.getUint8(body) & 1) {
        modified = view.getUint32(body + 1, true) * 1000;
      }
      field = body + fieldLength;
    }

    const unix = host === 3;
    const mode = unix ? attributes >>> 16 : 0;
    const isLink = (mode & 0o170000) === 0o120000;
    const isDir = name.endsWith('/') || (mode & 0o170000) === 0o040000 || (!unix && (attributes & 0x10) !== 0);
    const encrypted = (flags & 1) !== 0;
    records.push({ offset: offset + directory.shift, packed, size, method, encrypted, readable: !isDir && !isLink });
    raw.push({
      rawPath: name,
      backslashes: !unix,
      kind: isDir ? 'dir' : isLink ? 'link' : 'file',
      size,
      packedSize: packed,
      modified,
      encrypted,
      linkTarget: null,
    });
    at = next;
  }

  return {
    listing: buildListing('zip', raw, truncated),
    read(id, limit) {
      const record = records[id];
      if (!record || !record.readable) throw new ArchiveError('missing');
      if (record.encrypted) throw new ArchiveError('encrypted');
      if (record.size > limit) throw new ArchiveError('too-large');
      const at = record.offset;
      if (at + 30 > bytes.length || view.getUint32(at, true) !== ZIP_LOCAL) throw new ArchiveError('invalid');
      const start = at + 30 + view.getUint16(at + 26, true) + view.getUint16(at + 28, true);
      const stop = start + record.packed;
      if (stop > bytes.length) throw new ArchiveError('invalid');
      const data = bytes.subarray(start, stop);
      if (record.method === 0) {
        if (data.length > limit) throw new ArchiveError('too-large');
        return data.slice();
      }
      if (record.method === 8) return inflateBounded(data, limit);
      throw new ArchiveError('unsupported');
    },
  };
}

// ── tar ─────────────────────────────────────────────────────────────────────────────────────────

const BLOCK = 512;
const MAX_TAR_METADATA = 1024 * 1024;

interface TarRecord {
  /** Where the entry's bytes start in the (unpacked) tar stream. */
  offset: number;
  size: number;
  readable: boolean;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let index = 0; index < BLOCK; index += 1) if (block[index] !== 0) return false;
  return true;
}

function tarField(block: Uint8Array, offset: number, length: number): Uint8Array {
  let end = offset;
  while (end < offset + length && block[end] !== 0) end += 1;
  return block.subarray(offset, end);
}

/** A numeric header field: octal text, or GNU's binary form when the first bit is set. */
function tarNumber(block: Uint8Array, offset: number, length: number): number {
  if ((block[offset] ?? 0) & 0x80) {
    let value = (block[offset] ?? 0) & 0x7f;
    for (let index = offset + 1; index < offset + length; index += 1) {
      value = value * 256 + (block[index] ?? 0);
      if (value > Number.MAX_SAFE_INTEGER) throw new ArchiveError('invalid');
    }
    return value;
  }
  const text = latin1(tarField(block, offset, length)).trim();
  if (text === '') return 0;
  if (!/^[0-7]+$/.test(text)) throw new ArchiveError('invalid');
  return Number.parseInt(text, 8);
}

function tarChecksumOk(block: Uint8Array): boolean {
  let unsigned = 0;
  let signed = 0;
  for (let index = 0; index < BLOCK; index += 1) {
    const byte = index >= 148 && index < 156 ? 32 : (block[index] ?? 0);
    unsigned += byte;
    signed += byte > 127 ? byte - 256 : byte;
  }
  let stored: number;
  try {
    stored = tarNumber(block, 148, 8);
  } catch {
    return false;
  }
  return stored === unsigned || stored === signed;
}

/** True when 512 bytes read as a tar header: used to tell a tar from other data. */
export function looksLikeTarHeader(block: Uint8Array): boolean {
  return block.length >= BLOCK && !isZeroBlock(block) && tarChecksumOk(block);
}

function parsePax(data: Uint8Array, into: Record<string, string>): void {
  for (let cursor = 0; cursor < data.length; ) {
    const space = data.indexOf(32, cursor);
    if (space <= cursor || space - cursor > 10) return;
    const length = Number(latin1(data.subarray(cursor, space)));
    const end = cursor + length;
    if (!Number.isSafeInteger(length) || length <= 0 || end > data.length || end <= space + 1) return;
    const record = new TextDecoder().decode(data.subarray(space + 1, end - 1));
    const equals = record.indexOf('=');
    if (equals > 0) {
      const key = record.slice(0, equals);
      if (key === 'path' || key === 'linkpath' || key === 'size' || key === 'mtime') into[key] = record.slice(equals + 1);
    }
    cursor = end;
  }
}

/**
 * Reads tar headers out of a stream of chunks and passes over the file data between them, so the
 * unpacked tar never has to exist in one piece.
 */
class TarScanner {
  readonly records: TarRecord[] = [];
  readonly raw: RawEntry[] = [];
  done = false;
  truncated = false;
  private position = 0;
  private readonly head = new Uint8Array(BLOCK);
  private headFill = 0;
  private skip = 0;
  private meta: { type: string; data: Uint8Array; fill: number; pad: number } | null = null;
  private sawHeader = false;
  private zeroBlocks = 0;
  private longName: string | null = null;
  private longLink: string | null = null;
  private pax: Record<string, string> = {};
  private readonly globalPax: Record<string, string> = {};

  constructor(private readonly maxEntries: number) {}

  push(chunk: Uint8Array): void {
    let at = 0;
    while (at < chunk.length && !this.done) {
      const left = chunk.length - at;
      if (this.meta) {
        const take = Math.min(this.meta.data.length - this.meta.fill, left);
        this.meta.data.set(chunk.subarray(at, at + take), this.meta.fill);
        this.meta.fill += take;
        at += take;
        this.position += take;
        if (this.meta.fill === this.meta.data.length) this.finishMeta();
      } else if (this.skip > 0) {
        const take = Math.min(this.skip, left);
        this.skip -= take;
        at += take;
        this.position += take;
      } else {
        const take = Math.min(BLOCK - this.headFill, left);
        this.head.set(chunk.subarray(at, at + take), this.headFill);
        this.headFill += take;
        at += take;
        this.position += take;
        if (this.headFill === BLOCK) {
          this.headFill = 0;
          this.header();
        }
      }
    }
  }

  private finishMeta(): void {
    const meta = this.meta;
    if (!meta) return;
    this.meta = null;
    this.skip = meta.pad;
    if (meta.type === 'L') this.longName = decodeEntryName(tarField(meta.data, 0, meta.data.length));
    else if (meta.type === 'K') this.longLink = decodeEntryName(tarField(meta.data, 0, meta.data.length));
    else if (meta.type === 'g') parsePax(meta.data, this.globalPax);
    else parsePax(meta.data, this.pax);
  }

  private header(): void {
    const block = this.head;
    if (isZeroBlock(block)) {
      this.zeroBlocks += 1;
      // Two empty blocks end the archive; whatever follows is padding.
      if (this.zeroBlocks >= 2) this.done = true;
      return;
    }
    this.zeroBlocks = 0;
    if (!tarChecksumOk(block)) {
      if (!this.sawHeader) throw new ArchiveError('invalid');
      this.done = true; // A damaged tail: keep what was read.
      return;
    }
    this.sawHeader = true;
    const type = block[156] === 0 ? '0' : String.fromCharCode(block[156] ?? 48);
    const headerSize = tarNumber(block, 124, 12);
    const padded = Math.ceil(headerSize / BLOCK) * BLOCK;

    if (type === 'L' || type === 'K' || type === 'x' || type === 'X' || type === 'g') {
      if (headerSize > MAX_TAR_METADATA) throw new ArchiveError('invalid');
      this.meta = { type, data: new Uint8Array(headerSize), fill: 0, pad: padded - headerSize };
      if (headerSize === 0) this.finishMeta();
      return;
    }

    const attributes = { ...this.globalPax, ...this.pax };
    const ustar = latin1(block.subarray(257, 262)) === 'ustar';
    const prefix = ustar ? decodeEntryName(tarField(block, 345, 155)) : '';
    const name = decodeEntryName(tarField(block, 0, 100));
    const path = attributes.path ?? this.longName ?? (prefix ? `${prefix}/${name}` : name);
    const link = attributes.linkpath ?? this.longLink ?? decodeEntryName(tarField(block, 157, 100));
    const size = attributes.size !== undefined && /^\d+$/.test(attributes.size) ? Number(attributes.size) : headerSize;
    const seconds = attributes.mtime !== undefined && /^-?\d+(\.\d+)?$/.test(attributes.mtime) ? Number(attributes.mtime) : tarNumber(block, 136, 12);
    this.longName = null;
    this.longLink = null;
    this.pax = {};
    if (!Number.isSafeInteger(size) || size < 0) throw new ArchiveError('invalid');

    const isFile = type === '0' || type === '7' || type === 'S';
    const isDir = type === '5';
    const isLink = type === '1' || type === '2';
    // Folders and links carry no bytes, whatever their size field says.
    this.skip = isDir || isLink ? 0 : Math.ceil(size / BLOCK) * BLOCK;
    if (!isFile && !isDir && !isLink) return; // Devices, pipes, volume labels: not listed.

    if (this.records.length >= this.maxEntries) {
      this.truncated = true;
      this.done = true;
      return;
    }
    this.records.push({ offset: this.position, size, readable: isFile });
    this.raw.push({
      rawPath: path,
      backslashes: false,
      kind: isDir ? 'dir' : isLink ? 'link' : 'file',
      size: isFile ? size : 0,
      packedSize: null,
      modified: seconds > 0 ? Math.round(seconds * 1000) : null,
      encrypted: false,
      linkTarget: isLink ? link : null,
    });
  }
}

function openTar(bytes: Uint8Array, maxEntries: number): OpenedArchive {
  const scanner = new TarScanner(maxEntries);
  scanner.push(bytes);
  if (scanner.records.length === 0 && !scanner.done) throw new ArchiveError('invalid');
  return {
    listing: buildListing('tar', scanner.raw, scanner.truncated),
    read(id, limit) {
      const record = scanner.records[id];
      if (!record || !record.readable) throw new ArchiveError('missing');
      if (record.size > limit) throw new ArchiveError('too-large');
      if (record.offset + record.size > bytes.length) throw new ArchiveError('invalid');
      return bytes.slice(record.offset, record.offset + record.size);
    },
  };
}

// ── gzip: a tar inside, or one file ─────────────────────────────────────────────────────────────

/** The original file name and time a gzip header may carry. */
function gzipHeader(bytes: Uint8Array): { name: string | null; modified: number | null } {
  if (bytes.length < 10) return { name: null, modified: null };
  const flags = bytes[3] ?? 0;
  const seconds = (bytes[4] ?? 0) | ((bytes[5] ?? 0) << 8) | ((bytes[6] ?? 0) << 16) | ((bytes[7] ?? 0) << 24);
  const modified = seconds > 0 ? seconds * 1000 : null;
  let at = 10;
  if (flags & 4) at += 2 + ((bytes[at] ?? 0) | ((bytes[at + 1] ?? 0) << 8));
  if (!(flags & 8) || at >= bytes.length) return { name: null, modified };
  let end = at;
  while (end < bytes.length && end - at < ARCHIVE_MAX_PATH && bytes[end] !== 0) end += 1;
  return { name: decodeEntryName(bytes.subarray(at, end)) || null, modified };
}

/** Collects the slice [start, start + size) of a gzip stream's output, then stops reading. */
function gunzipSlice(bytes: Uint8Array, start: number, size: number, budgetMs: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(size);
  let position = 0;
  let filled = 0;
  gunzipStream(bytes, Date.now() + budgetMs, (chunk) => {
    const from = Math.max(start, position);
    const to = Math.min(start + size, position + chunk.length);
    if (to > from) {
      out.set(chunk.subarray(from - position, to - position), from - start);
      filled += to - from;
    }
    position += chunk.length;
    return position < start + size;
  });
  if (filled < size) throw new ArchiveError('invalid');
  return out;
}

function openGzip(bytes: Uint8Array, fileName: string, maxEntries: number, budgetMs: number): OpenedArchive {
  const deadline = Date.now() + budgetMs;
  // The first block tells a tar from a single compressed file.
  const first = new Uint8Array(BLOCK);
  let firstFill = 0;
  gunzipStream(bytes, deadline, (chunk) => {
    const take = Math.min(BLOCK - firstFill, chunk.length);
    first.set(chunk.subarray(0, take), firstFill);
    firstFill += take;
    return firstFill < BLOCK;
  });

  if (firstFill === BLOCK && looksLikeTarHeader(first)) {
    const scanner = new TarScanner(maxEntries);
    let kept: Uint8Array[] | null = [];
    let total = 0;
    gunzipStream(bytes, deadline, (chunk) => {
      total += chunk.length;
      if (total > ARCHIVE_MAX_STREAM_BYTES) throw new ArchiveError('too-large');
      if (kept) {
        if (total > RETAIN_BYTES) kept = null;
        else kept.push(chunk);
      }
      scanner.push(chunk);
      return !scanner.done;
    });
    const tar = kept ? concat(kept, total) : null;
    return {
      listing: buildListing('tar.gz', scanner.raw, scanner.truncated),
      read(id, limit) {
        const record = scanner.records[id];
        if (!record || !record.readable) throw new ArchiveError('missing');
        if (record.size > limit) throw new ArchiveError('too-large');
        if (tar) {
          if (record.offset + record.size > tar.length) throw new ArchiveError('invalid');
          return tar.slice(record.offset, record.offset + record.size);
        }
        return gunzipSlice(bytes, record.offset, record.size, budgetMs);
      },
    };
  }

  // One compressed file. Its size is the gzip trailer's word for it (modulo 4 GB): shown, not trusted.
  const header = gzipHeader(bytes);
  const base = fileName.split(/[\\/]/).pop() ?? fileName;
  const inner = header.name ?? (base.replace(/\.gz$/i, '') || base);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = bytes.length >= 18 ? view.getUint32(bytes.length - 4, true) : 0;
  return {
    listing: buildListing(
      'gz',
      [
        {
          rawPath: inner.split(/[\\/]/).pop() ?? inner,
          backslashes: false,
          kind: 'file',
          size,
          packedSize: bytes.length,
          modified: header.modified,
          encrypted: false,
          linkTarget: null,
        },
      ],
      false,
    ),
    read(id, limit) {
      if (id !== 0) throw new ArchiveError('missing');
      const chunks: Uint8Array[] = [];
      let total = 0;
      gunzipStream(bytes, Date.now() + budgetMs, (chunk) => {
        total += chunk.length;
        if (total > limit) throw new ArchiveError('too-large');
        chunks.push(chunk);
        return true;
      });
      return concat(chunks, total);
    },
  };
}

// ── entry ───────────────────────────────────────────────────────────────────────────────────────

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  return signature.every((byte, index) => bytes[index] === byte);
}

/**
 * Opens an archive for listing. The bytes decide the format: a `.zip` that is really a tar still
 * opens, and anything that is neither zip, gzip nor tar throws `invalid`.
 */
export function openArchive(bytes: Uint8Array, fileName: string, options: OpenArchiveOptions = {}): OpenedArchive {
  const maxEntries = options.maxEntries ?? ARCHIVE_MAX_ENTRIES;
  const budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04]) || startsWith(bytes, [0x50, 0x4b, 0x05, 0x06]) || startsWith(bytes, [0x50, 0x4b, 0x07, 0x08])) {
    return openZip(bytes, maxEntries);
  }
  if (startsWith(bytes, [0x1f, 0x8b])) return openGzip(bytes, fileName, maxEntries, budgetMs);
  if (looksLikeTarHeader(bytes.subarray(0, BLOCK))) return openTar(bytes, maxEntries);
  // A self-extracting zip starts with a program; its directory is still at the end.
  if (options.hint === 'zip') return openZip(bytes, maxEntries);
  throw new ArchiveError('invalid');
}
