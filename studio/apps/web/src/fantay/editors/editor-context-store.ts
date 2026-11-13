// SPDX-License-Identifier: AGPL-3.0-only
// In-workspace editor selection → chat context (amendment C2). An editor (e.g. the design host) records
// the `WorkspaceContextItem` of its current selection per (projectId, fileName); FileWorkspace's
// `activeWorkspaceContext` reads the entry of the active editor tab. Editors clear their entry (null)
// when the selection empties or the editor unmounts.
import { useCallback, useSyncExternalStore } from 'react';
import type { WorkspaceContextItem } from '@open-design/contracts';

const contexts = new Map<string, WorkspaceContextItem>();
const listeners = new Set<() => void>();

function contextKey(projectId: string, fileName: string): string {
  return `${projectId}\u0000${fileName}`;
}

function sameItem(a: WorkspaceContextItem, b: WorkspaceContextItem): boolean {
  if (a === b) return true;
  if (a.id !== b.id) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerEditorContext(): WorkspaceContextItem | null {
  return null;
}

/** Records (or with null clears) the editor context of `fileName` in `projectId`. Equal items do not notify. */
export function setEditorContext(projectId: string, fileName: string, item: WorkspaceContextItem | null): void {
  const key = contextKey(projectId, fileName);
  const previous = contexts.get(key);
  if (item === null) {
    if (previous === undefined) return;
    contexts.delete(key);
  } else {
    if (previous !== undefined && sameItem(previous, item)) return;
    contexts.set(key, item);
  }
  emit();
}

/** Non-hook read; null when `fileName` is empty or nothing is recorded. */
export function getEditorContext(projectId: string, fileName: string | null | undefined): WorkspaceContextItem | null {
  if (!fileName) return null;
  return contexts.get(contextKey(projectId, fileName)) ?? null;
}

/** The recorded context of `fileName` (pass the active tab id; non-editor tabs simply read null). */
export function useEditorContext(projectId: string, fileName: string | null | undefined): WorkspaceContextItem | null {
  const getSnapshot = useCallback(() => getEditorContext(projectId, fileName), [projectId, fileName]);
  return useSyncExternalStore(subscribe, getSnapshot, getServerEditorContext);
}

export function resetEditorContextsForTests(): void {
  if (contexts.size === 0) return;
  contexts.clear();
  emit();
}
