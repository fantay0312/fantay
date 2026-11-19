// SPDX-License-Identifier: AGPL-3.0-only
// Paced reveal of a fresh multi-bubble reply (Soul UI spec §4.4.15). Presentation only: stored state, the composer and
// the typing indicator never wait for it. Timing comes from the engine's `revealPlan`; this hook only schedules it.
// Stage 2 streaming replaces the input of the hook, so its signature is `(messageId, bubbles, enabled) → visibleCount`.
//
// Skip (the rest appears at once): `skipSoulReveal()` — called by the transcript on pointer down, key down and
// scrolling up, by the composer on key down and send — and the window losing visibility. A conversation switch
// unmounts the reply, so it never resumes half-revealed.
import { useEffect, useState, useSyncExternalStore } from 'react';
import { revealPlan, splitBubbles } from '@open-design/contracts/soul';

/* ── memoised bubble splitting (splitBubbles is quadratic on pathological input: addendum item 20) ── */

const SPLIT_CACHE_MAX = 400;
const splitCache = new Map<string, readonly string[]>();

/** `splitBubbles(text)` memoised per message id and text. */
export function soulBubbles(messageId: string, text: string): readonly string[] {
  const key = `${messageId}\u0000${text}`;
  const hit = splitCache.get(key);
  if (hit) {
    splitCache.delete(key);
    splitCache.set(key, hit);
    return hit;
  }
  const parts = Object.freeze(splitBubbles(text));
  splitCache.set(key, parts);
  if (splitCache.size > SPLIT_CACHE_MAX) {
    const oldest = splitCache.keys().next().value;
    if (oldest !== undefined) splitCache.delete(oldest);
  }
  return parts;
}

/* ── skip signal and the "still revealing" set ── */

let skipNonce = 0;
const revealing = new Set<string>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Shows every pending bubble at once (a pointer down, a key, a send, scrolling up). */
export function skipSoulReveal(): void {
  if (revealing.size === 0) return;
  skipNonce += 1;
  notify();
}

function setRevealing(messageId: string, on: boolean): void {
  if (on === revealing.has(messageId)) return;
  if (on) revealing.add(messageId);
  else revealing.delete(messageId);
  notify();
}

/** True while the reply is still being revealed: the lines under it and its tray content wait for the last bubble. */
export function useSoulRevealing(messageId: string | null): boolean {
  const read = () => (messageId ? revealing.has(messageId) : false);
  return useSyncExternalStore(subscribe, read, read);
}

function motionAllowed(): boolean {
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return query != null && !query.matches;
}

function documentVisible(): boolean {
  return typeof document === 'undefined' || document.visibilityState !== 'hidden';
}

/**
 * How many of `bubbles` are visible. `enabled` is read once, when the reply first renders: the caller passes true
 * only for a fresh reply to a send, 接着说 or 先开口 with paced appearance. Single-bubble replies, reduced motion and a
 * hidden document always show everything.
 */
export function useSoulReveal(messageId: string, bubbles: readonly string[], enabled: boolean): number {
  const total = bubbles.length;
  const [paced] = useState(() => enabled && total > 1 && motionAllowed() && documentVisible());
  const [shown, setShown] = useState(paced ? 1 : total);
  const [finished, setFinished] = useState(!paced);

  useEffect(() => {
    if (!paced || finished) return undefined;
    setRevealing(messageId, true);
    const startNonce = skipNonce;
    const offsets = revealPlan(bubbles);
    const timers = offsets.slice(1).map((offset, index) => window.setTimeout(() => setShown((count) => Math.max(count, index + 2)), offset));
    const finish = () => setFinished(true);
    const last = offsets[offsets.length - 1] ?? 0;
    timers.push(window.setTimeout(finish, last));
    const unsubscribe = subscribe(() => {
      if (skipNonce !== startNonce) finish();
    });
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') finish();
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
      setRevealing(messageId, false);
    };
    // The plan is fixed when the reply first renders; a later edit of the text shows in full.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paced, finished, messageId]);

  return finished ? total : Math.min(Math.max(1, shown), total);
}

/** Test seam. */
export function __resetSoulRevealForTests(): void {
  splitCache.clear();
  revealing.clear();
  skipNonce = 0;
  notify();
}
