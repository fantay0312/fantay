// One page-level transition at a time for the design system studio. The named pieces and their
// timing live in styles/studio-transitions.css; `kind` selects the choreography through
// `html[data-studio-vt]`. Where the View Transitions API is missing or motion is reduced the update
// simply runs, so callers never branch on it.
//
// The update must be quick. While it runs the browser paints nothing anywhere on the page, so
// anything slow (a system loading, for instance) is awaited before the transition starts, never
// inside it.
import { flushSync } from 'react-dom';

export type StudioTransitionKind = 'forward' | 'back' | 'swap' | 'expand';
// `ready` rejects when a transition is skipped. Test doubles return no `ready`, so it stays optional.
interface TransitionHandle { finished: Promise<void>; ready?: Promise<void>; skipTransition: () => void }
type TransitionDocument = Document & { startViewTransition?: (update: () => void | Promise<void>) => TransitionHandle };

let running: TransitionHandle | null = null;

/** Whether `studioViewTransition` will animate, so a caller can decide whether waiting is worth it. */
export function studioTransitionsEnabled(): boolean {
  if (typeof document === 'undefined') return false;
  const reduced = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return typeof (document as TransitionDocument).startViewTransition === 'function' && !reduced && document.visibilityState === 'visible';
}

export function studioViewTransition(kind: StudioTransitionKind, update: () => void): void {
  if (!studioTransitionsEnabled()) { update(); return; }
  const page = document as TransitionDocument;
  running?.skipTransition();
  const root = document.documentElement;
  root.dataset.studioVt = kind;
  const transition = page.startViewTransition!(() => { flushSync(update); });
  running = transition;
  void transition.ready?.catch(() => undefined);
  void transition.finished.catch(() => undefined).finally(() => {
    if (running !== transition) return;
    running = null;
    delete root.dataset.studioVt;
  });
}
