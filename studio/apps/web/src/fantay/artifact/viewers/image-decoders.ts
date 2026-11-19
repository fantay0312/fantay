// SPDX-License-Identifier: AGPL-3.0-only
// Image formats the browser does not decode (HEIC / HEIF, TIFF, PSD). The decoding runs in a worker
// that lives for one picture: the file is untrusted, so a decoder that hangs or runs out of memory
// takes the worker with it, not the tab. The result is a PNG the `<img>` can show.
import type { ImageDecodeFormat, ImageDecodeRequest, ImageDecodeResponse } from './image/decode.worker';

const DECODE_TIMEOUT_MS = 30_000;
const FORMATS: ReadonlySet<string> = new Set<ImageDecodeFormat>(['heic', 'tiff', 'psd']);

/** True when the format has to go through `decodeImage` before an `<img>` can show it. */
export function needsDecoding(format: string): boolean {
  return format !== 'native' && format !== 'svg';
}

/** Rejects when the format has no decoder, the bytes are not what the name claims, or it takes too long. */
export function decodeImage(format: string, bytes: ArrayBuffer): Promise<Blob> {
  if (!FORMATS.has(format)) return Promise.reject(new Error(`no decoder for ${format}`));
  return new Promise<Blob>((resolve, reject) => {
    const worker = new Worker(new URL('./image/decode.worker.ts', import.meta.url), { type: 'module' });
    const finish = (settle: () => void): void => {
      window.clearTimeout(timer);
      worker.terminate();
      settle();
    };
    const timer = window.setTimeout(() => finish(() => reject(new Error('timeout'))), DECODE_TIMEOUT_MS);
    worker.addEventListener('message', (event: MessageEvent<ImageDecodeResponse>) => {
      const data = event.data;
      finish(() => ('blob' in data ? resolve(data.blob) : reject(new Error(data.error))));
    });
    worker.addEventListener('error', () => finish(() => reject(new Error('worker'))));
    // Copied, not transferred: the viewer keeps the bytes for the next version check.
    worker.postMessage({ bytes, format: format as ImageDecodeFormat } satisfies ImageDecodeRequest);
  });
}
