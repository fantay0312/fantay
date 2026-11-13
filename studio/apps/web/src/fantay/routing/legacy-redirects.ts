// SPDX-License-Identifier: AGPL-3.0-only
// Legacy fork URLs → their folded homes (spec 07 §5.5, plan R9). Pure: `router.ts` keeps parsing the old
// paths (deep links, bookmarks, `od movie` links from older daemons), and `useLegacyFantayRedirects`
// rewrites them with a replace navigation. Not redirected: `/movie-app[/:id]` (the chrome-free MCP Apps
// surface) and `/canvas` (stays the page that hosts the legacy design library, R9).
import type { Route } from '../../router';
import { motionEditorRoute } from '../motion/motion-projects';

/** What runs once the app is home again. */
export type LegacyRedirectEffect =
  | { kind: 'motion-create' } // open the create dialog (empty brief)
  | { kind: 'settings'; section: 'account' }
  | { kind: 'sidebar-focus'; section: 'motion' };

export type LegacyRedirect =
  | { kind: 'route'; route: Route } // navigate(route, { replace: true })
  | { kind: 'home-then'; effect: LegacyRedirectEffect }; // navigate(home, { replace: true }), then run the effect

/** The home route every `home-then` redirect lands on. */
export const LEGACY_REDIRECT_HOME: Route = { kind: 'home', view: 'home' };

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** `?project=<id>` of an old `/movies?project=` link. */
function projectParam(search: string): string | null {
  try {
    return nonEmpty(new URLSearchParams(search).get('project'));
  } catch {
    return null;
  }
}

export function legacyFantayRedirect(route: Route, search: string): LegacyRedirect | null {
  if (route.kind !== 'home') return null;
  // /movie-app[/:id]: the MCP Apps embed stays a chrome-free page (07 §4.4).
  if (route.embeddedMovie) return null;
  // /create/animation[/:id]
  if (route.creationMode === 'movie') {
    const projectId = nonEmpty(route.movieProjectId);
    return projectId
      ? { kind: 'route', route: motionEditorRoute(projectId) }
      : { kind: 'home-then', effect: { kind: 'motion-create' } };
  }
  switch (route.view) {
    case 'movies': {
      const projectId = nonEmpty(route.movieProjectId) ?? projectParam(search);
      return projectId
        ? { kind: 'route', route: motionEditorRoute(projectId) }
        : null;
    }
    case 'materials':
      return null;
    case 'tokentosea':
      return { kind: 'home-then', effect: { kind: 'settings', section: 'account' } };
    default:
      return null;
  }
}
