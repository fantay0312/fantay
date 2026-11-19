// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code packages/shared/src/imageDimensions.ts and
// apps/web/src/components/files/extendedDocumentPreview.ts (`imageFits`, `imageData`) @ c5e6b24f
// (MIT): reading a bitmap's size from its header, and carrying a small picture as a data address.
// Changed here: the EXIF rotation check is dropped (only the pixel count matters here), BMP is not
// accepted, and base64 is produced without a ZIP library.
//
// A picture embedded in a document is untrusted: a few kilobytes can declare a canvas of billions of
// pixels. Only pictures whose header states a sane size are passed on to the browser.

const MAX_IMAGE_BYTES = 6 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 16_777_216;

export interface ImageSize {
  width: number;
  height: number;
}

const MIME_BY_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

export function bitmapMime(path: string): string | null {
  return MIME_BY_EXTENSION[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

function view(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function readPng(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return null;
  if (bytes[12] !== 0x49 || bytes[13] !== 0x48 || bytes[14] !== 0x44 || bytes[15] !== 0x52) return null;
  const data = view(bytes);
  return { width: data.getUint32(16), height: data.getUint32(20) };
}

function readGif(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 10 || bytes[0] !== 0x47 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x38) return null;
  const data = view(bytes);
  return { width: data.getUint16(6, true), height: data.getUint16(8, true) };
}

function readWebp(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 16 || bytes[0] !== 0x52 || bytes[1] !== 0x49 || bytes[2] !== 0x46 || bytes[3] !== 0x46) return null;
  if (bytes[8] !== 0x57 || bytes[9] !== 0x45 || bytes[10] !== 0x42 || bytes[11] !== 0x50) return null;
  const data = view(bytes);
  const chunk = String.fromCharCode(bytes[12] ?? 0, bytes[13] ?? 0, bytes[14] ?? 0, bytes[15] ?? 0);
  if (chunk === 'VP8 ') {
    if (bytes.length < 30) return null;
    return { width: data.getUint16(26, true) & 0x3fff, height: data.getUint16(28, true) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (bytes.length < 25) return null;
    const packed = data.getUint32(21, true);
    return { width: (packed & 0x3fff) + 1, height: ((packed >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') {
    if (bytes.length < 30) return null;
    return {
      width: ((bytes[24] ?? 0) | ((bytes[25] ?? 0) << 8) | ((bytes[26] ?? 0) << 16)) + 1,
      height: ((bytes[27] ?? 0) | ((bytes[28] ?? 0) << 8) | ((bytes[29] ?? 0) << 16)) + 1,
    };
  }
  return null;
}

function readJpeg(bytes: Uint8Array): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const data = view(bytes);
  let offset = 2;
  while (offset + 9 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null;
    const marker = bytes[offset + 1] ?? 0;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Frame headers, without the arithmetic-coding and Huffman-table markers in the same range.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { width: data.getUint16(offset + 7), height: data.getUint16(offset + 5) };
    }
    if (marker === 0xd9 || marker === 0xda) return null;
    // TEM and the restart markers stand alone, with no length field.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    offset += 2 + data.getUint16(offset + 2);
  }
  return null;
}

/** The size a PNG, GIF, WebP or JPEG header declares, or null when it is none of them. */
export function readImageSize(bytes: Uint8Array): ImageSize | null {
  const size = readPng(bytes) ?? readGif(bytes) ?? readWebp(bytes) ?? readJpeg(bytes);
  return size && size.width > 0 && size.height > 0 ? size : null;
}

/** True when the bytes are a bitmap small enough, in bytes and in pixels, to hand to the browser. */
export function imageFits(bytes: Uint8Array, maxBytes = MAX_IMAGE_BYTES, maxPixels = MAX_IMAGE_PIXELS): boolean {
  if (bytes.length > maxBytes) return false;
  const size = readImageSize(bytes);
  return size !== null && size.width <= maxPixels / size.height;
}

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

/** A `data:` address for a picture that passed `imageFits`, or null. */
export function imageDataAddress(path: string, bytes: Uint8Array | null): string | null {
  const mime = bitmapMime(path);
  if (!mime || !bytes || !imageFits(bytes)) return null;
  return `data:${mime};base64,${toBase64(bytes)}`;
}
