// SPDX-License-Identifier: AGPL-3.0-only
// Fantay Soul, stage 2: the live text of a running chat reply (STAGE2 4.9, 12.1). A small module-level store, one entry
// per conversation, fed by a 250 ms poll of GET /soul/live that runs only while a chat task of the open conversation is
// running and the window is not hidden. The text is the daemon's real partial output (`liveReplyText` over what the
// runtime has streamed); nothing here invents or animates text. When the turn is stopped or fails, the entry stays as a
// labelled draft for this session only: it is never stored, and it goes when the next turn starts, when it is
// dismissed, or when the conversation's transcript unmounts.
//
// An agent chat message's id is its attempt's id (the daemon's commit creates it with `attempt.id`), so the entry is
// matched against `index.messages` by `attemptId` with no mapping.
import { useEffect, useRef, useSyncExternalStore } from 'react';
import { tokenizeRoleplay } from '@open-design/contracts/soul';

import { PaRequestError } from '../pa-api';
import type { PaActions, PaIndex, PaSoulLiveText } from '../pa-types';
import { activeChatTask } from './soul-model';

export const SOUL_LIVE_POLL_MS = 250;

/**
 * The live text as drawn: an action (`*…`) still open on the last line waits for its closing asterisk, and so does a
 * lone trailing asterisk. The stored reply draws a closed action as narration (`tokenizeRoleplay`), so the half line
 * would otherwise show a bare asterisk and then jump out of its bubble when it closes. Only a tail is held back, so
 * what is drawn stays a prefix of the stored reply.
 */
export function soulLiveDisplayText(text: string): string {
  const start = text.lastIndexOf('\n') + 1;
  const line = text.slice(start);
  if (!line.includes('*')) return text;
  if (tokenizeRoleplay(line).at(-1)?.kind !== 'text') return text;
  const closed = tokenizeRoleplay(`${line}*`).at(-1);
  const cut = closed?.kind === 'action' ? line.length + 1 - closed.text.length : line.length;
  return (text.slice(0, start) + line.slice(0, cut).replace(/\*+$/, '')).trimEnd();
}
/** Between polls after three failures in a row, until one succeeds. */
const SOUL_LIVE_BACKOFF_MS = 1000;
const SEEN_MAX = 200;

export interface SoulLiveEntry {
  attemptId: string;
  taskId: string;
  agentId: string;
  seq: number;
  text: string;
  tone: 'live' | 'stopped' | 'failed';
}

// ---- store ----

const entries = new Map<string, SoulLiveEntry>();
const listeners = new Set<() => void>();
/** Attempt ids whose live text was shown this session, oldest first (at most SEEN_MAX). */
const seenOrder: string[] = [];
const seenSet = new Set<string>();
/** The last `{ attemptId, seq }` the daemon answered per conversation, empty text included: sent as `known`. */
const cursors = new Map<string, { attemptId: string; seq: number }>();
/** The attempt per conversation for which a `live: null` already asked for one snapshot re-read. */
const refreshedFor = new Map<string, string>();
/** Set by a 404: the daemon has no live route (an older build). Polling stops for the session. */
let unsupported = false;

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function setEntry(conversationId: string, entry: SoulLiveEntry | null): void {
  const current = entries.get(conversationId) ?? null;
  if (current === entry) return;
  if (entry) entries.set(conversationId, entry);
  else entries.delete(conversationId);
  emit();
}

function markSeen(attemptId: string): void {
  if (seenSet.has(attemptId)) return;
  seenSet.add(attemptId);
  seenOrder.push(attemptId);
  while (seenOrder.length > SEEN_MAX) seenSet.delete(seenOrder.shift()!);
}

function forget(conversationId: string): void {
  cursors.delete(conversationId);
  refreshedFor.delete(conversationId);
  setEntry(conversationId, null);
}

/** The live entry of a conversation: the running reply's text so far, or the draft of a stopped or failed one. */
export function useSoulLive(conversationId: string): SoulLiveEntry | null {
  return useSyncExternalStore(
    subscribe,
    () => entries.get(conversationId) ?? null,
    () => null,
  );
}

/** True when the live text of that attempt (= the stored reply's message id) was shown this session: the stored
 *  reply then replaces it without the paced reveal and without an entrance. */
export function soulLiveSeen(messageId: string): boolean {
  return seenSet.has(messageId);
}

/** 收起: drops the draft (or the live entry) of the conversation. */
export function dismissSoulLive(conversationId: string): void {
  setEntry(conversationId, null);
}

export function __resetSoulLiveForTests(): void {
  entries.clear();
  seenOrder.length = 0;
  seenSet.clear();
  cursors.clear();
  refreshedFor.clear();
  unsupported = false;
  emit();
}

// ---- transitions ----

