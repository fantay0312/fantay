// SPDX-License-Identifier: AGPL-3.0-only
// What the 代码 surface was last asked to show, per project. Senders (the surface router in ProjectView,
// the start page, file links) call `requestCodeSurface` and then focus `WORKSPACE_CODE_TAB`; the surface
// subscribes with `useCodeSurfaceRequest` and follows the newest request. In-memory, per window.
import { useSyncExternalStore } from 'react';

import type { CodeSurfaceView } from './surface-types';

export interface CodeSurfaceRequest {
  /** Project-relative file to select; null keeps the surface's current selection. */
  file: string | null;
  /** View to switch to; null keeps the current one. */
  view: CodeSurfaceView | null;
  /** Grows with every request, so asking for the same file twice still reveals it. */
  nonce: number;
}

const requests = new Map<string, CodeSurfaceRequest>();
const listeners = new Set<() => void>();
let nonce = 0;

export function requestCodeSurface(
  projectId: string,
  request: { file?: string | null; view?: CodeSurfaceView | null } = {},
): void {
  nonce += 1;
  requests.set(projectId, { file: request.file ?? null, view: request.view ?? null, nonce });
  for (const listener of [...listeners]) listener();
}

export function readCodeSurfaceRequest(projectId: string): CodeSurfaceRequest | null {
  return requests.get(projectId) ?? null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The newest request for `projectId`, or null when nothing asked yet. */
export function useCodeSurfaceRequest(projectId: string): CodeSurfaceRequest | null {
  return useSyncExternalStore(
    subscribe,
    () => readCodeSurfaceRequest(projectId),
    () => null,
  );
}

export function resetCodeSurfaceStoreForTests(): void {
  requests.clear();
  listeners.clear();
  nonce = 0;
}
