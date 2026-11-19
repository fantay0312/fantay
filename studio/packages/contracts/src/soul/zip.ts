// SPDX-License-Identifier: Apache-2.0
// A small zip reader and writer for card archives. Reading: the central directory is read with hard limits, entries
// are read one at a time through an injected raw-DEFLATE function that must stop at a byte cap, and every archive name
// is checked so that none can look like a path. Writing (`buildZip`): bytes in memory, every entry stored as is.
// Nothing here touches a file system; nothing is ever stored under an entry name.
import { SOUL_LIMITS } from "./limits.js";
import { crc32 } from "./png.js";

/** Raw DEFLATE. Must not produce more than `maxOutput + 1` bytes; may throw. */
export type ZipInflate = (data: Uint8Array, maxOutput: number) => Promise<Uint8Array> | Uint8Array;
export interface ZipEntry { name: string; method: number; compressedSize: number; size: number; crc: number; offset: number; directory: boolean }
export type ZipSkipReason = "unsafe-name" | "duplicate" | "encrypted" | "method" | "zip64";
export type ZipIndex =
  | { ok: false; error: "not-zip" | "corrupt" | "too-large" | "too-many" | "zip64" }
  | { ok: true; base: number; dataEnd: number; entries: ZipEntry[]; skipped: Array<{ name: string; reason: ZipSkipReason }> };
export type ZipRead = { ok: true; data: Uint8Array } | { ok: false; error: "corrupt" | "too-large" | "crc" | "inflate" };

const EOCD_SIZE = 22;
const MAX_COMMENT = 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

// Bounds-checked little-endian reads: 0 outside the buffer; callers check the record bounds and answer `corrupt`.
const byteAt = (bytes: Uint8Array, at: number): number => (at >= 0 && at < bytes.length ? bytes[at] ?? 0 : 0);
const u16 = (bytes: Uint8Array, at: number): number => byteAt(bytes, at) | (byteAt(bytes, at + 1) << 8);
const u32 = (bytes: Uint8Array, at: number): number => (u16(bytes, at) | (u16(bytes, at + 2) << 16)) >>> 0;
const signature = (bytes: Uint8Array, at: number, third: number, fourth: number): boolean =>
  at >= 0 && at + 4 <= bytes.length && bytes[at] === 0x50 && bytes[at + 1] === 0x4b && bytes[at + 2] === third
  && bytes[at + 3] === fourth;

const utf8Length = (text: string): number => new TextEncoder().encode(text).length;

/** The position of the end-of-central-directory record, or -1. */
function findEocd(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length < EOCD_SIZE) return -1;
  const last = bytes.length - EOCD_SIZE;
  const first = Math.max(0, last - MAX_COMMENT);
  for (let at = last; at >= first; at -= 1) {
    if (!signature(bytes, at, 0x05, 0x06)) continue;
    if (at + EOCD_SIZE + u16(bytes, at + 20) <= bytes.length) return at;
  }
  return -1;
}

/** An end-of-central-directory record is found. */
export function isZipLike(bytes: Uint8Array): boolean {
  return findEocd(bytes) >= 0;
}

/**
 * The name unchanged, or null when it is empty, longer than `maxBytes` in UTF-8, holds a NUL or a backslash, is
 * absolute (`/x`, `C:x`), or has a `.` or `..` segment. No archive name can shadow `card.json` or name another path.
 */
export function safeZipName(name: string, maxBytes: number = SOUL_LIMITS.charxNameBytes): string | null {
  if (typeof name !== "string" || name === "") return null;
  if (utf8Length(name) > maxBytes) return null;
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) return null;
  const body = name.endsWith("/") ? name.slice(0, -1) : name;
  if (body.split("/").some(segment => segment === "." || segment === "..")) return null;
  return name;
}

