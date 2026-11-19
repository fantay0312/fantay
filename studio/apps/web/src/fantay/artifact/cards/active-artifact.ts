// SPDX-License-Identifier: AGPL-3.0-only
// Which file's tab is the one in front in the side workspace, per project. The workspace publishes
// it; a product card reads it to show that it is the one on view. A module store, not a context:
// the chat and the workspace are siblings, and threading one value through the chat's props would
// touch every layer in between. Session-only, never persisted.
import { useCallback, useSyncExternalStore } from 'react';

const active = new Map<string, string>();
const listeners = new Set<() => void>();

/** Called by the workspace whenever the front tab changes; `null` when no file tab is in front. */
export function publishActiveArtifact(projectId: string, name: string | null): void {
  const previous = active.get(projectId) ?? null;
  if (previous === name) return;
  if (name === null) active.delete(projectId);
  else active.set(projectId, name);
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const none = (): null => null;

/** The project-relative name of the file whose tab is in front, or null. */
export function useActiveArtifact(projectId: string): string | null {
  const read = useCallback(() => active.get(projectId) ?? null, [projectId]);
  return useSyncExternalStore(subscribe, read, none);
}

export function resetActiveArtifactsForTests(): void {
  active.clear();
  listeners.clear();
}
