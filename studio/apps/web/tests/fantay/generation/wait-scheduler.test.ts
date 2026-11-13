// Spec 05 §4.5 with a virtual clock (docs/testing/test-efficiency.zh-CN.md): at most two concurrent 25 s
// long-polls, short polls (`timeoutMs: 0`) after exactly 1 500 ms for the others, slot rotation, 404 → gone,
// backoff 1/2/4 s, give-up, abort during sleep and during a request, stop on a terminal snapshot.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaTaskSnapshotResponse, MediaTaskStatus, MediaTaskWaitRequest } from '@open-design/contracts';

import type { WaitResult } from '../../../src/fantay/generation/dispatch';
import { createWaitScheduler } from '../../../src/fantay/generation/wait-scheduler';

interface Call {
  taskId: string;
  body: MediaTaskWaitRequest;
  at: number;
  resolve(result: WaitResult): void;
  signal: AbortSignal;
}

function snapshot(taskId: string, status: MediaTaskStatus, nextSince = 0): MediaTaskSnapshotResponse {
  return { taskId, status, startedAt: 1, endedAt: null, progress: [], nextSince };
}

/** A fake daemon: every request stays open until the test (or the long-poll timeout) answers it. */
function fakeIo(autoAnswer?: (call: Call) => WaitResult | null) {
  const calls: Call[] = [];
  const io = {
    waitTask(taskId: string, body: MediaTaskWaitRequest, signal: AbortSignal): Promise<WaitResult> {
      return new Promise<WaitResult>((resolve) => {
        const call: Call = { taskId, body, at: Date.now(), resolve, signal };
        calls.push(call);
        signal.addEventListener('abort', () => resolve({ kind: 'aborted' }), { once: true });
        const answer = autoAnswer?.(call);
        if (answer) {
          resolve(answer);
          return;
        }
        // A long-poll without news answers when its timeout elapses; a short poll answers at once.
        setTimeout(() => resolve({ kind: 'snapshot', snapshot: snapshot(taskId, 'running') }), body.timeoutMs ?? 0);
      });
    },
  };
  return { io, calls };
}

const handlers = () => ({ onSnapshot: vi.fn(), onNetworkTrouble: vi.fn() });