export function readZipIndex(
  bytes: Uint8Array,
  limits: { maxBytes?: number; maxEntries?: number; maxNameBytes?: number } = {},
): ZipIndex {
  const maxBytes = limits.maxBytes ?? SOUL_LIMITS.charxBytes;
  const maxEntries = limits.maxEntries ?? SOUL_LIMITS.charxEntries;
  const maxNameBytes = limits.maxNameBytes ?? SOUL_LIMITS.charxNameBytes;
  if (!(bytes instanceof Uint8Array)) return { ok: false, error: "not-zip" };
  if (bytes.length > maxBytes) return { ok: false, error: "too-large" };
  if (bytes.length < EOCD_SIZE) return { ok: false, error: "not-zip" };
  const p = findEocd(bytes);
  if (p < 0) return { ok: false, error: "not-zip" };

  const count = u16(bytes, p + 10);
  const cdSize = u32(bytes, p + 12);
  const cdOffset = u32(bytes, p + 16);
  if (count === U16_MAX || u16(bytes, p + 8) === U16_MAX || cdSize === U32_MAX || cdOffset === U32_MAX) {
    return { ok: false, error: "zip64" };
  }
  if (u16(bytes, p + 4) !== 0 || u16(bytes, p + 6) !== 0 || u16(bytes, p + 8) !== count) return { ok: false, error: "corrupt" };
  if (count > maxEntries) return { ok: false, error: "too-many" };
  const base = p - cdSize - cdOffset;
  if (base < 0) return { ok: false, error: "corrupt" };
  const dataEnd = base + cdOffset;

  const decoder = new TextDecoder("utf-8");
  const entries: ZipEntry[] = [];
  const skipped: Array<{ name: string; reason: ZipSkipReason }> = [];
  const seen = new Set<string>();
  let at = dataEnd;
  for (let record = 0; record < count; record += 1) {
    if (at + CENTRAL_SIZE > p || !signature(bytes, at, 0x01, 0x02)) return { ok: false, error: "corrupt" };
    const flags = u16(bytes, at + 8);
    const method = u16(bytes, at + 10);
    const crc = u32(bytes, at + 16);
    const compressedSize = u32(bytes, at + 20);
    const size = u32(bytes, at + 24);
    const nameLength = u16(bytes, at + 28);
    const extraLength = u16(bytes, at + 30);
    const commentLength = u16(bytes, at + 32);
    const diskStart = u16(bytes, at + 34);
    const offset = u32(bytes, at + 42);
    const end = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (end > p) return { ok: false, error: "corrupt" };
    if (diskStart !== 0 && diskStart !== U16_MAX) return { ok: false, error: "corrupt" };
    const raw = decoder.decode(bytes.subarray(at + CENTRAL_SIZE, at + CENTRAL_SIZE + nameLength));
    at = end;

    const name = safeZipName(raw, maxNameBytes);
    if (name === null) {
      skipped.push({ name: raw.slice(0, maxNameBytes), reason: "unsafe-name" });
      continue;
    }
    const duplicate = seen.has(name);
    seen.add(name);
    if (compressedSize === U32_MAX || size === U32_MAX || offset === U32_MAX || diskStart === U16_MAX) {
      skipped.push({ name, reason: "zip64" });
    } else if ((flags & 1) !== 0) {
      skipped.push({ name, reason: "encrypted" });
    } else if (method !== 0 && method !== 8) {
      skipped.push({ name, reason: "method" });
    } else if (duplicate) {
      skipped.push({ name, reason: "duplicate" });
    } else {
      entries.push({ name, method, compressedSize, size, crc, offset, directory: name.endsWith("/") });
    }
  }
  return { ok: true, base, dataEnd, entries, skipped };
}

