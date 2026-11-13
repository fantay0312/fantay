// SPDX-License-Identifier: AGPL-3.0-only
// Long-poll budget for media tasks (spec 05 §4.5). Browsers keep 6 HTTP/1.1 connections per origin and the
// chat SSE stream plus board saves must keep working while several videos generate, so at most
// `maxLongPolls` tasks hold a 25 s long-poll at a time; the others short-poll (`timeoutMs: 0`) every 1.5 s.
// Slots are released after every request and handed to the task that has waited longest, so tasks rotate.
import {
  MEDIA_TASK_WAIT_MAX_TIMEOUT_MS,
  isTerminalMediaTaskStatus,
  type MediaTaskSnapshotResponse,
  type MediaTaskWaitRequest,
} from '@open-design/contracts';

import type { WaitResult } from './dispatch';

export interface WaitSchedulerOptions {
  /** Concurrent long-polls (2). */
  maxLongPolls: number;
  /** Long-poll `timeoutMs` (25 000, the daemon cap). */
  longPollTimeoutMs: number;
  /** Delay before a short poll when no long-poll slot is free (1 500). */
  shortPollIntervalMs: number;
  /** Backoff after the n-th consecutive failure (index n-1, the last value repeats). */
  backoffMs: number[];
  /** Give up after this long of continuous failures (600 000). */
  giveUpAfterMs: number;
}

export const DEFAULT_WAIT_SCHEDULER_OPTIONS: WaitSchedulerOptions = Object.freeze({
  maxLongPolls: 2,
  longPollTimeoutMs: MEDIA_TASK_WAIT_MAX_TIMEOUT_MS,
  shortPollIntervalMs: 1_500,
  backoffMs: [1_000, 2_000, 4_000, 8_000, 10_000],
  giveUpAfterMs: 600_000,
}) as WaitSchedulerOptions;

export interface WaitHandlers {
  onSnapshot(s: MediaTaskSnapshotResponse): void;
  onNetworkTrouble(attempt: number): void;
}

export type WaitOutcome = 'terminal' | 'gone' | 'aborted' | 'gave-up';

export interface WaitScheduler {
  watch(taskId: string, handlers: WaitHandlers, signal: AbortSignal): Promise<WaitOutcome>;
  /** Watches in progress. */
  activeCount(): number;
}

export interface WaitSchedulerClock {
  now(): number;
  /** Resolves after `ms`, or early (without throwing) when `signal` aborts. */
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}

export const realWaitSchedulerClock: WaitSchedulerClock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal.addEventListener('abort', onAbort, { once: true });
    }),
};

export function createWaitScheduler(
  io: { waitTask(taskId: string, body: MediaTaskWaitRequest, signal: AbortSignal): Promise<WaitResult> },
  options?: Partial<WaitSchedulerOptions>,
  clock: WaitSchedulerClock = realWaitSchedulerClock,
): WaitScheduler {
  const config: WaitSchedulerOptions = { ...DEFAULT_WAIT_SCHEDULER_OPTIONS, ...options };
  const maxLongPolls = Math.max(0, Math.floor(config.maxLongPolls));
  const backoff = config.backoffMs.length > 0 ? config.backoffMs : DEFAULT_WAIT_SCHEDULER_OPTIONS.backoffMs;
  let slotsInUse = 0;
  let active = 0;
  /** Watches that asked for a long-poll slot and did not get one, oldest first. */
  const queue: object[] = [];

  /** Non-blocking: a free slot goes to the head of the queue (or to anyone when nobody waits). */
  function tryAcquire(token: object): boolean {
    if (slotsInUse >= maxLongPolls) {
      if (!queue.includes(token)) queue.push(token);
      return false;
    }
    const position = queue.indexOf(token);
    if (queue.length > 0 && position !== 0) {
      if (position < 0) queue.push(token);
      return false;
    }
    if (position === 0) queue.shift();
    slotsInUse += 1;
    return true;
  }

  function leaveQueue(token: object): void {
    const position = queue.indexOf(token);
    if (position >= 0) queue.splice(position, 1);
  }

  async function watch(taskId: string, handlers: WaitHandlers, signal: AbortSignal): Promise<WaitOutcome> {
    const token = {};
    let since = 0;
    let failures = 0;
    let troubleSince: number | null = null;
    active += 1;
    try {
      for (;;) {
        if (signal.aborted) return 'aborted';
        let longPoll = tryAcquire(token);
        if (!longPoll) {
          await clock.sleep(config.shortPollIntervalMs, signal);
          if (signal.aborted) return 'aborted';
          // A slot may have freed while this watch slept.
          longPoll = tryAcquire(token);
        }
        let result: WaitResult;
        try {
          result = await io.waitTask(taskId, { since, timeoutMs: longPoll ? config.longPollTimeoutMs : 0 }, signal);
        } finally {
          if (longPoll) slotsInUse -= 1;
        }
        if (result.kind === 'aborted' || signal.aborted) return 'aborted';
        if (result.kind === 'gone') return 'gone';
        if (result.kind === 'snapshot') {
          failures = 0;
          troubleSince = null;
          since = result.snapshot.nextSince;
          handlers.onSnapshot(result.snapshot);
          if (isTerminalMediaTaskStatus(result.snapshot.status)) return 'terminal';
          continue;
        }
        // A 4xx other than 404 cannot be waited out (lost authority, bad request).
        if (result.kind === 'error' && result.status >= 400 && result.status < 500) return 'gave-up';
        failures += 1;
        const now = clock.now();
        troubleSince ??= now;
        if (now - troubleSince >= config.giveUpAfterMs) return 'gave-up';
        handlers.onNetworkTrouble(failures);
        await clock.sleep(backoff[Math.min(failures - 1, backoff.length - 1)] ?? 10_000, signal);
      }
    } finally {
      leaveQueue(token);
      active -= 1;
    }
  }

  return {
    watch,
    activeCount: () => active,
  };
}