/** Applies one answer of GET /soul/live to the conversation's entry. */
function applyAnswer(conversationId: string, live: PaSoulLiveText | null, index: PaIndex, actions: Pick<PaActions, 'refresh'>): void {
  const current = entries.get(conversationId) ?? null;
  if (!live) {
    // The buffer ended: the reply is being stored. Keep the text until the stored message arrives, and ask for that
    // snapshot once per entry instead of waiting for the next poll.
    if (current && current.tone === 'live' && !index.messages.has(current.attemptId) && refreshedFor.get(conversationId) !== current.attemptId) {
      refreshedFor.set(conversationId, current.attemptId);
      void actions.refresh().catch(() => {});
    }
    return;
  }
  if (live.unchanged === true) return;
  cursors.set(conversationId, { attemptId: live.attemptId, seq: live.seq });
  if (index.messages.has(live.attemptId)) return; // already stored: never resurrect a reply as live text
  const text = typeof live.text === 'string' ? live.text : '';
  if (!text) {
    // Nothing visible yet (reasoning, or a restarted message): the dots stay. A restart of the shown attempt clears it.
    if (current && current.attemptId === live.attemptId) setEntry(conversationId, null);
    return;
  }
  if (current && current.tone === 'live' && current.attemptId === live.attemptId && current.seq === live.seq && current.text === text) return;
  markSeen(live.attemptId);
  setEntry(conversationId, { attemptId: live.attemptId, taskId: live.taskId, agentId: live.agentId, seq: live.seq, text, tone: 'live' });
}

/** Follows the index: a stored reply removes its entry; a task that left the snapshot (stopped) or failed turns it into
 *  a draft; an empty draft goes; a draft goes once a chat turn of the conversation is queued or running again. */
function reconcile(conversationId: string, index: PaIndex): void {
  const entry = entries.get(conversationId);
  if (!entry) return;
  if (index.messages.has(entry.attemptId)) return forget(conversationId);
  const task = index.tasks.get(entry.taskId);
  // A task being cancelled is already stopped from the owner's point of view (the poll has ended with it).
  const stopped = !task || task.status === 'cancelling' || task.status === 'cancelled';
  const tone: SoulLiveEntry['tone'] = stopped ? 'stopped' : task.status === 'failed' ? 'failed' : entry.tone;
  if (tone !== 'live') {
    if (!entry.text) return forget(conversationId);
    const active = activeChatTask(index, conversationId);
    if (active && (active.status === 'running' || active.status === 'queued')) return forget(conversationId);
  }
  if (tone !== entry.tone) setEntry(conversationId, { ...entry, tone });
}

function hidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

/** Polls GET /soul/live for the open conversation while one of its chat tasks is running (and the window is not
 *  hidden): a setTimeout chain that never overlaps, SOUL_LIVE_POLL_MS after each answer, SOUL_LIVE_BACKOFF_MS after
 *  three failures in a row. The request carries the known attempt and seq (the daemon answers `unchanged`), and is
 *  aborted on unmount and on a conversation switch. A 404 stops polling for the session (an older daemon). Unmounting
 *  removes the conversation's entry. Call once per mounted transcript. */
export function useSoulLivePoll(conversationId: string, index: PaIndex, actions: Pick<PaActions, 'readLive' | 'refresh'>): void {
  const indexRef = useRef(index);
  indexRef.current = index;
  const actionsRef = useRef(actions);
  actionsRef.current = actions;
  const active = activeChatTask(index, conversationId);
  const runningTaskId = active?.status === 'running' ? active.id : null;

  // Defined before the poll so a draft is cleared before the next turn's first request goes out.
  useEffect(() => {
    reconcile(conversationId, index);
  }, [conversationId, index]);

  useEffect(
    () => () => {
      forget(conversationId);
    },
    [conversationId],
  );

  useEffect(() => {
    if (!runningTaskId || unsupported) return undefined;
    let disposed = false;
    let failures = 0;
    let parked = false; // waiting for the window to become visible
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const schedule = (ms: number) => {
      if (disposed || unsupported) return;
      timer = setTimeout(() => void tick(), ms);
    };
    const tick = async () => {
      timer = undefined;
      if (disposed) return;
      if (hidden()) {
        parked = true;
        return;
      }
      const cursor = cursors.get(conversationId);
      try {
        const answer = await actionsRef.current.readLive(conversationId, cursor ? { attemptId: cursor.attemptId, seq: cursor.seq } : undefined, controller.signal);
        if (disposed || controller.signal.aborted) return;
        failures = 0;
        const live = answer && typeof answer === 'object' ? (answer as { live?: PaSoulLiveText | null }).live ?? null : null;
        applyAnswer(conversationId, live, indexRef.current, actionsRef.current);
      } catch (error) {
        if (disposed || controller.signal.aborted) return;
        if (error instanceof PaRequestError && error.status === 404) {
          unsupported = true;
          return;
        }
        failures += 1;
      }
      schedule(failures >= 3 ? SOUL_LIVE_BACKOFF_MS : SOUL_LIVE_POLL_MS);
    };
    const onVisibility = () => {
      if (disposed || !parked || hidden()) return;
      parked = false;
      void tick();
    };
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility);
    void tick();
    return () => {
      disposed = true;
      controller.abort();
      if (timer) clearTimeout(timer);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [conversationId, runningTaskId]);
}
