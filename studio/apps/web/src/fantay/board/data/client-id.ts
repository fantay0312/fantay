// SPDX-License-Identifier: AGPL-3.0-only
// Per-tab board client id (spec 04 §7.1): sent as `actor.clientId` on every board write, so the store ignores its
// own `board-changed` echoes and undo only reverts entities this tab wrote last. Stored in sessionStorage; every
// storage access is guarded (private mode, blocked storage) with a per-page random fallback.
import { BOARD_CLIENT_ID_STORAGE_KEY } from './constants';

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

let pageFallback: string | null = null;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : null;
  if (cryptoApi && typeof cryptoApi.getRandomValues === 'function') {
    cryptoApi.getRandomValues(buffer);
  } else {
    for (let index = 0; index < bytes; index += 1) buffer[index] = Math.floor(Math.random() * 256);
  }
  return Array.from(buffer, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** A fresh client id (`bc_` + 24 hex chars; fits the contract's 64-char `clientId`). */
export function createBoardClientId(): string {
  return `bc_${randomHex(12)}`;
}

/** A random board entity id (`n_…` / `e_…`, 20 hex chars, like the daemon's own ids). */
export function createBoardEntityId(prefix: 'n' | 'e'): string {
  return `${prefix}_${randomHex(10)}`;
}

/** A random canvas page id. */
export function createBoardPageId(): string {
  return `page_${randomHex(8)}`;
}

export function boardClientId(): string {
  try {
    const storage = typeof window !== 'undefined' ? window.sessionStorage : undefined;
    if (storage) {
      const existing = storage.getItem(BOARD_CLIENT_ID_STORAGE_KEY);
      if (existing && CLIENT_ID_PATTERN.test(existing)) return existing;
      const created = pageFallback ?? createBoardClientId();
      storage.setItem(BOARD_CLIENT_ID_STORAGE_KEY, created);
      pageFallback = created;
      return created;
    }
  } catch {
    // Storage unavailable: fall through to the per-page id.
  }
  pageFallback ??= createBoardClientId();
  return pageFallback;
}

export function resetBoardClientIdForTests(): void {
  pageFallback = null;
  try {
    if (typeof window !== 'undefined') window.sessionStorage?.removeItem(BOARD_CLIENT_ID_STORAGE_KEY);
  } catch {
    // Ignore blocked storage in test environments.
  }
}
