// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the deck worker: opens a deck, asks for slides one at a time (nearest to the
// reader first), and enforces the time limits. A parse or a slide that takes too long ends the
// worker, never the tab; after a slide times out the deck is reopened in a fresh worker so the
// other slides still draw.
import type { DeckFailure, DeckInfo, DeckKind, DeckRequest, DeckResponse, UnsupportedCount } from './protocol';

/** Opening covers downloading the engine chunk the first time, so it gets the longer limit. */
export const DECK_OPEN_TIMEOUT_MS = 30_000;
export const SLIDE_RENDER_TIMEOUT_MS = 12_000;

export interface RenderedSlide {
  /** An SVG document. Show it through an `<img>`; never inline it or open it as a page. */
  image: Blob;
  unsupported: UnsupportedCount[];
}

export interface DeckClient {
  /** Resolves with the deck's structure; rejects with a `DeckFailure`. */
  open(): Promise<DeckInfo>;
  /** The slides to draw, most wanted first. Replaces what was waiting; a slide being drawn finishes. */
  want(indices: readonly number[]): void;
  /** Ends the worker. Nothing is reported after this. */
  dispose(): void;
}

export type SlideListener = (index: number, result: RenderedSlide | 'failed') => void;

/** How the worker is made; a test passes its own. */
export type WorkerFactory = () => Worker;

function defaultWorker(): Worker {
  return new Worker(new URL('./deck.worker.ts', import.meta.url), { type: 'module' });
}

export function createDeckClient(
  kind: DeckKind,
  bytes: ArrayBuffer,
  onSlide: SlideListener,
  makeWorker: WorkerFactory = defaultWorker,
): DeckClient {
  let worker: Worker | null = null;
  let disposed = false;
  let nextId = 1;
  /** The open in flight or done for the current worker. */
  let opening: Promise<DeckInfo> | null = null;
  let ready = false;
  let queue: number[] = [];
  let active: { id: number; index: number; timer: ReturnType<typeof setTimeout> } | null = null;
  let pendingOpen: { id: number; resolve(deck: DeckInfo): void; reject(failure: DeckFailure): void; timer: ReturnType<typeof setTimeout> } | null = null;

  const post = (request: DeckRequest): void => {
    // Copied, not transferred: the viewer keeps the bytes so the deck can be reopened.
    worker?.postMessage(request);
  };

  const endWorker = (): void => {
    worker?.terminate();
    worker = null;
    ready = false;
    opening = null;
  };

  const failOpen = (failure: DeckFailure): void => {
    const pending = pendingOpen;
    if (!pending) return;
    pendingOpen = null;
    clearTimeout(pending.timer);
    endWorker();
    pending.reject(failure);
  };

  const pump = (): void => {
    if (disposed || active || queue.length === 0) return;
    if (!ready) {
      // After a slide timed out the worker is gone: reopen, then carry on with what is waiting.
      if (!opening) {
        start().then(pump, () => {
          const waiting = queue;
          queue = [];
          if (!disposed) waiting.forEach((index) => onSlide(index, 'failed'));
        });
      }
      return;
    }
    const index = queue.shift();
    if (index === undefined) return;
    const id = nextId;
    nextId += 1;
    const timer = setTimeout(() => {
      if (active?.id !== id) return;
      active = null;
      endWorker();
      if (!disposed) onSlide(index, 'failed');
      pump();
    }, SLIDE_RENDER_TIMEOUT_MS);
    active = { id, index, timer };
    post({ id, type: 'render', index });
  };

  const onMessage = (event: MessageEvent<DeckResponse>): void => {
    if (disposed) return;
    const data = event.data;
    if (pendingOpen && data.id === pendingOpen.id) {
      const pending = pendingOpen;
      if (data.type === 'opened') {
        pendingOpen = null;
        clearTimeout(pending.timer);
        ready = true;
        pending.resolve(data.deck);
        pump();
      } else if (data.type === 'failed') {
        failOpen(data.failure);
      }
      return;
    }
    if (!active || data.id !== active.id) return;
    const { index, timer } = active;
    clearTimeout(timer);
    active = null;
    if (data.type === 'rendered') onSlide(index, { image: data.image, unsupported: data.unsupported });
    else onSlide(index, 'failed');
    pump();
  };

  const onError = (): void => {
    if (disposed) return;
    if (pendingOpen) {
      failOpen('worker');
      return;
    }
    // The worker died while drawing (out of memory, a crash in the engine).
    const lost = active;
    if (lost) clearTimeout(lost.timer);
    active = null;
    endWorker();
    if (lost) onSlide(lost.index, 'failed');
    pump();
  };

  function start(): Promise<DeckInfo> {
    if (opening) return opening;
    const promise = new Promise<DeckInfo>((resolve, reject) => {
      if (disposed) {
        reject('worker' satisfies DeckFailure);
        return;
      }
      try {
        worker = makeWorker();
      } catch {
        reject('worker' satisfies DeckFailure);
        return;
      }
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      const id = nextId;
      nextId += 1;
      const timer = setTimeout(() => failOpen('timeout'), DECK_OPEN_TIMEOUT_MS);
      pendingOpen = { id, resolve, reject, timer };
      post({ id, type: 'open', kind, bytes });
    });
    opening = promise;
    // A failed open is forgotten, so the next request starts a fresh worker.
    promise.catch(() => {
      if (opening === promise) opening = null;
    });
    return promise;
  }

  return {
    open: start,
    want(indices) {
      if (disposed) return;
      const drawing = active?.index;
      queue = indices.filter((index, position) => index !== drawing && indices.indexOf(index) === position);
      pump();
    },
    dispose() {
      disposed = true;
      if (pendingOpen) clearTimeout(pendingOpen.timer);
      if (active) clearTimeout(active.timer);
      pendingOpen = null;
      active = null;
      queue = [];
      endWorker();
    },
  };
}