export async function readZipEntry(
  bytes: Uint8Array,
  index: Extract<ZipIndex, { ok: true }>,
  entry: ZipEntry,
  inflate: ZipInflate,
  maxOutput: number,
): Promise<ZipRead> {
  if (entry.directory) return { ok: false, error: "corrupt" };
  const header = index.base + entry.offset;
  if (header + LOCAL_SIZE > index.dataEnd || !signature(bytes, header, 0x03, 0x04)) return { ok: false, error: "corrupt" };
  const start = header + LOCAL_SIZE + u16(bytes, header + 26) + u16(bytes, header + 28);
  const end = start + entry.compressedSize;
  if (end > index.dataEnd || end > bytes.length) return { ok: false, error: "corrupt" };
  if (entry.size > maxOutput) return { ok: false, error: "too-large" };

  let data: Uint8Array;
  if (entry.method === 0) {
    if (entry.compressedSize > maxOutput) return { ok: false, error: "too-large" };
    data = bytes.slice(start, end);
  } else if (entry.method === 8) {
    let out: unknown;
    try {
      out = await inflate(bytes.subarray(start, end), maxOutput);
    } catch {
      return { ok: false, error: "inflate" };
    }
    if (!(out instanceof Uint8Array)) return { ok: false, error: "inflate" };
    if (out.length > maxOutput) return { ok: false, error: "too-large" };
    data = out;
  } else {
    return { ok: false, error: "corrupt" };
  }
  if (entry.size !== 0 && data.length !== entry.size) return { ok: false, error: "corrupt" };
  if (crc32(data) !== entry.crc) return { ok: false, error: "crc" };
  return { ok: true, data };
}

/**
 * A zip of `entries`, each stored as is (no compression: the images of a card archive are compressed already and
 * `card.json` is small). Names are UTF-8 and must pass `safeZipName`; an unsafe or repeated name, or an archive over
 * the 4 GB zip limit, throws. Dates are fixed (1980-01-01), so the same input gives the same bytes.
 */
export function buildZip(entries: ReadonlyArray<{ name: string; data: Uint8Array }>): Uint8Array {
  if (entries.length >= U16_MAX) throw new Error("zip-too-many");
  const encoder = new TextEncoder();
  const seen = new Set<string>();
  const files = entries.map(entry => {
    if (safeZipName(entry.name) === null || entry.name.endsWith("/") || seen.has(entry.name)) throw new Error("zip-bad-name");
    seen.add(entry.name);
    return { name: encoder.encode(entry.name), data: entry.data, crc: crc32(entry.data) };
  });
  const dataSize = files.reduce((sum, file) => sum + LOCAL_SIZE + file.name.length + file.data.length, 0);
  const directorySize = files.reduce((sum, file) => sum + CENTRAL_SIZE + file.name.length, 0);
  if (dataSize + directorySize + EOCD_SIZE >= U32_MAX) throw new Error("zip-too-large");

  const out = new Uint8Array(dataSize + directorySize + EOCD_SIZE);
  const put16 = (at: number, value: number) => { out[at] = value & 0xff; out[at + 1] = (value >>> 8) & 0xff; };
  const put32 = (at: number, value: number) => { put16(at, value & 0xffff); put16(at + 2, (value >>> 16) & 0xffff); };
  // Shared by a local header (at +4) and a central record (at +6): version needed, UTF-8 names, stored, date, sizes.
  const describe = (at: number, file: (typeof files)[number]) => {
    put16(at, 20);
    put16(at + 2, 0x0800);
    put16(at + 4, 0);
    put16(at + 6, 0);
    put16(at + 8, 0x0021);
    put32(at + 10, file.crc);
    put32(at + 14, file.data.length);
    put32(at + 18, file.data.length);
    put16(at + 22, file.name.length);
  };
  const offsets: number[] = [];
  let at = 0;
  for (const file of files) {
    offsets.push(at);
    put32(at, 0x04034b50);
    describe(at + 4, file);
    out.set(file.name, at + LOCAL_SIZE);
    out.set(file.data, at + LOCAL_SIZE + file.name.length);
    at += LOCAL_SIZE + file.name.length + file.data.length;
  }
  files.forEach((file, index) => {
    put32(at, 0x02014b50);
    put16(at + 4, 20);
    describe(at + 6, file);
    put32(at + 42, offsets[index] ?? 0);
    out.set(file.name, at + CENTRAL_SIZE);
    at += CENTRAL_SIZE + file.name.length;
  });
  put32(at, 0x06054b50);
  put16(at + 8, files.length);
  put16(at + 10, files.length);
  put32(at + 12, directorySize);
  put32(at + 16, dataSize);
  return out;
}
