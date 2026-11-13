import { buildPath, parseRoute, type Route } from '../router';

const RETURN_PATH_KEY = 'fantay.loginReturnPath.v1';
const HOME: Route = { kind: 'home', view: 'home' };

/** Keep the protected destination in this tab until sign-in finishes, including across reloads. */
export function rememberLoginReturnRoute(route: Route): void {
  if (route.kind === 'home' && route.view === 'onboarding') return;
  try {
    window.sessionStorage.setItem(RETURN_PATH_KEY, buildPath(route));
  } catch {
    // A browser that blocks storage can still sign in and open Home.
  }
}

/** Consume only an internal app route; neither external URLs nor the gate may become a return target. */
export function takeLoginReturnRoute(): Route {
  try {
    const path = window.sessionStorage.getItem(RETURN_PATH_KEY);
    window.sessionStorage.removeItem(RETURN_PATH_KEY);
    if (!path || !path.startsWith('/') || path.startsWith('//') || path.includes('\\')) return HOME;
    const route = parseRoute(path);
    return route.kind === 'home' && route.view === 'onboarding' ? HOME : route;
  } catch {
    return HOME;
  }
}
