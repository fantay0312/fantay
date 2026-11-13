// SPDX-License-Identifier: AGPL-3.0-only
// The board's own part of the workspace header row (spec 02 §7.5): FileWorkspace renders the header outside the
// board's providers, so the row holds an empty slot and the board portals its page tabs and panel toggles into it.
import { useSyncExternalStore } from 'react';

let slot: HTMLElement | null = null;
const listeners = new Set<() => void>();

function setSlot(element: HTMLElement | null): void {
  if (element === slot) return;
  slot = element;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoardHeaderSlot(): HTMLElement | null {
  return useSyncExternalStore(subscribe, () => slot, () => null);
}

export function BoardHeaderSlot() {
  return <div ref={setSlot} className="fx flex min-w-0 flex-1 items-center" data-testid="fantay-board-header-slot" />;
}
