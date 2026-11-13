// SPDX-License-Identifier: AGPL-3.0-only
// Board camera snapshot for the workspace header zoom menu (spec 02 §5.6, plan R7). The board engine
// publishes on settle while active (≤ 10/s) and publishes null when inactive or unmounted.
import { useSyncExternalStore } from 'react';

export interface FantayBoardViewportSnapshot { projectId: string; zoom: number; minZoom: number; maxZoom: number }

let current: FantayBoardViewportSnapshot | null = null;
const listeners = new Set<() => void>();

function sameSnapshot(a: FantayBoardViewportSnapshot | null, b: FantayBoardViewportSnapshot | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.projectId === b.projectId && a.zoom === b.zoom && a.minZoom === b.minZoom && a.maxZoom === b.maxZoom;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerBoardViewport(): FantayBoardViewportSnapshot | null {
  return null;
}

/** The board engine calls this on settle while active; null clears (inactive / unmounted). */
export function publishBoardViewport(snapshot: FantayBoardViewportSnapshot | null): void {
  if (sameSnapshot(current, snapshot)) return;
  current = snapshot
    ? Object.freeze({ projectId: snapshot.projectId, zoom: snapshot.zoom, minZoom: snapshot.minZoom, maxZoom: snapshot.maxZoom })
    : null;
  for (const listener of [...listeners]) listener();
}

/** Non-hook read of the last published snapshot (any project). */
export function getBoardViewport(): FantayBoardViewportSnapshot | null {
  return current;
}

/** Snapshot for `projectId`; null when nothing is published or another project's board published it. */
export function useBoardViewport(projectId: string): FantayBoardViewportSnapshot | null {
  const snapshot = useSyncExternalStore(subscribe, getBoardViewport, getServerBoardViewport);
  return snapshot !== null && snapshot.projectId === projectId ? snapshot : null;
}

export function resetBoardViewportForTests(): void {
  publishBoardViewport(null);
}
