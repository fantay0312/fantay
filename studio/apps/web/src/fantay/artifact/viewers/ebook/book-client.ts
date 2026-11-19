// SPDX-License-Identifier: AGPL-3.0-only
// The viewer's side of the book worker: one worker per open book, every request against the clock.
// A request that takes too long ends the worker (it may be stuck on a hostile file), and everything
// after that fails fast, so the viewer shows a notice instead of a frozen tab.
import type { ReadFailure } from '../document/xml';
import type { BookRequest, BookResponse } from './ebook.worker';
import type { BookChapterContent, BookInfo, BookResource } from './epub';

const OPEN_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 10_000;

export type BookFailure = ReadFailure | 'timeout';

/** A book request failed; `code` says why, in terms the viewer can word. */
export class BookError extends Error {
  constructor(readonly code: BookFailure) {
    super(code);
  }
}

type Sent = { type: 'open'; bytes: ArrayBuffer } | { type: 'chapter'; index: number } | { type: 'resources'; paths: string[] };
type Answer = Extract<BookResponse, { ok: true }>;

export class BookClient {
  private worker: Worker | null;
  private nextId = 1;
  private readonly waiting = new Map<number, { resolve(answer: Answer): void; reject(error: BookError): void; timer: number }>();

  constructor() {
    this.worker = new Worker(new URL('./ebook.worker.ts', import.meta.url), { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<BookResponse>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      window.clearTimeout(pending.timer);
      if (event.data.ok) pending.resolve(event.data);
      else pending.reject(new BookError(event.data.code));
    });
    this.worker.addEventListener('error', () => this.fail('invalid'));
  }

  /** Ends the worker and fails whatever was waiting on it. */
  private fail(code: BookFailure): void {
    this.worker?.terminate();
    this.worker = null;
    for (const pending of this.waiting.values()) {
      window.clearTimeout(pending.timer);
      pending.reject(new BookError(code));
    }
    this.waiting.clear();
  }

  private send(message: Sent, limit: number): Promise<Answer> {
    return new Promise<Answer>((resolve, reject) => {
      const worker = this.worker;
      if (!worker) {
        reject(new BookError('invalid'));
        return;
      }
      const id = this.nextId;
      this.nextId += 1;
      const timer = window.setTimeout(() => this.fail('timeout'), limit);
      this.waiting.set(id, { resolve, reject, timer });
      // The bytes are copied, not transferred: the viewer keeps them to tell versions apart.
      worker.postMessage({ id, ...message } satisfies BookRequest);
    });
  }

  async open(bytes: ArrayBuffer): Promise<BookInfo> {
    const answer = await this.send({ type: 'open', bytes }, OPEN_TIMEOUT_MS);
    if (answer.type !== 'open') throw new BookError('invalid');
    return answer.info;
  }

  async chapter(index: number): Promise<BookChapterContent> {
    const answer = await this.send({ type: 'chapter', index }, REQUEST_TIMEOUT_MS);
    if (answer.type !== 'chapter') throw new BookError('invalid');
    return answer.chapter;
  }

  async resources(paths: string[]): Promise<BookResource[]> {
    if (paths.length === 0) return [];
    const answer = await this.send({ type: 'resources', paths }, REQUEST_TIMEOUT_MS);
    if (answer.type !== 'resources') throw new BookError('invalid');
    return answer.resources;
  }

  dispose(): void {
    this.fail('invalid');
  }
}
