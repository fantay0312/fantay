// SPDX-License-Identifier: AGPL-3.0-only
// The one legacy-route redirect (spec 07 §5.5, plan R9), called once in App with the current route. It
// works with the Fantay shell on or off. Each legacy pathname+search is handled once: the URL is replaced
// (no extra history entry), and a `home-then` effect runs in a microtask after the home navigation
// commits, so the drawer/dialog/settings open on the page the user lands on.
import { useEffect, useRef } from 'react';

import { navigate, type Route } from '../../router';
import { openMotionCreate } from '../motion/motion-create-store';
import { sendWorkspaceCommand } from '../workspace/workspace-bus';
import {
  LEGACY_REDIRECT_HOME,
  legacyFantayRedirect,
  type LegacyRedirect,
  type LegacyRedirectEffect,
} from './legacy-redirects';

export interface LegacyRedirectDeps {
  /** App.openSettings: opens the Settings dialog on the section, over the home the redirect landed on. */
  openSettings: (section: 'account') => void;
}

function runLegacyEffect(effect: LegacyRedirectEffect, deps: LegacyRedirectDeps): void {
  switch (effect.kind) {
    case 'motion-create':
      openMotionCreate({ target: { kind: 'new-project' }, source: 'legacy-route' });
      return;
    case 'settings':
      deps.openSettings(effect.section);
      return;
    case 'sidebar-focus':
      // No subscriber (shell off) → nothing to focus; the user is home either way.
      sendWorkspaceCommand({ type: 'sidebar.focus', section: effect.section });
      return;
  }
}

/** Performs one redirect. Effects run only after the home navigation committed (or was already home). */
export function runLegacyRedirect(action: LegacyRedirect, readDeps: () => LegacyRedirectDeps): void {
  if (action.kind === 'route') {
    navigate(action.route, { replace: true });
    return;
  }
  let scheduled = false;
  const schedule = () => {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => runLegacyEffect(action.effect, readDeps()));
  };
  navigate(LEGACY_REDIRECT_HOME, {
    replace: true,
    onCommit: schedule,
    // A guard that rejects the navigation (or a newer one) cancels the effect too.
    onCancel: (reason) => {
      if (reason === 'same_route') schedule();
    },
  });
}

export function useLegacyFantayRedirects(route: Route, deps: LegacyRedirectDeps): void {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const pendingEffect = useRef<LegacyRedirectEffect | null>(null);
  /**
   * The legacy route already handled and its pathname+search as first seen; cleared once the route is no
   * longer legacy. The route object is compared first: the redirect rewrites `window.location` before the
   * router publishes the new route, so a re-run for the same route (Strict Mode, a re-render) must not
   * read the location again.
   */
  const handledRef = useRef<{ route: Route; key: string } | null>(null);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // A history commit precedes React's route commit. Wait for the home render
    // before opening settings: its route-dependent state must already be current.
    if (route.kind === 'home' && route.view === 'home' && !route.creationMode && pendingEffect.current) {
      const effect = pendingEffect.current;
      pendingEffect.current = null;
      handledRef.current = null;
      runLegacyEffect(effect, depsRef.current);
      return;
    }
    const handled = handledRef.current;
    if (handled?.route === route) return;
    const { pathname, search } = window.location;
    const action = legacyFantayRedirect(route, search);
    if (!action) {
      handledRef.current = null;
      return;
    }
    const key = `${pathname}${search}`;
    handledRef.current = { route, key };
    if (handled?.key === key) return;
    if (action.kind === 'home-then') {
      const effect = action.effect;
      pendingEffect.current = effect;
      navigate(LEGACY_REDIRECT_HOME, {
        replace: true,
        onCancel: (reason) => {
          if (reason !== 'same_route' && pendingEffect.current === effect) pendingEffect.current = null;
        },
      });
    } else runLegacyRedirect(action, () => depsRef.current);
  }, [route]);
}
