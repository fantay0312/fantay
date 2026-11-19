// SPDX-License-Identifier: AGPL-3.0-only
// Adapted from t3code apps/web/src/components/files/imageDecode.worker.ts @ c5e6b24f (MIT): the
// bounded HEIF and TIFF decoders. The file is untrusted, so its metadata is checked (box and tag
// counts, dimensions, strip sizes, LZW and deflate output) before a decoder is allowed to allocate.
// Changed here: PSD is added (the flattened composite, through ag-psd, without a DOM canvas), the
// format is named instead of a boolean, and failures come back as codes the viewer words itself.
/// <reference lib="webworker" />

const MAX_PIXELS = 32_000_000;
const MAX_SIDE = 16_384;
const MAX_BYTES = 80 * 1024 * 1024;

export type ImageDecodeFormat = 'heic' | 'tiff' | 'psd';
export type ImageDecodeFailure = 'too-large' | 'unsupported' | 'invalid';
export type ImageDecodeRequest = { bytes: ArrayBuffer; format: ImageDecodeFormat };
export type ImageDecodeResponse = { blob: Blob } | { error: ImageDecodeFailure };

class DecodeError extends Error {
  constructor(readonly code: ImageDecodeFailure) {
    super(code);
  }
}

function checkDimensions(width: number, height: number): void {
  if (!(width > 0 && height > 0)) throw new DecodeError('invalid');
  if (width > MAX_SIDE || height > MAX_SIDE || width > MAX_PIXELS / height) throw new DecodeError('too-large');
}

function validateTiffMetadata(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  if (bytes.byteLength < 8) throw new DecodeError('invalid');
  const order = view.getUint16(0);
  const littleEndian = order === 0x4949;
  if (![0x4949, 0x4d4d].includes(order) || view.getUint16(2, littleEndian) !== 42) throw new DecodeError('invalid');
  const visited = new Set<number>();
  let entries = 0;
  let allocation = 0;
  const inspect = (offset: number, depth: number): void => {
    if (depth > 8 || visited.has(offset) || offset < 8 || offset + 2 > bytes.byteLength) throw new DecodeError('invalid');
    visited.add(offset);
    const count = view.getUint16(offset, littleEndian);
    entries += count;
    if (entries > 2048 || offset + 2 + count * 12 + 4 > bytes.byteLength) throw new DecodeError('invalid');
    for (let index = 0; index < count; index += 1) {
      const entry = offset + 2 + index * 12;
      const tag = view.getUint16(entry, littleEndian);
      const type = view.getUint16(entry + 2, littleEndian);
      const values = view.getUint32(entry + 4, littleEndian);
      const width = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8][type];
      if (!width) throw new DecodeError('unsupported');
      const length = values * width;
      const start = length > 4 ? view.getUint32(entry + 8, littleEndian) : entry + 8;
      // The decoder keeps a separate array or string for every tag, aliases included.
      allocation += values * Math.max(16, width);
      if (start + length > bytes.byteLength || allocation > 8 * 1024 * 1024) throw new DecodeError('invalid');
      if (tag === 0x8769 || tag === 0x8825) {
        if (type !== 4 || values !== 1) throw new DecodeError('invalid');
        inspect(view.getUint32(entry + 8, littleEndian), depth + 1);
      }
    }
  };
  inspect(view.getUint32(4, littleEndian), 0);
}

function validateHeif(bytes: ArrayBuffer): void {
  const view = new DataView(bytes);
  let found = false;
  let count = 0;
  const boxes = (start: number, end: number, depth: number): void => {
    if (depth > 4) return;
    let offset = start;
    while (offset + 8 <= end) {
      count += 1;
      if (count > 2048) throw new DecodeError('invalid');
      let size = view.getUint32(offset);
      let header = 8;
      if (size === 1) {
        if (offset + 16 > end) throw new DecodeError('invalid');
        const large = view.getBigUint64(offset + 8);
        if (large > BigInt(bytes.byteLength)) throw new DecodeError('invalid');
        size = Number(large);
        header = 16;
      } else if (size === 0) {
        size = end - offset;
      }
      if (size < header || offset + size > end) throw new DecodeError('invalid');
      const type = view.getUint32(offset + 4);
      if (type === 0x69737065) {
        // 'ispe': the image's spatial extent.
        if (size < header + 12) throw new DecodeError('invalid');
        checkDimensions(view.getUint32(offset + header + 4), view.getUint32(offset + header + 8));
        found = true;
      } else if (type === 0x6d657461 || type === 0x69707270 || type === 0x6970636f) {
        // 'meta', 'iprp', 'ipco': containers that hold it.
        boxes(offset + header + (type === 0x6d657461 ? 4 : 0), offset + size, depth + 1);
      }
      offset += size;
    }
  };
  boxes(0, bytes.byteLength, 0);
  if (!found) throw new DecodeError('invalid');
}

