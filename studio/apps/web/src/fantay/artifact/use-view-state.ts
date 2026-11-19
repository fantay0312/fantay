// SPDX-License-Identifier: AGPL-3.0-only
// What a reader set on a file (zoom, page, sheet, view mode) outlives the viewer. Viewers other than
// web pages are unmounted when another tab comes forward and when the agent rewrites the file, and
// an update must never move the reader. So this state is kept per file in memory, outside React.
import { useCallback, useState } from 'react';

const MAX_ENTRIES = 300;
const store = new Map<string, unknown>();

function touch(key: string, value: unknown): void {
  store.delete(key);
  store.set(key, value);
  if (store.size > MAX_ENTRIES) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
}

function keyFor(projectId: string, fileName: string, slot: string): string {
  return `${projectId}\n${fileName}\n${slot}`;
}

/**
 * `useState` whose value belongs to a file, not to the mounted viewer. `slot` names the piece of
 * state ("zoom", "page"). Session-only: a reload starts fresh.
 */
export function useArtifactViewState<T>(
  projectId: string,
  fileName: string,
  slot: string,
  initial: T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const key = keyFor(projectId, fileName, slot);
  const [held, setHeld] = useState<{ key: string; value: T }>(() => ({
    key,
    value: store.has(key) ? (store.get(key) as T) : initial,
  }));
  // A viewer instance that is handed another file reads that file's state, not the previous one's.
  const current = held.key === key ? held.value : store.has(key) ? (store.get(key) as T) : initial;
  if (held.key !== key) setHeld({ key, value: current });

  const set = useCallback(
    (next: T | ((previous: T) => T)) => {
      setHeld((previous) => {
        const base = previous.key === key ? previous.value : store.has(key) ? (store.get(key) as T) : initial;
        const value = typeof next === 'function' ? (next as (previous: T) => T)(base) : next;
        touch(key, value);
        return { key, value };
      });
    },
    // `initial` is only the fallback for a file with no stored state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key],
  );

  return [current, set];
}

/** Reads a file's stored state without subscribing (for scroll positions restored on mount). */
export function readArtifactViewState<T>(projectId: string, fileName: string, slot: string): T | undefined {
  return store.get(keyFor(projectId, fileName, slot)) as T | undefined;
}

export function writeArtifactViewState(projectId: string, fileName: string, slot: string, value: unknown): void {
  touch(keyFor(projectId, fileName, slot), value);
}

/** Test seam. */
export function resetArtifactViewState(): void {
  store.clear();
}
