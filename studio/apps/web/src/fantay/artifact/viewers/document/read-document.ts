// SPDX-License-Identifier: AGPL-3.0-only
// Reads an RTF or OpenDocument text file into markup for the reading page, off the main thread and
// against the clock: a file that takes longer than the limit ends in a notice, never a frozen tab.
import type { ReadingDocument } from './blocks';
import type { DocumentReadFormat, DocumentReadRequest, DocumentReadResponse } from './document.worker';
import type { ReadFailure } from './xml';

const READ_TIMEOUT_MS = 12_000;

export type DocumentReadOutcome = { ok: true; document: ReadingDocument } | { ok: false; code: ReadFailure | 'timeout' };

/** Never rejects. `signal` ends the worker early (the viewer went away or the file changed). */
export function readDocument(format: DocumentReadFormat, bytes: ArrayBuffer, signal: AbortSignal): Promise<DocumentReadOutcome> {
  return new Promise<DocumentReadOutcome>((resolve) => {
    const worker = new Worker(new URL('./document.worker.ts', import.meta.url), { type: 'module' });
    const finish = (outcome: DocumentReadOutcome): void => {
      window.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      worker.terminate();
      resolve(outcome);
    };
    const onAbort = (): void => finish({ ok: false, code: 'invalid' });
    const timer = window.setTimeout(() => finish({ ok: false, code: 'timeout' }), READ_TIMEOUT_MS);
    signal.addEventListener('abort', onAbort);
    worker.addEventListener('message', (event: MessageEvent<DocumentReadResponse>) => finish(event.data));
    worker.addEventListener('error', () => finish({ ok: false, code: 'invalid' }));
    // Copied, not transferred: the viewer keeps the bytes to tell one version of the file from the next.
    worker.postMessage({ format, bytes } satisfies DocumentReadRequest);
  });
}
