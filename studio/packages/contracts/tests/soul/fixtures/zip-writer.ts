// A test-only zip writer: stored and raw-deflate entries, plus knobs to corrupt any header field.
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import { crc32 } from '../../../src/soul/index';

export interface TestEntry {
  name: string;
  data: Uint8Array | string;
  method?: 0 | 8;            // how the data is written (default 0)
  methodField?: number;      // the method number written in both headers (default: method)
  flags?: number;
  crc?: number;
  size?: number;             // central-directory uncompressed size
  compressedSize?: number;   // central-directory compressed size
  offset?: number;           // central-directory local header offset
  diskStart?: number;
}
export interface ZipOptions { prefix?: number; comment?: string; count?: number; cdOffset?: number; truncateCentral?: number }

const bytesOf = (data: Uint8Array | string): Uint8Array => (typeof data === 'string' ? new TextEncoder().encode(data) : data);

export const inflate = (data: Uint8Array, max: number): Uint8Array => inflateRawSync(data, { maxOutputLength: max + 1 });

export function zip(entries: readonly TestEntry[], options: ZipOptions = {}): Uint8Array {
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = bytesOf(entry.data);
    const stored = entry.method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = new TextEncoder().encode(entry.name);
    const method = entry.methodField ?? entry.method ?? 0;
    const crc = entry.crc ?? crc32(raw);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(4, 20, true);
    lv.setUint16(6, entry.flags ?? 0, true);
    lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true);
    lv.setUint32(18, stored.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, name.length, true);
    local.set(name, 30);
    const record = new Uint8Array(46 + name.length);
    const cv = new DataView(record.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, entry.flags ?? 0, true);
    cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, entry.compressedSize ?? stored.length, true);
    cv.setUint32(24, entry.size ?? raw.length, true);
    cv.setUint16(28, name.length, true);
    cv.setUint16(34, entry.diskStart ?? 0, true);
    cv.setUint32(42, entry.offset ?? offset, true);
    record.set(name, 46);
    parts.push(local, stored);
    central.push(record);
    offset += local.length + stored.length;
  }
  let cd = concat(central);
  if (options.truncateCentral !== undefined) cd = cd.subarray(0, options.truncateCentral);
  const comment = new TextEncoder().encode(options.comment ?? '');
  const eocd = new Uint8Array(22 + comment.length);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, options.count ?? entries.length, true);
  ev.setUint16(10, options.count ?? entries.length, true);
  ev.setUint32(12, cd.length, true);
  ev.setUint32(16, options.cdOffset ?? offset, true);
  ev.setUint16(20, comment.length, true);
  eocd.set(comment, 22);
  const prefix = new Uint8Array(options.prefix ?? 0).fill(0x5a);
  return concat([prefix, ...parts, cd, eocd]);
}

export function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** A valid 1×1 PNG, a JPEG and a WebP header: enough for magic-byte sniffing. */
export const PNG_BYTES = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AAAAAAAABQABZHiVOAAAAABJRU5ErkJggg==', 'base64',
));
export const JPEG_BYTES = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00]);
export const WEBP_BYTES = new TextEncoder().encode('RIFF\u0000\u0000\u0000\u0000WEBPVP8 ');
