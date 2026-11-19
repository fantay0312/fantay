// SPDX-License-Identifier: Apache-2.0
// Card chunks in PNG files without an image library: scan chunks, read a card, strip metadata, embed a card, and a
// 1×1 placeholder image. Base64 is decoded straight from the chunk bytes; no large intermediate strings.
import { isRecord } from "./coerce.js";
import { SOUL_LIMITS } from "./limits.js";

export type PngScan =
  | { ok: false; error: "not-png" | "corrupt" }
  | { ok: true; chunks: Array<{ type: string; start: number; dataStart: number; dataEnd: number }>; end: number };

type PngChunk = Extract<PngScan, { ok: true }>["chunks"][number];
type CardKeyword = "ccv3" | "chara";
type ExtractResult =
  | { ok: true; json: unknown; keyword: CardKeyword }
  | { ok: false; error: "not-png" | "no-card" | "too-large" | "bad-base64" | "bad-json" };

const SIGNATURE: readonly number[] = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const IMAGE_CHUNKS: ReadonlySet<string> = new Set([
  "IHDR", "PLTE", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "pHYs", "acTL", "fcTL", "fdAT", "IDAT", "IEND",
]);
const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const PAD = -2;
const SPACE = -3;
/** 256-entry decode table: 0–63 for alphabet bytes, PAD for '=', SPACE for whitespace, -1 for anything else. */
const BASE64_DECODE: Int8Array = (() => {
  const table = new Int8Array(256).fill(-1);
  for (let index = 0; index < BASE64_ALPHABET.length; index += 1) table[BASE64_ALPHABET.charCodeAt(index)] = index;
  table[0x3d] = PAD;
  for (const code of [0x09, 0x0a, 0x0c, 0x0d, 0x20]) table[code] = SPACE;
  return table;
})();

let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable !== null) return crcTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let bit = 0; bit < 8; bit += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTable = table;
  return table;
}

function crcRange(bytes: Uint8Array, start: number, end: number): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) crc = (table[(crc ^ (bytes[index] ?? 0)) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** CRC-32 with polynomial 0xEDB88320; unsigned. */
export function crc32(bytes: Uint8Array): number {
  return crcRange(bytes, 0, bytes.length);
}

const byteAt = (bytes: Uint8Array, index: number): number => bytes[index] ?? 0;

function readU32(bytes: Uint8Array, offset: number): number {
  return ((byteAt(bytes, offset) << 24) | (byteAt(bytes, offset + 1) << 16) | (byteAt(bytes, offset + 2) << 8)
    | byteAt(bytes, offset + 3)) >>> 0;
}

function writeU32(out: Uint8Array, offset: number, value: number): void {
  const v = value >>> 0;
  out[offset] = v >>> 24;
  out[offset + 1] = (v >>> 16) & 0xff;
  out[offset + 2] = (v >>> 8) & 0xff;
  out[offset + 3] = v & 0xff;
}

export function scanPng(bytes: Uint8Array): PngScan {
  if (!(bytes instanceof Uint8Array) || bytes.length < SIGNATURE.length) return { ok: false, error: "not-png" };
  for (let index = 0; index < SIGNATURE.length; index += 1) {
    if (bytes[index] !== SIGNATURE[index]) return { ok: false, error: "not-png" };
  }
  const chunks: PngChunk[] = [];
  let offset = SIGNATURE.length;
  while (chunks.length < SOUL_LIMITS.pngChunks) {
    if (offset + 12 > bytes.length) return { ok: false, error: "corrupt" };
    const length = readU32(bytes, offset);
    if (length > bytes.length - offset - 12) return { ok: false, error: "corrupt" };
    const type = String.fromCharCode(byteAt(bytes, offset + 4), byteAt(bytes, offset + 5), byteAt(bytes, offset + 6), byteAt(bytes, offset + 7));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    chunks.push({ type, start: offset, dataStart, dataEnd });
    offset = dataEnd + 4;
    if (type === "IEND") return { ok: true, chunks, end: offset };
  }
  return { ok: false, error: "corrupt" };
}

/** The lower-cased keyword of a tEXt chunk (bytes before the first NUL, 1–79 of them) and where its text starts. */
function textKeyword(bytes: Uint8Array, chunk: PngChunk): { keyword: string; valueStart: number } | null {
  const limit = Math.min(chunk.dataEnd, chunk.dataStart + 80);
  for (let index = chunk.dataStart; index < limit; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index === chunk.dataStart) return null;
    let keyword = "";
    for (let at = chunk.dataStart; at < index; at += 1) keyword += String.fromCharCode(byteAt(bytes, at));
    return { keyword: keyword.toLowerCase(), valueStart: index + 1 };
  }
  return null;
}

/** Base64 decoder over any code-unit source: skips whitespace, stops at '=', null on any other foreign unit. */
function decodeBase64(read: (index: number) => number, start: number, end: number): Uint8Array | null {
  const out = new Uint8Array(Math.floor(((end - start) * 3) / 4) + 3);
  let length = 0;
  let buffer = 0;
  let bits = 0;
  for (let index = start; index < end; index += 1) {
    const code = read(index);
    const value = code >= 0 && code < 256 ? (BASE64_DECODE[code] ?? -1) : -1;
    if (value === SPACE) continue;
    if (value === PAD) break;
    if (value < 0) return null;
    buffer = ((buffer << 6) | value) & 0xffffff;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[length] = (buffer >>> bits) & 0xff;
      length += 1;
    }
  }
  return out.subarray(0, length);
}

