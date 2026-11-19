// SPDX-License-Identifier: AGPL-3.0-only
// The archive reader, off the main thread. One worker serves one archive: it keeps the bytes, lists
// the entries once and unpacks single entries when asked. The archive is untrusted, so a reader
// that hangs or runs out of memory takes this worker with it, not the tab (the viewer ends a worker
// that does not answer in time).
/// <reference lib="webworker" />
import { ArchiveError, openArchive, type ArchiveFailure, type ArchiveFormat, type ArchiveListing, type OpenedArchive } from './archive-reader';

export type ArchiveWorkerRequest =
  | { type: 'open'; bytes: ArrayBuffer; name: string; hint?: ArchiveFormat }
  | { type: 'read'; ticket: number; id: number; limit: number };

export type ArchiveWorkerResponse =
  | { type: 'listing'; listing: ArchiveListing }
  | { type: 'failed'; code: ArchiveFailure }
  | { type: 'entry'; ticket: number; bytes: Uint8Array<ArrayBuffer> }
  | { type: 'entry-failed'; ticket: number; code: ArchiveFailure };

let opened: OpenedArchive | null = null;

function codeOf(error: unknown): ArchiveFailure {
  return error instanceof ArchiveError ? error.code : 'invalid';
}

function reply(response: ArchiveWorkerResponse, transfer: Transferable[] = []): void {
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(response, transfer);
}

self.addEventListener('message', (event: MessageEvent<ArchiveWorkerRequest>) => {
  const request = event.data;
  if (request.type === 'open') {
    try {
      opened = openArchive(new Uint8Array(request.bytes), request.name, { hint: request.hint });
      reply({ type: 'listing', listing: opened.listing });
    } catch (error) {
      reply({ type: 'failed', code: codeOf(error) });
    }
    return;
  }
  try {
    if (!opened) throw new ArchiveError('missing');
    const bytes = opened.read(request.id, request.limit);
    reply({ type: 'entry', ticket: request.ticket, bytes }, [bytes.buffer]);
  } catch (error) {
    reply({ type: 'entry-failed', ticket: request.ticket, code: codeOf(error) });
  }
});
