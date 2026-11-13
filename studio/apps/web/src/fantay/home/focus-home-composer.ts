// SPDX-License-Identifier: AGPL-3.0-only
// Focus the Home composer after a navigation to Home (spec 02 §6.2 "new project"): the composer mounts a few
// frames later, so retry on animation frames (up to 20) until `[data-testid="home-hero-input"]` exists.

export const HOME_COMPOSER_INPUT_SELECTOR = '[data-testid="home-hero-input"]';
const MAX_FRAMES = 20;

/** Returns a cancel function. */
export function focusHomeComposer(maxFrames: number = MAX_FRAMES): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => undefined;
  const raf = typeof window.requestAnimationFrame === 'function'
    ? window.requestAnimationFrame.bind(window)
    : (callback: FrameRequestCallback) => window.setTimeout(() => callback(Date.now()), 16);
  const cancelRaf = typeof window.cancelAnimationFrame === 'function'
    ? window.cancelAnimationFrame.bind(window)
    : (handle: number) => window.clearTimeout(handle);
  let remaining = Math.max(1, maxFrames);
  let handle: number | null = null;
  const attempt = () => {
    handle = null;
    const input = document.querySelector<HTMLElement>(HOME_COMPOSER_INPUT_SELECTOR);
    if (input) {
      input.focus();
      return;
    }
    remaining -= 1;
    if (remaining > 0) handle = raf(attempt);
  };
  handle = raf(attempt);
  return () => {
    if (handle !== null) cancelRaf(handle);
    handle = null;
  };
}