function decodeCard(bytes: Uint8Array, start: number, end: number, keyword: CardKeyword): ExtractResult {
  if (end - start > SOUL_LIMITS.pngCardBase64) return { ok: false, error: "too-large" };
  const decoded = decodeBase64(index => byteAt(bytes, index), start, end);
  if (decoded === null) return { ok: false, error: "bad-base64" };
  const text = new TextDecoder("utf-8").decode(decoded);
  try {
    return { ok: true, json: JSON.parse(text) as unknown, keyword };
  } catch {
    return { ok: false, error: "bad-json" };
  }
}

/** The card JSON of a PNG: `ccv3` preferred over `chara`; the first chunk of each keyword wins. */
export function extractCardJson(bytes: Uint8Array): ExtractResult {
  const scan = scanPng(bytes);
  if (!scan.ok) return { ok: false, error: "not-png" };
  let ccv3: { start: number; end: number } | null = null;
  let chara: { start: number; end: number } | null = null;
  for (const chunk of scan.chunks) {
    if (chunk.type !== "tEXt") continue;
    const text = textKeyword(bytes, chunk);
    if (text === null) continue;
    if (text.keyword === "ccv3" && ccv3 === null) ccv3 = { start: text.valueStart, end: chunk.dataEnd };
    else if (text.keyword === "chara" && chara === null) chara = { start: text.valueStart, end: chunk.dataEnd };
  }
  const preferred = ccv3 !== null ? decodeCard(bytes, ccv3.start, ccv3.end, "ccv3") : null;
  if (preferred?.ok === true) return preferred;
  const fallback = chara !== null ? decodeCard(bytes, chara.start, chara.end, "chara") : null;
  if (fallback?.ok === true) return fallback;
  return preferred ?? fallback ?? { ok: false, error: "no-card" };
}

function copyChunk(out: Uint8Array, offset: number, bytes: Uint8Array, chunk: PngChunk): number {
  const end = chunk.dataEnd + 4;
  out.set(bytes.subarray(chunk.start, end), offset);
  return offset + (end - chunk.start);
}

function writeChunk(out: Uint8Array, offset: number, type: string, data: Uint8Array): number {
  writeU32(out, offset, data.length);
  for (let index = 0; index < 4; index += 1) out[offset + 4 + index] = type.charCodeAt(index) & 0xff;
  out.set(data, offset + 8);
  writeU32(out, offset + 8 + data.length, crcRange(out, offset + 4, offset + 8 + data.length));
  return offset + 12 + data.length;
}

function writeSignature(out: Uint8Array): number {
  out.set(SIGNATURE, 0);
  return SIGNATURE.length;
}

const chunkSize = (chunk: PngChunk): number => chunk.dataEnd + 4 - chunk.start;

/** Keeps image chunks only: drops text, EXIF and trailing bytes. Returns the input unchanged when it is not a PNG. */
export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  const scan = scanPng(bytes);
  if (!scan.ok) return bytes;
  const kept = scan.chunks.filter(chunk => IMAGE_CHUNKS.has(chunk.type));
  const out = new Uint8Array(SIGNATURE.length + kept.reduce((sum, chunk) => sum + chunkSize(chunk), 0));
  let offset = writeSignature(out);
  for (const chunk of kept) offset = copyChunk(out, offset, bytes, chunk);
  return out;
}

function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let index = 0; index < text.length; index += 1) out[index] = text.charCodeAt(index) & 0xff;
  return out;
}

