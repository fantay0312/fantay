// Keep Tab inside a modal material dialog: both dialogs are aria-modal and the
// page behind them stays mounted, so Tab would otherwise walk into it.

import type { KeyboardEvent } from 'react';

export const MATERIAL_FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function trapTabWithin(event: KeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (event.key !== 'Tab' || !root) return;
  const nodes = Array.from(root.querySelectorAll<HTMLElement>(MATERIAL_FOCUSABLE));
  if (nodes.length === 0) return;
  const first = nodes[0]!;
  const last = nodes[nodes.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !root.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !root.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}
