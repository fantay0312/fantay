/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * The sidebar 记忆 badge: how many things wait for a person (open disagreements + proposals to confirm).
 * It reads `GET /api/memory-center/overview` → `inbox` at most once a minute, only while something is
 * subscribed and the window is visible. The 记忆 page reports the counts of every overview it loads, so
 * the badge follows a change there at once without an extra request. A response without `inbox` (a
 * generic fetch stub in an unrelated test) is ignored.
 */
import { useSyncExternalStore } from 'react';

import { paAccessHeader } from '../pa/pa-api';

const POLL_MS = 60_000;
/** A timer tick may land a few ms early; it must not be throttled away by its own previous read. */
const TICK_SLACK_MS = 1_000;

let pendingCount = 0;
let lastReadAt = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;

function notify(): void {
  listeners.forEach((listener) => listener());
}

export function setMemoryPendingCount(next: number): void {
  const normalized = Number.isFinite(next) && next > 0 ? Math.floor(next) : 0;
  if (normalized === pendingCount) return;
  pendingCount = normalized;
  notify();
}

/** The page loaded an overview: take its inbox counts and count it as this minute's read. */
export function reportMemoryInbox(inbox: { conflicts: number; pending: number }): void {
  lastReadAt = Date.now();
  setMemoryPendingCount(inbox.conflicts + inbox.pending);
}

export function resetMemoryPendingCountForTests(): void {
  controller?.abort();
  controller = null;
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  lastReadAt = 0;
  pendingCount = 0;
  notify();
}

function readCount(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null;
  const inbox = (body as { inbox?: unknown }).inbox;
  if (!inbox || typeof inbox !== 'object') return null;
  const { conflicts, pending } = inbox as { conflicts?: unknown; pending?: unknown };
  if (typeof conflicts !== 'number' || typeof pending !== 'number') return null;
  return conflicts + pending;
}

function poll(force: boolean): void {
  if (typeof fetch !== 'function') return;
  const now = Date.now();
  if (!force && now - lastReadAt < POLL_MS - TICK_SLACK_MS) return;
  lastReadAt = now;
  controller?.abort();
  const own = new AbortController();
  controller = own;
  void fetch('/api/memory-center/overview', { signal: own.signal, headers: paAccessHeader() })
    .then(async (res) => {
      if (!res.ok || own.signal.aborted) return;
      const count = readCount(await res.json().catch(() => null));
      if (own.signal.aborted || count === null) return;
      setMemoryPendingCount(count);
    })
    .catch(() => {});
}

function isVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function onVisibilityChange(): void {
  if (listeners.size > 0 && isVisible()) poll(false);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    if (isVisible()) poll(false);
    timer = setInterval(() => {
      if (isVisible()) poll(false);
    }, POLL_MS);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', onVisibilityChange);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
      controller?.abort();
      controller = null;
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
      }
    }
  };
}

const getSnapshot = (): number => pendingCount;

export function useMemoryPendingCount(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Reads the counts now (outside the once-a-minute rhythm), e.g. after a change made elsewhere. */
export function refreshMemoryPendingCount(): void {
  if (listeners.size > 0) poll(true);
}
