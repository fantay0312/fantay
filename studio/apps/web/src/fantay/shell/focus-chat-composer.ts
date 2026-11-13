// SPDX-License-Identifier: AGPL-3.0-only
// Put the caret in the project's chat composer after asking for a new conversation. Arriving from another page, the
// composer mounts well after the project does, so retry on animation frames until its input can actually hold focus.

const CHAT_COMPOSER_INPUT_SELECTOR =
  '[data-testid="chat-composer"] [contenteditable="true"], [data-testid="chat-composer"] textarea';
const MAX_FRAMES = 240;

export function focusChatComposer(maxFrames: number = MAX_FRAMES): void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let remaining = Math.max(1, maxFrames);
  const attempt = () => {
    const input = document.querySelector<HTMLElement>(CHAT_COMPOSER_INPUT_SELECTOR);
    input?.focus();
    if (input && document.activeElement === input) return;
    remaining -= 1;
    if (remaining > 0) window.requestAnimationFrame(attempt);
  };
  window.requestAnimationFrame(attempt);
}
