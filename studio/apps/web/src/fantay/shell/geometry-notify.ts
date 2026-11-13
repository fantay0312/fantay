// SPDX-License-Identifier: AGPL-3.0-only
// Keeps body-portalled upstream chrome glued to the moving columns while the sidebar animates (spec 02 §6.2).
// ChatPane positions its composer portal on `resize` only (ChatPane.tsx, slot/pane ResizeObserver + window
// resize), so a horizontal move of the chat column without a resize would leave it behind: for the
// transition plus 40 ms this dispatches one synthetic `resize` per animation frame, then one more on the
// target's `transitionend`.

const SETTLE_SLACK_MS = 40;

function dispatchResize(): void {
  if (typeof window === 'undefined') return;
  window.dispatchEvent(new Event('resize'));
}

/** Returns a cancel function (stops the frame loop and drops the transitionend listener). */
export function notifyShellGeometryChange(durationMs: number, transitionTarget?: Element | null): () => void {
  if (typeof window === 'undefined') return () => undefined;
  const raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
  const cancelRaf = typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame.bind(window)
    : (handle: number) => window.clearTimeout(handle);
  const deadline = Date.now() + Math.max(0, durationMs) + SETTLE_SLACK_MS;
  let frame: number | null = null;
  let cancelled = false;

  const tick = () => {
    frame = null;
    if (cancelled) return;
    dispatchResize();
    if (Date.now() < deadline) frame = raf(tick);
  };
  frame = raf(tick);

  const onTransitionEnd = (event: Event) => {
    if (event.target !== transitionTarget) return;
    transitionTarget?.removeEventListener('transitionend', onTransitionEnd);
    if (!cancelled) dispatchResize();
  };
  transitionTarget?.addEventListener('transitionend', onTransitionEnd);

  return () => {
    cancelled = true;
    if (frame !== null) cancelRaf(frame);
    frame = null;
    transitionTarget?.removeEventListener('transitionend', onTransitionEnd);
  };
}
