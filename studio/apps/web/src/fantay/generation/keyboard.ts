// SPDX-License-Identifier: MIT
// Derived from infinite-canvas (https://github.com/basketikun/infinite-canvas),
// commit 9cd3deacbcc598361807afc16c059a80dd18b6f9, web/src/lib/keyboard-event.ts.
// Copyright (c) 2026 basketikun. Released under the MIT License; the full
// license text is reproduced in THIRD_PARTY_NOTICES.md.
// Modified for Fantay on 2026-10-29: added isSubmitShortcut (⌘/Ctrl+Enter submits; plain Enter is a newline).

type NativeKeyboardEventLike = {
  isComposing?: boolean;
  keyCode?: number;
  which?: number;
};

export type KeyboardEventLike = NativeKeyboardEventLike & {
  key?: string;
  shiftKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
  nativeEvent?: NativeKeyboardEventLike;
};

/** True while an IME composition is in progress (keyCode 229 covers browsers that do not set `isComposing`). */
export function isImeComposing(event: KeyboardEventLike): boolean {
  const nativeEvent = event.nativeEvent;
  return Boolean(
    event.isComposing ||
      nativeEvent?.isComposing ||
      event.keyCode === 229 ||
      event.which === 229 ||
      nativeEvent?.keyCode === 229 ||
      nativeEvent?.which === 229,
  );
}

/** Enter without modifiers and outside an IME composition. */
export function isPlainEnterKey(event: KeyboardEventLike): boolean {
  return event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !isImeComposing(event);
}

/**
 * ⌘/Ctrl+Enter outside an IME composition: runs a generation. Plain Enter inserts a newline because a run
 * costs money (spec 05 §5.3).
 */
export function isSubmitShortcut(event: KeyboardEventLike): boolean {
  return event.key === 'Enter' && Boolean(event.metaKey || event.ctrlKey) && !event.altKey && !isImeComposing(event);
}
