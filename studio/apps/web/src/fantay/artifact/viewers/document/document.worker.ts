// SPDX-License-Identifier: AGPL-3.0-only
// The RTF and OpenDocument readers run here, one worker per file. The file is untrusted: a reader
// that loops or runs out of memory takes this worker with it, not the tab, and the viewer ends the
// worker when it takes too long (`read-document.ts`).
/// <reference lib="webworker" />
import type { ReadingDocument } from './blocks';
import { readOdt } from './odt';
import { readRtf } from './rtf';
import { ReadError, type ReadFailure } from './xml';

export type DocumentReadFormat = 'rtf' | 'odt';
export interface DocumentReadRequest {
  format: DocumentReadFormat;
  bytes: ArrayBuffer;
}
export type DocumentReadResponse = { ok: true; document: ReadingDocument } | { ok: false; code: ReadFailure };

self.addEventListener('message', (event: MessageEvent<DocumentReadRequest>) => {
  let response: DocumentReadResponse;
  try {
    const bytes = new Uint8Array(event.data.bytes);
    response = { ok: true, document: event.data.format === 'rtf' ? readRtf(bytes) : readOdt(bytes) };
  } catch (cause) {
    response = { ok: false, code: cause instanceof ReadError ? cause.code : 'invalid' };
  }
  self.postMessage(response);
});
