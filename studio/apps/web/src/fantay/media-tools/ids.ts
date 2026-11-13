// SPDX-License-Identifier: AGPL-3.0-only
// Random ids for board entities the media tools create (derived image nodes, reference edges,
// generators). They satisfy the board contract's `BOARD_ID_PATTERN` (`[A-Za-z0-9_-]{3,64}`).

let fallbackCounter = 0;

/** A fresh random id (`crypto.randomUUID()` when available). */
export function newBoardEntityId(): string {
  const cryptoApi = typeof globalThis.crypto === 'object' ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') return cryptoApi.randomUUID();
  fallbackCounter += 1;
  return `fx-${Date.now().toString(36)}-${fallbackCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The `{ next() }` id source the contracts planners take. */
export function createIdSource(): { next(): string } {
  return { next: newBoardEntityId };
}
