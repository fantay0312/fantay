// SPDX-License-Identifier: AGPL-3.0-only
// Fantay Soul: browser file helpers for card import and export and portrait upload. No React. Card data is parsed by
// the engine; the daemon parses it again and never trusts this preview.
import {
  PA_EMOTIONS,
  PA_PLACEHOLDER_PNG,
  SOUL_LIMITS,
  buildCharx,
  bytesToBase64,
  extractCardJson,
  isZipLike,
  parseCardText,
  parseCharacterCard,
  readCharx,
  scanPng,
} from '@open-design/contracts/soul';
import type { CharxReportItem, PaCardImportPreview, PaEmotion, PaSprites, ZipInflate } from '@open-design/contracts/soul';

import { cropToBlob } from '../../media-tools/image-ops';
import { paSoulAssetUrl, savePaBlob } from '../pa-api';

export const SOUL_MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
/** A CHARX archive may be larger than a PNG or JSON card: it carries the images. */
export const SOUL_MAX_CHARX_BYTES: number = SOUL_LIMITS.charxBytes;

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const WEBP_QUALITIES = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4];
const MAX_SHRINKS = 6;

function readWithFileReader(file: Blob, as: 'buffer' | 'text'): Promise<ArrayBuffer | string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result ?? (as === 'text' ? '' : new ArrayBuffer(0)));
    reader.onerror = () => reject(reader.error ?? new Error('file-unreadable'));
    if (as === 'text') reader.readAsText(file);
    else reader.readAsArrayBuffer(file);
  });
}

export async function readFileBytes(file: Blob): Promise<Uint8Array> {
  const buffer = typeof file.arrayBuffer === 'function' ? await file.arrayBuffer() : await readWithFileReader(file, 'buffer');
  return new Uint8Array(buffer as ArrayBuffer);
}

export async function readFileText(file: Blob): Promise<string> {
  return typeof file.text === 'function' ? file.text() : String(await readWithFileReader(file, 'text'));
}

export function downloadJson(name: string, value: unknown): void {
  savePaBlob(name, new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
}

export function downloadBytes(name: string, bytes: Uint8Array, mime: string): void {
  savePaBlob(name, new Blob([new Uint8Array(bytes)], { type: mime }));
}

// ---- images ----

interface Decoded {
  width: number;
  height: number;
  draw(context: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
}

async function decodeImage(source: Blob): Promise<Decoded> {
  if (typeof createImageBitmap === 'function') {
    const bitmap = await createImageBitmap(source);
    return {
      width: bitmap.width,
      height: bitmap.height,
      draw: (context, width, height) => context.drawImage(bitmap, 0, 0, width, height),
      close: () => bitmap.close(),
    };
  }
  const url = URL.createObjectURL(source);
  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const element = new Image();
      element.onload = () => resolve(element);
      element.onerror = () => reject(new Error('image-unreadable'));
      element.src = url;
    });
    return {
      width: image.naturalWidth,
      height: image.naturalHeight,
      draw: (context, width, height) => context.drawImage(image, 0, 0, width, height),
      close: () => URL.revokeObjectURL(url),
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function canvasBlob(canvas: HTMLCanvasElement, mime: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('image-unreadable'))), mime, quality),
  );
}