describe('wait scheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives two tasks a 25 s long-poll and short-polls the third at exactly 1 500 ms', async () => {
    const { io, calls } = fakeIo();
    const scheduler = createWaitScheduler(io);
    const controller = new AbortController();
    for (const taskId of ['a', 'b', 'c']) void scheduler.watch(taskId, handlers(), controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => [call.taskId, call.body.timeoutMs])).toEqual([
      ['a', 25_000],
      ['b', 25_000],
    ]);
    await vi.advanceTimersByTimeAsync(1_499);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls[2]).toMatchObject({ taskId: 'c', body: { since: 0, timeoutMs: 0 }, at: 1_500 });
    expect(scheduler.activeCount()).toBe(3);
    controller.abort();
  });

  it('rotates the long-poll slot to the task that waited', async () => {
    const { io, calls } = fakeIo();
    const scheduler = createWaitScheduler(io);
    const controller = new AbortController();
    for (const taskId of ['a', 'b', 'c']) void scheduler.watch(taskId, handlers(), controller.signal);
    await vi.advanceTimersByTimeAsync(25_000);
    // a and b answered at 25 s and queue up behind c, which has waited longest: nobody long-polls yet.
    const longPollsAfter = () =>
      calls.filter((call) => call.at >= 25_000 && call.body.timeoutMs === 25_000).map((call) => [call.taskId, call.at]);
    expect(longPollsAfter()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    // c takes a freed slot when its current short-poll sleep ends (≈25.5 s: each fake 0 ms answer adds a
    // tick); a, first in line after c, takes the other slot when its own sleep ends (26.5 s).
    const rotated = longPollsAfter();
    expect(rotated.map(([taskId]) => taskId)).toEqual(['c', 'a']);
    expect(rotated[0]![1]).toBeGreaterThanOrEqual(25_500);
    expect(rotated[0]![1]).toBeLessThan(26_500);
    expect(rotated[1]![1]).toBe(26_500);
    controller.abort();
  });

  it('follows nextSince and stops on a terminal snapshot', async () => {
    const statuses: MediaTaskStatus[] = ['running', 'running', 'done'];
    const { io, calls } = fakeIo((call) => ({
      kind: 'snapshot',
      snapshot: { ...snapshot(call.taskId, statuses[calls.length - 1] ?? 'done', calls.length * 2), progress: [`line ${calls.length}`] },
    }));
    const scheduler = createWaitScheduler(io);
    const events = handlers();
    const outcome = scheduler.watch('a', events, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    await expect(outcome).resolves.toBe('terminal');
    expect(calls.map((call) => call.body.since)).toEqual([0, 2, 4]);
    expect(events.onSnapshot).toHaveBeenCalledTimes(3);
    expect(scheduler.activeCount()).toBe(0);
  });

  it('returns gone for a 404', async () => {
    const { io } = fakeIo(() => ({ kind: 'gone' }));
    await expect(createWaitScheduler(io).watch('a', handlers(), new AbortController().signal)).resolves.toBe('gone');
  });

  it('backs off 1 s, 2 s, 4 s on network trouble and resets after a success', async () => {
    let failing = 3;
    const { io, calls } = fakeIo((call) => {
      if (failing > 0) {
        failing -= 1;
        return { kind: 'network', message: 'offline' };
      }
      return { kind: 'snapshot', snapshot: snapshot(call.taskId, 'done') };
    });
    const events = handlers();
    const outcome = createWaitScheduler(io).watch('a', events, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.map((call) => call.at)).toEqual([0]);
    await vi.advanceTimersByTimeAsync(999);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((call) => call.at)).toEqual([0, 1_000]);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.map((call) => call.at)).toEqual([0, 1_000, 3_000]);
    await vi.advanceTimersByTimeAsync(3_999);
    expect(calls).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1);
    await expect(outcome).resolves.toBe('terminal');
    expect(calls.map((call) => call.at)).toEqual([0, 1_000, 3_000, 7_000]);
    expect(events.onNetworkTrouble.mock.calls.map(([attempt]) => attempt)).toEqual([1, 2, 3]);
  });

  it('treats 5xx as trouble, gives up after the configured window, and gives up at once on other 4xx', async () => {
    const { io } = fakeIo(() => ({ kind: 'error', status: 503, message: 'busy' }));
    const outcome = createWaitScheduler(io, { giveUpAfterMs: 10_000, backoffMs: [4_000] }).watch('a', handlers(), new AbortController().signal);
    await vi.advanceTimersByTimeAsync(12_000);
    await expect(outcome).resolves.toBe('gave-up');

    const forbidden = fakeIo(() => ({ kind: 'error', status: 403, message: 'forbidden' }));
    await expect(createWaitScheduler(forbidden.io).watch('a', handlers(), new AbortController().signal)).resolves.toBe('gave-up');
  });

  it('aborts during a short-poll sleep and during an open request', async () => {
    const { io, calls } = fakeIo();
    const scheduler = createWaitScheduler(io, { maxLongPolls: 1 });
    const first = new AbortController();
    const second = new AbortController();
    const holding = scheduler.watch('a', handlers(), first.signal);
    const sleeping = scheduler.watch('b', handlers(), second.signal);
    await vi.advanceTimersByTimeAsync(500);
    second.abort(); // b sleeps before its short poll
    await expect(sleeping).resolves.toBe('aborted');
    first.abort(); // a holds an open long-poll
    await expect(holding).resolves.toBe('aborted');
    expect(calls.map((call) => call.taskId)).toEqual(['a']);
    expect(scheduler.activeCount()).toBe(0);
  });
});
