// SPDX-License-Identifier: AGPL-3.0-only
// Motion creation request (spec 07 §5.2 store). Home chip, home command, sidebar 视频与动画 [+], board
// insert / video-node actions, legacy `/create/animation` and the empty editor open the create dialog
// through `openMotionCreate`; `MotionCreateHost` (mounted once in App) renders it.
import { useSyncExternalStore } from 'react';

export type MotionCreateTarget = { kind: 'new-project' } | { kind: 'existing-project'; projectId: string };

export interface MotionCreateRequest {
  target: MotionCreateTarget;
  brief?: string;
  /** Home composer design system: undefined = default 'fantay', null = explicitly none (MovieStudio.tsx:250, :294-295). */
  designSystemId?: string | null;
  kind?: 'code' | 'footage';
  /**
   * Amendment C5: project-relative video paths to seed the film with (video-node "剪辑视频"), only
   * with `kind: 'footage'` and an existing-project target. The create host pre-selects them as
   * footage; when the project already has a film it imports them instead of dropping them.
   */
  footagePaths?: readonly string[];
  source: 'home-chip' | 'home-command' | 'projects-page' | 'board-insert' | 'legacy-route' | 'editor-empty';
}

let request: MotionCreateRequest | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getServerRequest(): MotionCreateRequest | null {
  return null;
}

/** Opens (or replaces) the create request; each call yields a new request object. */
export function openMotionCreate(next: MotionCreateRequest): void {
  request = {
    ...next,
    ...(next.footagePaths ? { footagePaths: Object.freeze([...next.footagePaths]) } : {}),
  };
  emit();
}

export function closeMotionCreate(): void {
  if (request === null) return;
  request = null;
  emit();
}

/** Non-hook read of the open request. */
export function getMotionCreateRequest(): MotionCreateRequest | null {
  return request;
}

export function useMotionCreateRequest(): MotionCreateRequest | null {
  return useSyncExternalStore(subscribe, getMotionCreateRequest, getServerRequest);
}

export function resetMotionCreateForTests(): void {
  closeMotionCreate();
}