/** Counts LZW output without building strings, before the decoder allocates its strip buffer. */
function validateLzw(bytes: Uint8Array, limit: number): void {
  const lengths = new Uint16Array(4096).fill(1, 0, 256);
  let bits = 9;
  let bit = 0;
  let next = 258;
  let previous = 0;
  let total = 0;
  while (bit + bits <= bytes.length * 8) {
    let code = 0;
    for (let index = 0; index < bits; index += 1, bit += 1) {
      code = (code << 1) | (((bytes[bit >> 3] ?? 0) >> (7 - (bit & 7))) & 1);
    }
    if (code === 257) return;
    if (code === 256) {
      bits = 9;
      next = 258;
      previous = 0;
      continue;
    }
    const length = code < next ? (lengths[code] ?? 0) : code === next && previous ? previous + 1 : 0;
    total += length;
    if (!length || total > limit) throw new DecodeError('invalid');
    if (previous) {
      if (next >= 4096) throw new DecodeError('invalid');
      lengths[next] = previous + 1;
      next += 1;
      if (next === (1 << bits) - 1 && bits < 12) bits += 1;
    }
    previous = length;
  }
  throw new DecodeError('invalid');
}

async function validateTiffStrips(bytes: ArrayBuffer, image: import('tiff').TiffIfd): Promise<void> {
  const offsets = image.tiled ? image.tileOffsets : image.stripOffsets;
  const counts = image.tiled ? image.tileByteCounts : image.stripByteCounts;
  const width = image.tiled ? (image.tileWidth ?? 0) : image.width;
  const height = image.tiled ? (image.tileHeight ?? 0) : Math.min(image.rowsPerStrip, image.height);
  checkDimensions(width, height);
  const limit = width * height * image.components * (image.bitsPerSample / 8);
  if (!offsets?.length || offsets.length > 2048 || counts?.length !== offsets.length) throw new DecodeError('unsupported');
  let expanded = 0;
  for (let index = 0; index < offsets.length; index += 1) {
    const offset = offsets[index] ?? -1;
    const size = counts[index] ?? 0;
    if (offset < 0 || size < 1 || offset + size > bytes.byteLength) throw new DecodeError('invalid');
    const strip = new Uint8Array(bytes, offset, size);
    if (image.compression === 5) {
      validateLzw(strip, limit);
    } else if (image.compression === 8 || image.compression === 32946) {
      const reader = new Blob([strip]).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
      let length = 0;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          length += value.length;
          if (length > limit) throw new DecodeError('invalid');
        }
      } finally {
        await reader.cancel();
      }
    } else if (image.compression !== 1) {
      throw new DecodeError('unsupported');
    }
    // Repeated strips and padding are bounded as well as the visible size.
    expanded += limit;
    if (expanded > 256 * 1024 * 1024) throw new DecodeError('too-large');
  }
}

async function toPng(rgba: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new DecodeError('unsupported');
  context.putImageData(new ImageData(rgba, width, height), 0, 0);
  return canvas.convertToBlob({ type: 'image/png' });
}

async function decodeHeif(bytes: ArrayBuffer): Promise<Blob> {
  validateHeif(bytes);
  const { heicTo } = await import('heic-to/next');
  return heicTo({ blob: new Blob([bytes]), type: 'image/png' });
}

