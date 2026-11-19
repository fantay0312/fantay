// SPDX-License-Identifier: AGPL-3.0-only
// The book lives here for as long as its tab is open: the archive is listed once, and chapters,
// pictures and stylesheets are inflated when the viewer asks for them. The file is untrusted, so a
// reader that loops or runs out of memory takes this worker with it, not the tab; the viewer ends
// the worker when a request takes too long (`book-client.ts`).
/// <reference lib="webworker" />
import { ReadError, type ReadFailure } from '../document/xml';
import { openBook, type Book, type BookChapterContent, type BookInfo, type BookResource } from './epub';

export type BookRequest =
  | { id: number; type: 'open'; bytes: ArrayBuffer }
  | { id: number; type: 'chapter'; index: number }
  | { id: number; type: 'resources'; paths: string[] };

export type BookResponse =
  | { id: number; ok: true; type: 'open'; info: BookInfo }
  | { id: number; ok: true; type: 'chapter'; chapter: BookChapterContent }
  | { id: number; ok: true; type: 'resources'; resources: BookResource[] }
  | { id: number; ok: false; code: ReadFailure };

/** One request may not hand back more than this, however many pictures a chapter names. */
const MAX_RESPONSE_BYTES = 96 * 1024 * 1024;
const MAX_RESOURCES = 400;

let book: Book | null = null;

function answer(request: BookRequest): { response: BookResponse; transfer: Transferable[] } {
  if (request.type === 'open') {
    book = openBook(new Uint8Array(request.bytes));
    return { response: { id: request.id, ok: true, type: 'open', info: book.info }, transfer: [] };
  }
  if (!book) throw new ReadError('invalid');
  if (request.type === 'chapter') {
    return { response: { id: request.id, ok: true, type: 'chapter', chapter: book.chapter(request.index) }, transfer: [] };
  }
  const resources: BookResource[] = [];
  const transfer: Transferable[] = [];
  let total = 0;
  for (const path of request.paths.slice(0, MAX_RESOURCES)) {
    const resource = book.resource(path);
    if (!resource || total + resource.bytes.byteLength > MAX_RESPONSE_BYTES) continue;
    total += resource.bytes.byteLength;
    resources.push(resource);
    transfer.push(resource.bytes.buffer);
  }
  return { response: { id: request.id, ok: true, type: 'resources', resources }, transfer };
}

self.addEventListener('message', (event: MessageEvent<BookRequest>) => {
  try {
    const { response, transfer } = answer(event.data);
    self.postMessage(response, transfer);
  } catch (cause) {
    self.postMessage({ id: event.data.id, ok: false, code: cause instanceof ReadError ? cause.code : 'invalid' } satisfies BookResponse);
  }
});
