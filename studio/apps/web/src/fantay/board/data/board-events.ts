// SPDX-License-Identifier: AGPL-3.0-only
// Board project bus (spec 04 §7.1, §7.3). `providers/project-events.ts` forwards the project SSE stream's
// `board-changed` frames and its `ready` handshake here, never through ProjectView's `onChange` (which would read
// an unknown event as a live-artifact refresh). Stores subscribe per project.
import { BOARD_CHANGED_SSE_EVENT, type BoardChangedSsePayload } from '@open-design/contracts';

import type { BoardProjectBusEvent } from './types';

export type { BoardProjectBusEvent } from './types';

type Listener = (event: BoardProjectBusEvent) => void;

const listenersByProject = new Map<string, Set<Listener>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emit(projectId: string, event: BoardProjectBusEvent): void {
  const listeners = listenersByProject.get(projectId);
  if (!listeners) return;
  for (const listener of [...listeners]) {
    try {
      listener(event);
    } catch (error) {
      // One failing subscriber must not break the others or the SSE handler that called us.
      if (typeof console !== 'undefined') console.warn('[fantay-board] bus listener failed', error);
    }
  }
}

/** Parses one `board-changed` SSE frame; malformed JSON and payloads of another type or project are dropped. */
export function publishBoardProjectEvent(projectId: string, rawData: string): void {
  let payload: unknown;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return;
  }
  if (!isRecord(payload)) return;
  if (payload.type !== BOARD_CHANGED_SSE_EVENT || payload.projectId !== projectId) return;
  if (typeof payload.revision !== 'number' || !Number.isFinite(payload.revision)) return;
  const actor = isRecord(payload.actor) ? payload.actor : {};
  emit(projectId, {
    type: 'board-changed',
    payload: { ...(payload as unknown as BoardChangedSsePayload), actor: actor as unknown as BoardChangedSsePayload['actor'] },
  });
}

/** The project stream (re)connected: subscribers refetch, since frames may have been missed meanwhile. */
export function notifyBoardProjectStreamReady(projectId: string): void {
  emit(projectId, { type: 'stream-ready' });
}

export function subscribeBoardProjectEvents(projectId: string, listener: Listener): () => void {
  let listeners = listenersByProject.get(projectId);
  if (!listeners) {
    listeners = new Set();
    listenersByProject.set(projectId, listeners);
  }
  listeners.add(listener);
  return () => {
    const current = listenersByProject.get(projectId);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) listenersByProject.delete(projectId);
  };
}

export function resetBoardProjectEventsForTests(): void {
  listenersByProject.clear();
}
