// SPDX-License-Identifier: AGPL-3.0-only
// One shared 8 s poll of GET /api/pa/activity for every subscriber (sidebar row, rail, icon). The poll runs only
// while something is subscribed; refreshPaActivity() re-polls immediately (spec §3.1).
import { useSyncExternalStore } from 'react';

import { paRequest } from './pa-api';

export interface PaActivity {
  running: number;
  waiting: number;
}

const POLL_MS = 8000;
const EMPTY: PaActivity = { running: 0, waiting: 0 };

let current: PaActivity = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let controller: AbortController | null = null;

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

function poll(): void {
  controller?.abort();
  const own = new AbortController();
  controller = own;
  void paRequest<Partial<PaActivity>>('/activity', 'GET', undefined, own.signal)
    .then((value) => {
      if (own.signal.aborted) return;
      const next = { running: count(value?.running), waiting: count(value?.waiting) };
      if (next.running === current.running && next.waiting === current.waiting) return;
      current = next;
      listeners.forEach((listener) => listener());
    })
    .catch(() => {});
}

function isPageVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState === 'visible';
}

function onVisibilityChange(): void {
  if (listeners.size > 0 && isPageVisible()) poll();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (!timer) {
    if (isPageVisible()) poll();
    timer = setInterval(() => {
      if (isPageVisible()) poll();
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

const snapshot = (): PaActivity => current;

export function usePaActivity(): PaActivity {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

export function refreshPaActivity(): void {
  if (listeners.size > 0) poll();
}
