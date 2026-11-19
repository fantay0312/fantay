// SPDX-License-Identifier: AGPL-3.0-only
// The window's side of the deck worker, driven by a scripted worker: the order slides are asked
// for, and what happens when the engine fails, hangs or dies.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DECK_OPEN_TIMEOUT_MS, SLIDE_RENDER_TIMEOUT_MS, createDeckClient, type RenderedSlide } from '../../../src/fantay/artifact/viewers/slides/deck-client';
import type { DeckInfo, DeckRequest, DeckResponse } from '../../../src/fantay/artifact/viewers/slides/protocol';

const DECK: DeckInfo = {
  width: 960,
  height: 540,
  drawable: true,
  outlineCut: false,
  slides: Array.from({ length: 6 }, (_, index) => ({ title: `第 ${index + 1} 张`, hidden: false, notes: '', blocks: [] })),
};

/** A worker that records what it is sent and answers only when the test says so. */
class ScriptedWorker {
  static made: ScriptedWorker[] = [];
  readonly requests: DeckRequest[] = [];
  terminated = false;
  private readonly listeners = new Map<string, Array<(event: unknown) => void>>();

  constructor() {
    ScriptedWorker.made.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  postMessage(request: DeckRequest): void {
    this.requests.push(request);
  }

  terminate(): void {
    this.terminated = true;
  }

  answer(response: DeckResponse): void {
    for (const listener of this.listeners.get('message') ?? []) listener({ data: response });
  }

  crash(): void {
    for (const listener of this.listeners.get('error') ?? []) listener({});
  }

  get last(): DeckRequest {
    const request = this.requests[this.requests.length - 1];
    if (!request) throw new Error('nothing was sent');
    return request;
  }

  /** Slide indices asked for so far, in order. */
  get rendered(): number[] {
    return this.requests.flatMap((request) => (request.type === 'render' ? [request.index] : []));
  }
}

function setup() {
  const slides: Array<[number, RenderedSlide | 'failed']> = [];
  const client = createDeckClient('pptx', new ArrayBuffer(8), (index, result) => slides.push([index, result]), () => new ScriptedWorker() as unknown as Worker);
  return { client, slides };
}

function picture(id: number, index: number): DeckResponse {
  return { id, type: 'rendered', index, image: new Blob(['<svg/>'], { type: 'image/svg+xml' }), unsupported: [] };
}

async function opened(client: ReturnType<typeof setup>['client']): Promise<ScriptedWorker> {
  const promise = client.open();
  const worker = ScriptedWorker.made[ScriptedWorker.made.length - 1];
  if (!worker) throw new Error('no worker');
  worker.answer({ id: worker.last.id, type: 'opened', deck: DECK });
  await promise;
  return worker;
}

beforeEach(() => {
  ScriptedWorker.made = [];
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDeckClient', () => {
  it('opens the deck with a copy of the bytes and resolves with its structure', async () => {
    const { client } = setup();
    const promise = client.open();
    const worker = ScriptedWorker.made[0];
    expect(worker?.last).toMatchObject({ type: 'open', kind: 'pptx' });
    worker?.answer({ id: worker.last.id, type: 'opened', deck: DECK });
    await expect(promise).resolves.toBe(DECK);
    // Asking again does not open it twice.
    await expect(client.open()).resolves.toBe(DECK);
    expect(ScriptedWorker.made).toHaveLength(1);
  });

  it('draws one slide at a time, in the order wanted', async () => {
    const { client, slides } = setup();
    const worker = await opened(client);
    client.want([2, 1, 3]);
    expect(worker.rendered).toEqual([2]);
    worker.answer(picture(worker.last.id, 2));
    expect(worker.rendered).toEqual([2, 1]);
    worker.answer(picture(worker.last.id, 1));
    worker.answer(picture(worker.last.id, 3));
    expect(slides.map(([index]) => index)).toEqual([2, 1, 3]);
    expect(slides.every(([, result]) => result !== 'failed')).toBe(true);
  });

  it('replaces what is waiting when the reader moves on, and lets the slide being drawn finish', async () => {
    const { client, slides } = setup();
    const worker = await opened(client);
    client.want([0, 1, 2]);
    client.want([5, 4, 0]);
    expect(worker.rendered).toEqual([0]);
    worker.answer(picture(worker.last.id, 0));
    worker.answer(picture(worker.last.id, 5));
    worker.answer(picture(worker.last.id, 4));
    // Slide 0 was being drawn already: it is not drawn a second time, and 1 and 2 are dropped.
    expect(worker.rendered).toEqual([0, 5, 4]);
    expect(slides.map(([index]) => index)).toEqual([0, 5, 4]);
  });

  it('starts drawing what was wanted before the deck had opened', async () => {
    const { client } = setup();
    const promise = client.open();
    client.want([3]);
    const worker = ScriptedWorker.made[0];
    expect(worker?.rendered).toEqual([]);
    worker?.answer({ id: worker.last.id, type: 'opened', deck: DECK });
    await promise;
    expect(worker?.rendered).toEqual([3]);
  });

  it('reports a slide the engine cannot draw and carries on', async () => {
    const { client, slides } = setup();
    const worker = await opened(client);
    client.want([1, 2]);
    worker.answer({ id: worker.last.id, type: 'failed', failure: 'invalid' });
    expect(slides).toEqual([[1, 'failed']]);
    expect(worker.rendered).toEqual([1, 2]);
  });

  it('ends a slide that takes too long, then reopens the deck in a fresh worker for the rest', async () => {
    const { client, slides } = setup();
    const first = await opened(client);
    client.want([1, 2]);
    vi.advanceTimersByTime(SLIDE_RENDER_TIMEOUT_MS + 1);
    expect(first.terminated).toBe(true);
    expect(slides).toEqual([[1, 'failed']]);

    const second = ScriptedWorker.made[1];
    expect(second?.last).toMatchObject({ type: 'open', kind: 'pptx' });
    second?.answer({ id: second.last.id, type: 'opened', deck: DECK });
    await vi.advanceTimersByTimeAsync(0);
    expect(second?.rendered).toEqual([2]);
    second?.answer(picture(second.last.id, 2));
    expect(slides.map(([index]) => index)).toEqual([1, 2]);
  });

  it('fails the slides still waiting when the deck cannot be reopened', async () => {
    const { client, slides } = setup();
    await opened(client);
    client.want([1, 2, 3]);
    vi.advanceTimersByTime(SLIDE_RENDER_TIMEOUT_MS + 1);
    const second = ScriptedWorker.made[1];
    second?.answer({ id: second.last.id, type: 'failed', failure: 'invalid' });
    await vi.advanceTimersByTimeAsync(0);
    expect(slides).toEqual([
      [1, 'failed'],
      [2, 'failed'],
      [3, 'failed'],
    ]);
  });

  it('rejects with the engine’s reason, with `timeout` when opening hangs, and with `worker` when it dies', async () => {
    const refused = setup();
    const promise = refused.client.open();
    const worker = ScriptedWorker.made[0];
    worker?.answer({ id: worker.last.id, type: 'failed', failure: 'empty' });
    await expect(promise).rejects.toBe('empty');
    expect(worker?.terminated).toBe(true);

    const hung = setup();
    const waiting = hung.client.open();
    const rejection = expect(waiting).rejects.toBe('timeout');
    vi.advanceTimersByTime(DECK_OPEN_TIMEOUT_MS + 1);
    await rejection;
    expect(ScriptedWorker.made[1]?.terminated).toBe(true);

    const dead = setup();
    const dying = dead.client.open();
    ScriptedWorker.made[2]?.crash();
    await expect(dying).rejects.toBe('worker');
  });

  it('ignores an answer to a request it has given up on', async () => {
    const { client, slides } = setup();
    const worker = await opened(client);
    client.want([1]);
    const stale = worker.last.id;
    worker.answer(picture(stale + 40, 1));
    expect(slides).toEqual([]);
    worker.answer(picture(stale, 1));
    expect(slides).toHaveLength(1);
  });

  it('says nothing after it is disposed, and ends the worker', async () => {
    const { client, slides } = setup();
    const worker = await opened(client);
    client.want([1, 2]);
    client.dispose();
    expect(worker.terminated).toBe(true);
    worker.answer(picture(worker.last.id, 1));
    vi.advanceTimersByTime(SLIDE_RENDER_TIMEOUT_MS * 2);
    client.want([3]);
    expect(slides).toEqual([]);
    expect(worker.rendered).toEqual([1]);
  });
});