function render(image: Decoded, longSide: number): HTMLCanvasElement {
  const scale = Math.min(1, longSide / Math.max(1, image.width, image.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('image-unreadable');
  image.draw(context, canvas.width, canvas.height);
  return canvas;
}

/** Re-encodes an image through a canvas to at most SOUL_LIMITS.portraitMaxPx on its long side (WebP, quality 0.9,
 *  lowered until the result fits SOUL_LIMITS.assetBytes). This also removes any embedded card. A browser without a
 *  WebP encoder yields PNG; then the size shrinks instead. Throws `image-unreadable` or `image-too-large`. */
export async function imageToAsset(source: Blob): Promise<{ mime: 'image/webp' | 'image/png'; data: string }> {
  const image = await decodeImage(source);
  try {
    let longSide: number = SOUL_LIMITS.portraitMaxPx;
    for (let shrink = 0; shrink <= MAX_SHRINKS; shrink += 1) {
      const canvas = render(image, longSide);
      for (const quality of WEBP_QUALITIES) {
        const blob = await canvasBlob(canvas, 'image/webp', quality);
        const mime = blob.type === 'image/webp' ? 'image/webp' : 'image/png';
        if (blob.size <= SOUL_LIMITS.assetBytes) return { mime, data: bytesToBase64(await readFileBytes(blob)) };
        if (mime === 'image/png') break; // quality has no effect on PNG: shrink instead
      }
      longSide = Math.round(longSide * 0.75);
    }
    throw new Error('image-too-large');
  } finally {
    image.close();
  }
}

/** PNG bytes of a portrait for card export; PA_PLACEHOLDER_PNG when there is no portrait. A PNG asset is used as is
 *  (embedCard replaces any card chunks); WebP and JPEG are converted through a canvas. */
export async function portraitPngBytes(url: string | null): Promise<Uint8Array> {
  if (!url) return PA_PLACEHOLDER_PNG;
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`portrait-unavailable (${response.status})`);
  const blob = await response.blob();
  const bytes = await readFileBytes(blob);
  if (scanPng(bytes).ok) return bytes;
  const image = await decodeImage(blob);
  try {
    return await readFileBytes(await canvasBlob(render(image, Math.max(image.width, image.height)), 'image/png'));
  } finally {
    image.close();
  }
}

/** A character's CHARX archive: the exported card with its stored portrait and sprites, bytes as stored (no
 *  re-encoding). A picture that cannot be read is left out; the card still exports. */
export async function charxArchive(
  card: Record<string, unknown>,
  pictures: { portraitAssetId?: string | null; sprites?: PaSprites | null },
): Promise<Uint8Array> {
  const stored = async (id: string | null | undefined): Promise<Uint8Array | null> => {
    const url = paSoulAssetUrl(id);
    if (!url) return null;
    try {
      const response = await fetch(url, { cache: 'no-store' });
      return response.ok ? await readFileBytes(await response.blob()) : null;
    } catch {
      return null;
    }
  };
  const sprites: Partial<Record<PaEmotion, Uint8Array | null>> = {};
  for (const emotion of PA_EMOTIONS) sprites[emotion] = await stored(pictures.sprites?.[emotion]);
  return buildCharx({ card, portrait: await stored(pictures.portraitAssetId), sprites });
}

/** Crops an image to a normalised rectangle (0..1) through the media tools' canvas crop. */
export async function cropImageBlob(source: Blob, rect: { x: number; y: number; width: number; height: number }): Promise<Blob> {
  const url = URL.createObjectURL(source);
  try {
    return await cropToBlob(url, rect);
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ---- archives ----

/** Compressed bytes handed to the inflater per write. One write is inflated in one go (Chromium applies no
 *  backpressure inside a chunk), so a slice bounds the output of a step to about 1032 × this, however large the file. */
const INFLATE_SLICE = 16 * 1024;

/** Raw inflate through DecompressionStream('deflate-raw'), stopping after maxOutput + 1 bytes: once more than
 *  `maxOutput` bytes arrived the stream is cancelled and the first maxOutput + 1 bytes are returned, so the zip reader
 *  answers `too-large` (the ZipInflate contract). The input goes in slices, each written only after the previous one
 *  was taken, and no slice follows the cancel: a deflate bomb stops near the cap instead of expanding in memory.
 *  Throws `inflate-unavailable` without DecompressionStream, and on damaged data (the reader reports both as a
 *  damaged archive). */
export async function webInflate(data: Uint8Array, maxOutput: number): Promise<Uint8Array> {
  if (typeof DecompressionStream === 'undefined') throw new Error('inflate-unavailable');
  const stream = new DecompressionStream('deflate-raw');
  // Written straight into the stream (no Blob round trip). A rejected write is the same failure the reader reports.
  const writer = stream.writable.getWriter();
  const bytes = new Uint8Array(data);
  let stopped = false;
  void (async () => {
    try {
      for (let at = 0; at < bytes.length && !stopped; at += INFLATE_SLICE) await writer.write(bytes.subarray(at, at + INFLATE_SLICE));
      if (!stopped) await writer.close();
    } catch {
      // reported by the reader below
    }
  })();
  const reader = stream.readable.getReader();
  const limit = Math.max(0, maxOutput) + 1;
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = limit - total;
    chunks.push(value.byteLength > room ? value.subarray(0, room) : value);
    total += Math.min(value.byteLength, room);
    if (total >= limit) {
      stopped = true;
      await reader.cancel().catch(() => {});
      break;
    }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

/** What a CHARX archive brought besides the card: the portrait and sprite images (as found, not re-encoded) and the
 *  file report. */
export interface SoulCharxRead {
  sprites: Array<{ emotion: PaEmotion; name: string; blob: Blob }>;
  portrait: Blob | null;
  report: CharxReportItem[];
}

// ---- cards ----

function isPng(bytes: Uint8Array): boolean {
  return PNG_SIGNATURE.every((value, index) => bytes[index] === value);
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface SoulCardFile {
  preview: PaCardImportPreview;
  card: unknown;
  portrait: { mime: string; data: string } | null;
  fileName: string;
  /** Set for a CHARX archive whose card parsed. */
  charx?: SoulCharxRead;
  /** Set when the archive itself could not be read (the preview then carries no card). */
  charxError?: 'corrupt' | 'no-card' | 'zip64';
}

const CHARX_NAME = /\.charx$/i;

/** The CHARX branch of readCardFile: the archive is read here with the engine; the daemon later receives the card JSON
 *  (parsed again) and the asset ids of the images the modal uploads. */
async function readCharxFile(bytes: Uint8Array, fileName: string, now: number, inflate: ZipInflate): Promise<SoulCardFile> {
  const failed = (preview: PaCardImportPreview, charxError?: SoulCardFile['charxError']): SoulCardFile => ({
    preview,
    card: null,
    portrait: null,
    fileName,
    ...(charxError ? { charxError } : {}),
  });
  const result = await readCharx(bytes, inflate, { fileName, now });
  if (!result.ok) {
    if (result.error === 'too-large') return failed({ ok: false, error: 'too-large', detail: 'charx' });
    if (result.error === 'bad-json') return failed({ ok: false, error: 'bad-json', detail: 'charx card.json' });
    const charxError = result.error === 'no-card' ? 'no-card' : result.error === 'zip64' ? 'zip64' : 'corrupt';
    return failed({ ok: false, error: 'unsupported-format', detail: `charx ${result.error}` }, charxError);
  }
  if (!result.preview.ok) return failed(result.preview);
  const blobOf = (asset: { mime: string; data: Uint8Array }) => new Blob([new Uint8Array(asset.data)], { type: asset.mime });
  const portraitAsset = result.assets.find((asset) => asset.role === 'portrait');
  const portraitBlob = portraitAsset ? blobOf(portraitAsset) : null;
  let portrait: { mime: string; data: string } | null = result.preview.portrait;
  if (portraitBlob) {
    try {
      portrait = await imageToAsset(portraitBlob);
    } catch {
      portrait = result.preview.portrait; // the card still imports; the portrait can be added later
    }
  }
  const sprites = result.assets.flatMap((asset) =>
    asset.role === 'sprite' && asset.emotion ? [{ emotion: asset.emotion, name: asset.name, blob: blobOf(asset) }] : [],
  );
  return {
    preview: result.preview,
    card: result.card,
    portrait,
    fileName,
    charx: { sprites, portrait: portraitBlob, report: result.report },
  };
}

/** Reads a dropped or picked card file: PNG through extractCardJson, a CHARX archive (named `.charx`, or a non-PNG file
 *  that is a zip) through readCharx, anything else through parseCardText. Files over the size limit (CHARX
 *  SOUL_MAX_CHARX_BYTES, else SOUL_MAX_UPLOAD_BYTES) get a `too-large` preview without being read. `options.inflate`
 *  is the test seam for the archive's raw inflate (default webInflate). */
export async function readCardFile(file: File, now: number, options?: { inflate?: ZipInflate }): Promise<SoulCardFile> {
  const fileName = file.name;
  const named = CHARX_NAME.test(fileName);
  if (file.size > (named ? SOUL_MAX_CHARX_BYTES : SOUL_MAX_UPLOAD_BYTES))
    return { preview: { ok: false, error: 'too-large', detail: `${file.size} bytes` }, card: null, portrait: null, fileName };
  const bytes = await readFileBytes(file);
  const png = isPng(bytes);
  if (named || (!png && isZipLike(bytes))) return readCharxFile(bytes, fileName, now, options?.inflate ?? webInflate);
  const parseOptions = { fileName, now };
  if (png) {
    const extracted = extractCardJson(bytes);
    if (!extracted.ok) {
      const error = extracted.error === 'too-large' ? 'too-large' : extracted.error === 'bad-json' || extracted.error === 'bad-base64' ? 'bad-json' : 'unsupported-format';
      return { preview: { ok: false, error, detail: extracted.error }, card: null, portrait: null, fileName };
    }
    const preview = parseCharacterCard(extracted.json, parseOptions);
    let portrait: { mime: string; data: string } | null = null;
    if (preview.ok) {
      try {
        portrait = await imageToAsset(file);
      } catch {
        portrait = null; // the card still imports; the portrait can be added later
      }
    }
    return { preview, card: extracted.json, portrait, fileName };
  }
  const text = new TextDecoder('utf-8').decode(bytes);
  const preview = parseCardText(text, parseOptions);
  if (!preview.ok) return { preview, card: null, portrait: null, fileName };
  return { preview, card: JSON.parse(stripBom(text)) as unknown, portrait: preview.portrait, fileName };
}
