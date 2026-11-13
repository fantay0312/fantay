import type { ResolvedTokenToSeaEndpoints } from './tokentosea.js';

/**
 * The single switch that points a development daemon's TokenToSea traffic at a
 * local stand-in (fake OAuth/connect plus `apps/share`). Packaged runtimes and
 * non-loopback hosts never honor it, so it cannot redirect real credentials.
 */
export const TOKENTOSEA_TEST_ORIGIN_ENV = 'OD_TOKENTOSEA_TEST_ORIGIN';

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type TokenToSeaTestOriginDecision =
  | { status: 'production' }
  | { status: 'test-origin'; origin: string; endpoints: ResolvedTokenToSeaEndpoints }
  | { status: 'ignored'; reason: 'packaged-runtime' | 'malformed' | 'not-loopback' };

/** How one test origin stands in for TokenToSea's two production hosts. */
export function tokenToSeaTestEndpoints(origin: string): ResolvedTokenToSeaEndpoints {
  return { issuer: `${origin}/api/oauth`, connectBase: `${origin}/api/v1/connect`, designBase: `${origin}/design/api` };
}

/**
 * Decide whether `OD_TOKENTOSEA_TEST_ORIGIN` may replace the production
 * TokenToSea endpoints. It applies only outside a packaged runtime, and only
 * to a bare http(s) origin whose hostname is loopback; every other present
 * value is ignored and production stays in effect.
 */
export function resolveTokenToSeaTestOrigin(value: string | undefined, { packaged }: { packaged: boolean }): TokenToSeaTestOriginDecision {
  const raw = value?.trim();
  if (!raw) return { status: 'production' };
  if (packaged) return { status: 'ignored', reason: 'packaged-runtime' };
  let url: URL;
  try { url = new URL(raw); } catch { return { status: 'ignored', reason: 'malformed' }; }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password
    || url.pathname !== '/' || url.search || url.hash || raw.includes('?') || raw.includes('#')) {
    return { status: 'ignored', reason: 'malformed' };
  }
  if (!LOOPBACK_HOSTNAMES.has(url.hostname)) return { status: 'ignored', reason: 'not-loopback' };
  return { status: 'test-origin', origin: url.origin, endpoints: tokenToSeaTestEndpoints(url.origin) };
}

/**
 * Whether this daemon runs inside a packaged app, for the seam's purposes. A
 * packaged daemon runs under Electron's node (ELECTRON_RUN_AS_NODE, so
 * process.versions.electron and resourcesPath are set) or from inside the app
 * bundle. Generic install prefixes such as /opt/ are deliberately not signals:
 * CI installs plain Node under /opt/hostedtoolcache.
 */
export function isPackagedForTestSeam({
  electron = process.versions.electron,
  resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath,
  execPath = process.execPath,
  env = process.env,
}: { electron?: string | undefined; resourcesPath?: string | undefined; execPath?: string; env?: NodeJS.ProcessEnv } = {}): boolean {
  if (electron || resourcesPath?.trim() || env.ELECTRON_RUN_AS_NODE) return true;
  const normalized = (execPath ?? '').replace(/\\/g, '/').toLowerCase();
  return normalized.includes('/contents/resources/') || normalized.includes('/resources/') || normalized.includes('app.asar');
}

/**
 * Read the seam from the daemon environment. Returns `undefined` (production
 * defaults) unless the seam is active; logs one line when it is active and one
 * warning when a present value is ignored.
 */
export function tokenToSeaEndpointsFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  packaged: boolean = isPackagedForTestSeam({ env }),
  log: Pick<Console, 'log' | 'warn'> = console,
): ResolvedTokenToSeaEndpoints | undefined {
  const decision = resolveTokenToSeaTestOrigin(env[TOKENTOSEA_TEST_ORIGIN_ENV], { packaged });
  if (decision.status === 'test-origin') {
    const { issuer, connectBase, designBase } = decision.endpoints;
    log.log(`[tokentosea] ${TOKENTOSEA_TEST_ORIGIN_ENV} active: issuer=${issuer} connect=${connectBase} design=${designBase}`);
    return decision.endpoints;
  }
  if (decision.status === 'ignored') {
    log.warn(`[tokentosea] ignoring ${TOKENTOSEA_TEST_ORIGIN_ENV} (${decision.reason}); using production TokenToSea endpoints`);
  }
  return undefined;
}
