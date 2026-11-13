// Synthetic design documents for the design-document tests: `.fig` files are ZIPs like OpenPencil 0.16 writes
// (`canvas.fig` with the `fig-kiwi` prelude, `thumbnail.png`, `meta.json`); `.op` files are JSON.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { constants as zlibConstants, deflateRawSync, deflateSync } from 'node:zlib';
import JSZip from 'jszip';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** A valid RGBA PNG of the given size, filled with one colour. */
export function makePng(width: number, height: number, rgba: [number, number, number, number] = [110, 86, 207, 255]): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const row = Buffer.alloc(1 + width * 4);
  for (let x = 0; x < width; x += 1) row.set(rgba, 1 + x * 4);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', header), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))]);
}

/** A `.fig` ZIP with `canvas.fig` (varied by `canvas`), an optional `thumbnail.png` and `meta.json`. */
export async function makeFig(options: { canvas?: string; thumbnail?: Buffer | null } = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('canvas.fig', Buffer.concat([Buffer.from('fig-kiwi', 'ascii'), Buffer.from(options.canvas ?? 'canvas-1')]));
  if (options.thumbnail !== null) zip.file('thumbnail.png', options.thumbnail ?? makePng(4, 4));
  zip.file('meta.json', JSON.stringify({ version: 1, name: options.canvas ?? 'canvas-1' }));
  return zip.generateAsync({ type: 'nodebuffer' });
}

/**
 * A crafted `.fig` ZIP whose only entry, `thumbnail.png`, inflates to `inflatedMiB` MiB of zeros while its headers
 * declare 1 KiB. The deflate stream is `inflatedMiB` sync-flushed 1 MiB segments plus an empty final block, so building
 * it never allocates the inflated size.
 */
export function makeFigWithOversizedThumbnail(inflatedMiB: number): Buffer {
  const segment = deflateRawSync(Buffer.alloc(1024 * 1024), { finishFlush: zlibConstants.Z_SYNC_FLUSH });
  const data = Buffer.concat([...Array.from({ length: inflatedMiB }, () => segment), Buffer.from([0x03, 0x00])]);
  const name = Buffer.from('thumbnail.png', 'ascii');
  const DECLARED_SIZE = 1024;
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt16LE(0x21, 12); // 1980-01-01
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(DECLARED_SIZE, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(8, 10); // deflate
  central.writeUInt16LE(0x21, 14);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(DECLARED_SIZE, 24);
  central.writeUInt16LE(name.length, 28);
  const centralOffset = local.length + name.length + data.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + name.length, 12);
  end.writeUInt32LE(centralOffset, 16);
  return Buffer.concat([local, name, data, central, name, end]);
}

/** A ZSeven `.op` (JSON) document. */
export function makeOp(label = 'op-1'): Buffer {
  return Buffer.from(`${JSON.stringify({ version: '1', name: label, children: [] })}\n`);
}

export interface TempRoots {
  root: string;
  projectsRoot: string;
  runtimeDataDir: string;
  cleanup(): Promise<void>;
}

export async function makeTempRoots(prefix = 'fantay-designs-'): Promise<TempRoots> {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  return {
    root,
    projectsRoot: path.join(root, 'projects'),
    runtimeDataDir: path.join(root, 'data'),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** Legacy design-canvas save input (CanvasStore.save / PUT /api/design-canvas/documents/:id). */
export function legacyInput(name: string, bytes: Buffer, format: 'fig' | 'op' = 'fig'): { name: string; format: 'fig' | 'op'; data: string; expected: null } {
  return { name, format, data: bytes.toString('base64'), expected: null };
}
