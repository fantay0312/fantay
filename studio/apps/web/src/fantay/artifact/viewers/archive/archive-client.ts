// SPDX-License-Identifier: AGPL-3.0-only
// The viewer's side of the archive worker: open an archive, get its listing, ask for one entry.
// Every request has a deadline. A worker that misses it is ended, because a reader stuck on a
// hostile archive cannot be interrupted any other way; the viewer then shows a notice with a retry.
import { ArchiveError, type ArchiveFailure, type ArchiveFormat, type ArchiveListing } from './archive-reader';
import type { ArchiveWorkerRequest, ArchiveWorkerResponse } from './archive.worker';

const LIST_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 15_000;

export interface ArchiveSession {
  listing: Promise<ArchiveListing>;
  /** The unpacked bytes of one entry, at most `limit` of them. Rejects with an `ArchiveError`. */
  read(id: number, limit: number): Promise<Uint8Array<ArrayBuffer>>;
  /** True once the worker is gone: closed by the viewer, or ended after a missed deadline. */
  readonly closed: boolean;
  close(): void;
}

interface Pending {
  resolve(bytes: Uint8Array<ArrayBuffer>): void;
  reject(error: ArchiveError): void;
  timer: number;
}

/** Starts a worker for one archive. The bytes are copied to it; the caller keeps its own. */
export function openArchiveSession(bytes: ArrayBuffer, name: string, hint?: ArchiveFormat): ArchiveSession {
  const worker = new Worker(new URL('./archive.worker.ts', import.meta.url), { type: 'module' });
  const pending = new Map<number, Pending>();
  let ticket = 0;
  let closed = false;
  let settleListing: ((listing: ArchiveListing) => void) | null = null;
  let failListing: ((error: ArchiveError) => void) | null = null;

  const end = (code: ArchiveFailure): void => {
    if (closed) return;
    closed = true;
    worker.terminate();
    failListing?.(new ArchiveError(code));
    for (const item of pending.values()) {
      window.clearTimeout(item.timer);
      item.reject(new ArchiveError(code));
    }
    pending.clear();
  };

  const listing = new Promise<ArchiveListing>((resolve, reject) => {
    const timer = window.setTimeout(() => end('timeout'), LIST_TIMEOUT_MS);
    settleListing = (value) => {
      window.clearTimeout(timer);
      resolve(value);
    };
    failListing = (error) => {
      window.clearTimeout(timer);
      reject(error);
    };
  });
  // A session closed before anyone listens must not surface as an unhandled rejection.
  listing.catch(() => undefined);

  worker.addEventListener('message', (event: MessageEvent<ArchiveWorkerResponse>) => {
    const data = event.data;
    if (data.type === 'listing') settleListing?.(data.listing);
    else if (data.type === 'failed') failListing?.(new ArchiveError(data.code));
    else {
      const item = pending.get(data.ticket);
      if (!item) return;
      pending.delete(data.ticket);
      window.clearTimeout(item.timer);
      if (data.type === 'entry') item.resolve(data.bytes);
      else item.reject(new ArchiveError(data.code));
    }
  });
  worker.addEventListener('error', () => end('invalid'));
  worker.postMessage({ type: 'open', bytes, name, hint } satisfies ArchiveWorkerRequest);

  return {
    listing,
    get closed() {
      return closed;
    },
    read(id, limit) {
      if (closed) return Promise.reject(new ArchiveError('missing'));
      return new Promise<Uint8Array<ArrayBuffer>>((resolve, reject) => {
        ticket += 1;
        const mine = ticket;
        const timer = window.setTimeout(() => end('timeout'), READ_TIMEOUT_MS);
        pending.set(mine, { resolve, reject, timer });
        worker.postMessage({ type: 'read', ticket: mine, id, limit } satisfies ArchiveWorkerRequest);
      });
    },
    close() {
      end('missing');
    },
  };
}