function textChunkData(keyword: string, json: unknown): Uint8Array {
  const value = bytesToBase64(new TextEncoder().encode(JSON.stringify(json)));
  const out = new Uint8Array(keyword.length + 1 + value.length);
  out.set(asciiBytes(keyword), 0);
  out[keyword.length] = 0;
  for (let index = 0; index < value.length; index += 1) out[keyword.length + 1 + index] = value.charCodeAt(index);
  return out;
}

function isCardChunk(bytes: Uint8Array, chunk: PngChunk): boolean {
  if (chunk.type !== "tEXt") return false;
  const text = textKeyword(bytes, chunk);
  return text !== null && (text.keyword === "chara" || text.keyword === "ccv3" || text.keyword.startsWith("chara-ext-asset_"));
}

const textOf = (value: unknown): string => (typeof value === "string" ? value : "");

/** Embeds a V3 card. Throws only when `bytes` is not a PNG (callers check with scanPng or use the placeholder). */
export function embedCard(bytes: Uint8Array, v3Card: Record<string, unknown>): Uint8Array {
  const scan = scanPng(bytes);
  if (!scan.ok) throw new Error(`embedCard: the image is not a readable PNG (${scan.error})`);
  const data = isRecord(v3Card.data) ? v3Card.data : {};
  const v2Card = {
    spec: "chara_card_v2",
    spec_version: "2.0",
    data,
    name: textOf(data.name),
    description: textOf(data.description),
    personality: textOf(data.personality),
    scenario: textOf(data.scenario),
    first_mes: textOf(data.first_mes),
    mes_example: textOf(data.mes_example),
  };
  const ccv3 = textChunkData("ccv3", v3Card);
  const chara = textChunkData("chara", v2Card);
  const kept = scan.chunks.filter(chunk => chunk.type !== "IEND" && !isCardChunk(bytes, chunk));
  const iend = scan.chunks[scan.chunks.length - 1];
  const total = SIGNATURE.length + kept.reduce((sum, chunk) => sum + chunkSize(chunk), 0) + 12 + ccv3.length + 12 + chara.length + 12;
  const out = new Uint8Array(total);
  let offset = writeSignature(out);
  for (const chunk of kept) offset = copyChunk(out, offset, bytes, chunk);
  offset = writeChunk(out, offset, "tEXt", ccv3);
  offset = writeChunk(out, offset, "tEXt", chara);
  if (iend !== undefined && iend.type === "IEND" && iend.dataEnd === iend.dataStart) copyChunk(out, offset, bytes, iend);
  else writeChunk(out, offset, "IEND", new Uint8Array(0));
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  const parts: string[] = [];
  let chunk = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const a = byteAt(bytes, index);
    const b = bytes[index + 1];
    const c = bytes[index + 2];
    const n = (a << 16) | ((b ?? 0) << 8) | (c ?? 0);
    chunk += BASE64_ALPHABET.charAt((n >>> 18) & 63) + BASE64_ALPHABET.charAt((n >>> 12) & 63)
      + (b === undefined ? "=" : BASE64_ALPHABET.charAt((n >>> 6) & 63))
      + (c === undefined ? "=" : BASE64_ALPHABET.charAt(n & 63));
    if (chunk.length >= 16384) {
      parts.push(chunk);
      chunk = "";
    }
  }
  parts.push(chunk);
  return parts.join("");
}

/** Null on an invalid character; whitespace is skipped and decoding stops at '='. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (typeof text !== "string") return null;
  const decoded = decodeBase64(index => text.charCodeAt(index), 0, text.length);
  return decoded === null ? null : decoded.slice();
}

function buildPng(chunks: ReadonlyArray<readonly [string, Uint8Array]>): Uint8Array {
  const out = new Uint8Array(SIGNATURE.length + chunks.reduce((sum, [, data]) => sum + 12 + data.length, 0));
  let offset = writeSignature(out);
  for (const [type, data] of chunks) offset = writeChunk(out, offset, type, data);
  return out;
}

/** A valid 1×1 fully transparent RGBA PNG (IDAT is one stored deflate block holding the 5-byte scanline). */
export const PA_PLACEHOLDER_PNG: Uint8Array = buildPng([
  ["IHDR", Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0)],
  ["IDAT", Uint8Array.of(0x78, 0x01, 0x01, 0x05, 0x00, 0xfa, 0xff, 0, 0, 0, 0, 0, 0x00, 0x05, 0x00, 0x01)],
  ["IEND", new Uint8Array(0)],
]);
