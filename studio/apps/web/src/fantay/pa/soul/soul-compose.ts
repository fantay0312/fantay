// SPDX-License-Identifier: AGPL-3.0-only
// The companion composer's local state (Soul UI spec §4.5, §10.4 W3-2): the one context chip (edit or task; the reply
// chip stays in the PA draft as `replyTo`) and the pending sends shown as local bubbles until the snapshot holds the
// owner message with the same `requestId`. An external store keyed by conversation id, like `createPaDrafts`, so a
// keystroke re-renders only its subscribers; it lives for the page (drafts survive a conversation switch).
import { useCallback, useMemo, useSyncExternalStore } from 'react';

/** `restore`: the draft text the edit chip replaced, put back when the edit is cancelled or saved. */
export type SoulChip = { kind: 'edit'; messageId: string; restore?: string } | { kind: 'task' } | null;
export interface SoulPendingSend {
  requestId: string;
  text: string;
  at: number;
  failed: boolean;
  /** The quoted message of the send, kept for 重发. */
  replyTo?: string;
}

interface Entry {
  chip: SoulChip;
  pending: readonly SoulPendingSend[];
}

const EMPTY_ENTRY: Entry = Object.freeze({ chip: null, pending: Object.freeze([]) as readonly SoulPendingSend[] });
const store = new Map<string, Entry>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of [...listeners]) listener();
}

function read(conversationId: string): Entry {
  return store.get(conversationId) ?? EMPTY_ENTRY;
}

function write(conversationId: string, next: Entry): void {
  store.set(conversationId, next);
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function soulComposeChip(conversationId: string): SoulChip {
  return read(conversationId).chip;
}

export function setSoulComposeChip(conversationId: string, chip: SoulChip): void {
  const entry = read(conversationId);
  if (entry.chip === chip) return;
  write(conversationId, { ...entry, chip });
}

export function addSoulPending(conversationId: string, send: SoulPendingSend): void {
  const entry = read(conversationId);
  const rest = entry.pending.filter((item) => item.requestId !== send.requestId);
  write(conversationId, { ...entry, pending: [...rest, send] });
}

function patchPending(conversationId: string, requestId: string, patch: Partial<SoulPendingSend> | null): void {
  const entry = read(conversationId);
  if (!entry.pending.some((item) => item.requestId === requestId)) return;
  const pending =
    patch === null
      ? entry.pending.filter((item) => item.requestId !== requestId)
      : entry.pending.map((item) => (item.requestId === requestId ? { ...item, ...patch } : item));
  write(conversationId, { ...entry, pending });
}

export function useSoulCompose(conversationId: string): {
  chip: SoulChip;
  setChip(next: SoulChip): void;
  pending: readonly SoulPendingSend[];
  addPending(send: SoulPendingSend): void;
  failPending(requestId: string): void;
  dropPending(requestId: string): void;
} {
  const get = useCallback(() => read(conversationId), [conversationId]);
  const entry = useSyncExternalStore(subscribe, get, get);
  return useMemo(
    () => ({
      chip: entry.chip,
      pending: entry.pending,
      setChip: (next: SoulChip) => setSoulComposeChip(conversationId, next),
      addPending: (send: SoulPendingSend) => addSoulPending(conversationId, send),
      failPending: (requestId: string) => patchPending(conversationId, requestId, { failed: true }),
      dropPending: (requestId: string) => patchPending(conversationId, requestId, null),
    }),
    [conversationId, entry],
  );
}

/** Scrolls a transcript message into the middle of its own scroller (never the page) and flashes it. */
export function revealSoulMessage(messageId: string): void {
  if (typeof document === 'undefined') return;
  for (const node of document.querySelectorAll<HTMLElement>('[data-message-id]')) {
    if (node.dataset.messageId !== messageId) continue;
    const scroller = node.closest<HTMLElement>('[data-testid="pa-transcript"]');
    if (scroller) {
      const box = node.getBoundingClientRect();
      const frame = scroller.getBoundingClientRect();
      const top = scroller.scrollTop + (box.top - frame.top) - (scroller.clientHeight - box.height) / 2;
      scroller.scrollTo?.({ top: Math.max(0, top), behavior: 'smooth' });
    }
    node.removeAttribute('data-flash');
    void node.offsetWidth;
    node.setAttribute('data-flash', '');
    window.setTimeout(() => node.removeAttribute('data-flash'), 650);
    return;
  }
}

/** Test seam: forget every chip and pending send. */
export function __resetSoulComposeForTests(): void {
  store.clear();
  notify();
}
