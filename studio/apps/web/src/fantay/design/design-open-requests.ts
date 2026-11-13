// SPDX-License-Identifier: AGPL-3.0-only
// Pending-open map (plan R10). A creation flow (NewDesignDialog, the new-from-image event) records *how*
// a not-yet-existing design path should be opened — blank, converted from a project page, imported from
// a local file, or blank plus an inserted image — and the first `DesignEditorHost` that opens that
// `(projectId, path)` takes the request and opens the document from it instead of reading bytes. After
// that host's first successful save it queues a `design` board draft (with `sourceNodeId` lineage).
// In-memory, per tab; requests expire after 10 minutes.
import type { BoardMediaFile } from '@open-design/contracts';

export type DesignOpenRequest =
  | { kind: 'blank'; title?: string; sourceNodeId?: string }
  | { kind: 'convert-html'; sourcePath: string; title?: string; sourceNodeId?: string }
  | { kind: 'import-file'; file: File; title?: string; sourceNodeId?: string }
  | { kind: 'new-from-image'; image: BoardMediaFile; title?: string; sourceNodeId?: string };

export const DESIGN_OPEN_REQUEST_TTL_MS = 10 * 60_000;

interface Entry {
  request: DesignOpenRequest;
  expiresAt: number;
}

const entries = new Map<string, Entry>();

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/^\/+/, '');
}

function keyOf(projectId: string, path: string): string {
  return `${projectId}\u0000${normalizePath(path)}`;
}

function prune(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now) entries.delete(key);
  }
}

/** Records (or replaces) the request for `(projectId, path)`. */
export function putDesignOpenRequest(projectId: string, path: string, request: DesignOpenRequest, now: number = Date.now()): void {
  prune(now);
  entries.set(keyOf(projectId, path), { request, expiresAt: now + DESIGN_OPEN_REQUEST_TTL_MS });
}

/** Returns and forgets the live request for `(projectId, path)`; null when none (or expired). */
export function takeDesignOpenRequest(projectId: string, path: string, now: number = Date.now()): DesignOpenRequest | null {
  const key = keyOf(projectId, path);
  const entry = entries.get(key);
  if (!entry) return null;
  entries.delete(key);
  return entry.expiresAt > now ? entry.request : null;
}

export function peekDesignOpenRequest(projectId: string, path: string, now: number = Date.now()): DesignOpenRequest | null {
  const entry = entries.get(keyOf(projectId, path));
  return entry && entry.expiresAt > now ? entry.request : null;
}

/** Drops the request; true when one was pending. */
export function cancelDesignOpenRequest(projectId: string, path: string): boolean {
  return entries.delete(keyOf(projectId, path));
}

export function resetDesignOpenRequestsForTests(): void {
  entries.clear();
}
