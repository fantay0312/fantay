// SPDX-License-Identifier: Apache-2.0
// Byte sniffing for design documents and cover PNGs (spec 06 §7.3). OpenPencil 0.16 writes `.fig` files as ZIP
// archives (`canvas.fig`, `thumbnail.png`, `meta.json`, `images/`); a bare kiwi canvas starts with `fig-kiwi`.
// ZSeven `.op` documents are JSON.
import JSZip from 'jszip';
import { DESIGN_COVER_MAX_BYTES, type DesignDocumentFormat } from '@open-design/contracts';

const ZIP_SIGNATURE = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const FIG_KIWI_PRELUDE = Buffer.from('fig-kiwi', 'ascii');
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

interface ZipEntryChunks {
  on(event: 'data', listener: (chunk: Buffer) => void): ZipEntryChunks;
  on(event: 'error', listener: (error: unknown) => void): ZipEntryChunks;
  on(event: 'end', listener: () => void): ZipEntryChunks;
  resume(): ZipEntryChunks;
  pause(): ZipEntryChunks;
}
type ZipEntryWithSize = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number };
  /** JSZip's StreamHelper of the entry (`ZipObject#internalStream`, what `async()` accumulates); not in its typings. */
  internalStream(type: 'nodebuffer'): ZipEntryChunks;
};

/**
 * Inflates one ZIP entry and gives up (`null`) as soon as it passes `maxBytes`. The size an archive declares is not
 * trusted: JSZip compares it only after inflating everything, so a crafted entry could inflate ~1000× its stored size.
 */
function inflateEntryWithin(entry: ZipEntryWithSize, maxBytes: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const stream = entry.internalStream('nodebuffer');
    stream
      .on('data', (chunk) => {
        if (settled) return;
        total += chunk.length;
        if (total > maxBytes) {
          settled = true;
          stream.pause();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      })
      .on('error', (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      })
      .on('end', () => {
        if (settled) return;
        settled = true;
        resolve(Buffer.concat(chunks, total));
      })
      .resume();
  });
}

function startsWith(bytes: Buffer, prefix: Buffer): boolean {
  return bytes.length >= prefix.length && bytes.subarray(0, prefix.length).equals(prefix);
}

/** fig: ZIP (`PK\x03\x04`) or `fig-kiwi` prefix; op: the first non-whitespace byte (after an optional BOM) is `{`. */
export function sniffDesignFormat(bytes: Buffer, expected: DesignDocumentFormat): boolean {
  if (expected === 'fig') return startsWith(bytes, ZIP_SIGNATURE) || startsWith(bytes, FIG_KIWI_PRELUDE);
  let index = startsWith(bytes, UTF8_BOM) ? UTF8_BOM.length : 0;
  for (; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) continue;
    return byte === 0x7b;
  }
  return false;
}

/** Width and height from the PNG signature and the IHDR chunk; `null` when the bytes are not a PNG. */
export function readPngSize(bytes: Buffer): { width: number; height: number } | null {
  if (bytes.length < 24 || !startsWith(bytes, PNG_SIGNATURE)) return null;
  if (bytes.readUInt32BE(8) !== 13 || bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (width === 0 || height === 0) return null;
  return { width, height };
}

/**
 * The `thumbnail.png` OpenPencil embeds in a `.fig` ZIP. `null` when the document is not a ZIP, has no thumbnail,
 * the thumbnail is not a PNG, larger than DESIGN_COVER_MAX_BYTES, or at most 1×1 (a placeholder).
 */
export async function extractFigThumbnail(bytes: Buffer): Promise<Buffer | null> {
  if (!startsWith(bytes, ZIP_SIGNATURE)) return null;
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entry = zip.file('thumbnail.png') as ZipEntryWithSize | null;
    if (!entry || entry.dir) return null;
    const declared = entry._data?.uncompressedSize;
    if (typeof declared === 'number' && declared > DESIGN_COVER_MAX_BYTES) return null;
    const png = await inflateEntryWithin(entry, DESIGN_COVER_MAX_BYTES);
    if (!png) return null;
    const size = readPngSize(png);
    if (!size || (size.width <= 1 && size.height <= 1)) return null;
    return png;
  } catch {
    return null;
  }
}
