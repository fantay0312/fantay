// SPDX-License-Identifier: AGPL-3.0-only
// Encodes tool output (crop, split, upscale, captured frames, reference proxies) for the project
// (spec 05 §6.6): PNG first, then WebP 0.92, then JPEG 0.88 (JPEG only for opaque images) until the
// blob fits the target size, so the multipart upload stays under the daemon's 20 MB cap.
import { GENERATION_LIMITS } from '@open-design/contracts';

export type ProjectImageExt = 'png' | 'webp' | 'jpg';

/** The part of a canvas the encoder uses (an `HTMLCanvasElement`, or a test double). */
export interface EncodableCanvas {
  width: number;
  height: number;
  toBlob(callback: (blob: Blob | null) => void, type?: string, quality?: number): void;
}

export interface EncodeOptions {
  /** Known transparency; when absent the canvas is sampled. */
  hasAlpha?: boolean;
  /** Default `GENERATION_LIMITS.toolOutputTargetBytes` (15 MB). */
  targetBytes?: number;
}

export interface EncodedImage {
  blob: Blob;
  ext: ProjectImageExt;
}

interface EncodeAttempt {
  type: string;
  ext: ProjectImageExt;
  quality?: number;
  opaqueOnly?: boolean;
}

/** Tried in this order; the first blob within the target wins. */
export const ENCODE_ATTEMPTS: readonly EncodeAttempt[] = Object.freeze([
  { type: 'image/png', ext: 'png' },
  { type: 'image/webp', ext: 'webp', quality: 0.92 },
  { type: 'image/jpeg', ext: 'jpg', quality: 0.88, opaqueOnly: true },
]);

/** `image/png` → png, `image/webp` → webp, `image/jpeg` → jpg; anything else → null. */
export function extensionForMime(mime: string | undefined | null): ProjectImageExt | null {
  const normalized = (mime ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  if (normalized === 'image/png') return 'png';
  if (normalized === 'image/webp') return 'webp';
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') return 'jpg';
  return null;
}

function canvasToBlob(canvas: EncodableCanvas, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    } catch {
      resolve(null);
    }
  });
}

const ALPHA_SAMPLE_EDGE = 128;

/**
 * Whether any pixel is not fully opaque. Large canvases are sampled through a ≤128 px copy (a
 * transparent region of any visible size survives the downscale); when the pixels cannot be read
 * (no 2D context, tainted canvas) the canvas is treated as transparent, which only rules JPEG out.
 */
export function canvasHasAlpha(canvas: HTMLCanvasElement): boolean {
  try {
    const scale = Math.min(1, ALPHA_SAMPLE_EDGE / Math.max(1, canvas.width, canvas.height));
    const width = Math.max(1, Math.round(canvas.width * scale));
    const height = Math.max(1, Math.round(canvas.height * scale));
    let source: HTMLCanvasElement = canvas;
    if (scale < 1) {
      const sample = document.createElement('canvas');
      sample.width = width;
      sample.height = height;
      const sampleContext = sample.getContext('2d');
      if (!sampleContext) return true;
      sampleContext.drawImage(canvas, 0, 0, width, height);
      source = sample;
    }
    const context = source.getContext('2d');
    if (!context) return true;
    const { data } = context.getImageData(0, 0, width, height);
    for (let index = 3; index < data.length; index += 4) {
      if ((data[index] ?? 255) < 255) return true;
    }
    return false;
  } catch {
    return true;
  }
}

function isHtmlCanvas(canvas: EncodableCanvas): canvas is HTMLCanvasElement {
  return typeof HTMLCanvasElement !== 'undefined' && canvas instanceof HTMLCanvasElement;
}

/**
 * Encodes `canvas` for a project file. Returns the first attempt within `targetBytes`; when none
 * fits, the smallest blob produced. A browser that cannot write a format (it falls back to PNG)
 * is handled by reading the blob's real type.
 *
 * @throws Error('encode-failed') when the canvas produced no blob at all.
 */
export async function encodeForProject(canvas: EncodableCanvas, options: EncodeOptions = {}): Promise<EncodedImage> {
  const targetBytes = options.targetBytes ?? GENERATION_LIMITS.toolOutputTargetBytes;
  const hasAlpha = options.hasAlpha ?? (isHtmlCanvas(canvas) ? canvasHasAlpha(canvas) : true);
  let smallest: EncodedImage | null = null;
  for (const attempt of ENCODE_ATTEMPTS) {
    if (attempt.opaqueOnly && hasAlpha) continue;
    const blob = await canvasToBlob(canvas, attempt.type, attempt.quality);
    if (!blob) continue;
    const ext = extensionForMime(blob.type) ?? attempt.ext;
    const encoded: EncodedImage = { blob, ext };
    if (blob.size <= targetBytes) return encoded;
    if (!smallest || blob.size < smallest.blob.size) smallest = encoded;
  }
  if (!smallest) throw new Error('encode-failed');
  return smallest;
}
