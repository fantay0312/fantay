'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original: the shared "disabled with a reason" / "busy" activation guard for Button,
 * IconButton and Chip (spec 01 §4.3). A control that explains why it is disabled stays
 * focusable (aria-disabled instead of the native attribute), so the guard has to swallow
 * activation itself.
 */
import type * as React from 'react';

export interface ActivationHandlers<E extends HTMLElement> {
  onClick?: React.MouseEventHandler<E> | undefined;
  onPointerDown?: React.PointerEventHandler<E> | undefined;
  onKeyDown?: React.KeyboardEventHandler<E> | undefined;
}

/** True for anything renderable as a reason (not `undefined`, `null`, `false` or `''`). */
export function hasReason(reason: React.ReactNode): boolean {
  return reason !== undefined && reason !== null && reason !== false && reason !== '';
}

/**
 * While `blocked`: click, pointer down and Enter/Space are prevented and never reach the caller
 * (a click also stops bubbling, as a natively disabled button dispatches none). Other keys
 * (Tab, Escape, arrows) still reach the caller's `onKeyDown`.
 */
export function guardActivation<E extends HTMLElement>(
  blocked: boolean,
  handlers: ActivationHandlers<E>,
): ActivationHandlers<E> {
  if (!blocked) return handlers;
  const callerKeyDown = handlers.onKeyDown;
  return {
    onClick: (event) => {
      event.preventDefault();
      event.stopPropagation();
    },
    onPointerDown: (event) => {
      event.preventDefault();
    },
    onKeyDown: (event) => {
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
        event.preventDefault();
        return;
      }
      callerKeyDown?.(event);
    },
  };
}
