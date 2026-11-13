import { useEffect, useState } from 'react';

export interface Presence {
  /** Render the surface. */
  mounted: boolean;
  /** The surface was closed and is playing its exit: render it inert (`data-state="closed"`). */
  closing: boolean;
}

/**
 * Keeps a conditionally rendered surface mounted for one exit clock after it closes, so it fades out
 * instead of vanishing in one frame (Fantay 2026-11-08: the composer's hand-rolled menus closed
 * instantly while the Radix model / effort menus next to them faded — two ways to close side by side).
 *
 * Reopening during the exit simply cancels it. Without `matchMedia` (jsdom) or under
 * prefers-reduced-motion the surface unmounts at once, exactly as before, so behaviour that tests
 * and assistive tech rely on is unchanged there.
 */
export function usePresence(open: boolean, exitMs: number): Presence {
  const [state, setState] = useState<Presence>({ mounted: open, closing: false });
  if (open && (!state.mounted || state.closing)) {
    setState({ mounted: true, closing: false });
  } else if (!open && state.mounted && !state.closing) {
    setState(motionAllowed() ? { mounted: true, closing: true } : { mounted: false, closing: false });
  }
  useEffect(() => {
    if (!state.closing) return;
    const timer = setTimeout(() => setState({ mounted: false, closing: false }), exitMs);
    return () => clearTimeout(timer);
  }, [state.closing, exitMs]);
  return state;
}

function motionAllowed(): boolean {
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return query != null && !query.matches;
}