async function decodeTiff(bytes: ArrayBuffer): Promise<Blob> {
  const { decode } = await import('tiff');
  validateTiffMetadata(bytes);
  const metadata = decode(bytes, { ignoreImageData: true, pages: [0] })[0];
  if (!metadata) throw new DecodeError('invalid');
  checkDimensions(metadata.width, metadata.height);
  if (metadata.orientation && metadata.orientation !== 1) throw new DecodeError('unsupported');
  if (
    (metadata.tiled && metadata.components > 1) ||
    ![1, 2, 3, 4].includes(metadata.components) ||
    ![8, 16].includes(metadata.bitsPerSample) ||
    ![0, 1, 2, 3].includes(metadata.type)
  ) {
    throw new DecodeError('unsupported');
  }
  await validateTiffStrips(bytes, metadata);
  const image = decode(bytes, { pages: [0] })[0];
  if (!image) throw new DecodeError('invalid');
  const rgba = new Uint8ClampedArray(image.width * image.height * 4);
  const scale = image.bitsPerSample === 16 ? 257 : 1;
  const palette = image.palette;
  for (let pixel = 0; pixel < image.width * image.height; pixel += 1) {
    const index = pixel * image.components;
    if (palette) {
      const color = palette[image.data[index] ?? 0] ?? [0, 0, 0];
      for (let channel = 0; channel < 3; channel += 1) rgba[pixel * 4 + channel] = (color[channel] ?? 0) / 257;
    } else if (image.type === 2) {
      for (let channel = 0; channel < 3; channel += 1) rgba[pixel * 4 + channel] = (image.data[index + channel] ?? 0) / scale;
    } else {
      // Grey: type 0 is white-is-zero, type 1 black-is-zero.
      const value = (image.data[index] ?? 0) / scale;
      rgba.fill(image.type === 0 ? 255 - value : value, pixel * 4, pixel * 4 + 3);
    }
    rgba[pixel * 4 + 3] = image.alpha ? (image.data[index + image.components - 1] ?? 0) / scale : 255;
  }
  return toPng(rgba, image.width, image.height);
}

async function decodePsd(bytes: ArrayBuffer): Promise<Blob> {
  const view = new DataView(bytes);
  // Signature '8BPS', then version 1 (PSD) or 2 (PSB); the size is read before the library runs.
  if (bytes.byteLength < 26 || view.getUint32(0) !== 0x38425053) throw new DecodeError('invalid');
  checkDimensions(view.getUint32(18), view.getUint32(14));
  const { initializeCanvas, readPsd } = await import('ag-psd');
  // The library asks for a canvas factory even when it returns plain bytes. A worker has no DOM, so
  // it gets an OffscreenCanvas (the same 2D surface, which is all the library touches).
  initializeCanvas(
    (width, height) => new OffscreenCanvas(width, height) as unknown as HTMLCanvasElement,
    (width, height) => new ImageData(width, height),
  );
  // Only the flattened picture is wanted: layers, thumbnail and linked files are never decoded, and
  // pixels come back as plain bytes.
  const psd = readPsd(bytes, {
    skipLayerImageData: true,
    skipThumbnail: true,
    skipLinkedFilesData: true,
    useImageData: true,
    totalMemoryLimit: 512 * 1024 * 1024,
    imageResourcesWhitelist: [],
  });
  const data = psd.imageData;
  if (!data) throw new DecodeError('unsupported');
  checkDimensions(data.width, data.height);
  const pixels = new Uint8ClampedArray(data.width * data.height * 4);
  pixels.set(data.data.subarray(0, pixels.length));
  return toPng(pixels, data.width, data.height);
}

async function decode({ bytes, format }: ImageDecodeRequest): Promise<Blob> {
  if (bytes.byteLength > MAX_BYTES) throw new DecodeError('too-large');
  if (format === 'heic') return decodeHeif(bytes);
  if (format === 'tiff') return decodeTiff(bytes);
  return decodePsd(bytes);
}

self.addEventListener('message', (event: MessageEvent<ImageDecodeRequest>) => {
  decode(event.data).then(
    (blob) => self.postMessage({ blob } satisfies ImageDecodeResponse),
    (cause: unknown) =>
      self.postMessage({ error: cause instanceof DecodeError ? cause.code : 'invalid' } satisfies ImageDecodeResponse),
  );
});
