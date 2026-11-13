// SPDX-License-Identifier: AGPL-3.0-only
// React views of the frame registry's Edit and Capture sessions for the chrome (context bar, capture highlight,
// Edit panel): they follow the session the registry currently holds and its state changes (server snapshot: B2).
import { useCallback, useSyncExternalStore } from 'react';

import type { FrameRegistry } from '../nodes/frame/frame-registry';
import type { FrameCaptureState } from '../nodes/frame/use-frame-capture';
import type { FrameEditSession, FrameEditSessionState } from '../nodes/frame/use-frame-edit-session';

/** Subscribes to the registry and to whichever session `current()` returns at the time. */
function useSessionSubscription<S extends { subscribe(listener: () => void): () => void }>(
  registry: FrameRegistry,
  current: () => S | null,
): (listener: () => void) => () => void {
  return useCallback(
    (listener: () => void) => {
      let session: S | null = null;
      let off: (() => void) | null = null;
      const attach = (): void => {
        const next = current();
        if (next === session) return;
        off?.();
        session = next;
        off = next ? next.subscribe(listener) : null;
      };
      attach();
      const offRegistry = registry.subscribe(() => {
        attach();
        listener();
      });
      return () => {
        offRegistry();
        off?.();
      };
    },
    // `current` reads the registry only
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [registry],
  );
}

/** The capture session state of `nodeId` (or of any node when null); null without a session. */
export function useCaptureState(registry: FrameRegistry, nodeId: string | null): FrameCaptureState | null {
  const subscribe = useSessionSubscription(registry, () => registry.captureSession());
  const read = (): FrameCaptureState | null => {
    const session = registry.captureSession();
    if (!session || (nodeId !== null && session.nodeId !== nodeId)) return null;
    return session.getState();
  };
  return useSyncExternalStore(subscribe, read, read);
}

/** The running Edit session and its state; null without one. */
export function useEditSession(registry: FrameRegistry): { session: FrameEditSession; state: FrameEditSessionState } | null {
  const subscribe = useSessionSubscription(registry, () => registry.editSession());
  const readSession = (): FrameEditSession | null => registry.editSession();
  const readState = (): FrameEditSessionState | null => registry.editSession()?.getState() ?? null;
  const session = useSyncExternalStore(subscribe, readSession, readSession);
  const state = useSyncExternalStore(subscribe, readState, readState);
  return session && state ? { session, state } : null;
}
