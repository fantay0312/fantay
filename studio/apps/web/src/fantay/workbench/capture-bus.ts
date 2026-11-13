/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — quick-capture requests. The shell's ⚡ button and keyboard shortcut ask for a
 * capture; the 灵感 page owns the capture dialog and listens. Decoupled so neither imports the other.
 */
import { useEffect, useRef } from 'react';

export type QuickCaptureTab = 'note' | 'quote' | 'link' | 'file' | 'voice';
export interface QuickCaptureRequest { tab?: QuickCaptureTab; text?: string; files?: File[]; spaceId?: string | null }

const handlers = new Set<(request: QuickCaptureRequest) => void>();

/** Ask the capture dialog to open. Returns false when no listener is mounted. */
export function requestQuickCapture(request: QuickCaptureRequest = {}): boolean {
  handlers.forEach((handler) => handler(request));
  return handlers.size > 0;
}

/** Listen for capture requests (mounted once, by the 灵感 page). */
export function useQuickCaptureRequests(handler: (request: QuickCaptureRequest) => void): void {
  const latest = useRef(handler);
  latest.current = handler;
  useEffect(() => {
    const listener = (request: QuickCaptureRequest) => latest.current(request);
    handlers.add(listener);
    return () => { handlers.delete(listener); };
  }, []);
}
