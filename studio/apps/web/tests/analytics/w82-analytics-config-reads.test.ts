// @vitest-environment jsdom
//
// Red-spec (W82 item 4): `GET /api/analytics/config` was read 4-5 times on one
// cold conversation open. Measured in a real browser with `window.fetch`
// wrapped to record `new Error().stack`:
//
//   t=1988  bootstrapExceptionTracking  ← AnalyticsProvider.useEffect
//   t=4394  getAnalyticsClient          ← AnalyticsProvider.useMemo[value]  (setConsent)
//   t=5074  getAnalyticsClient          ← AnalyticsProvider.useCallback[track]
//   t=5970  getAnalyticsClient          ← AnalyticsProvider.useCallback[track]
//
// The first two are the two legitimate owners and they already share one
// in-flight read (ttl-0 `coalescedGet`, `fetchAnalyticsConfigShared`). The
// repeats are the last two: `getAnalyticsClient` deliberately drops its
// memoised init promise whenever it resolves to `null`, so that a later opt-in
// can retry — which also means EVERY `track()` call re-reads the endpoint for
// the whole life of a session where analytics is off. That is every user who
// declined the privacy toggle, and every dev build (no `POSTHOG_KEY` → the
// daemon answers `enabled:false, key:null`).
//
// The invariant pinned here: the retry belongs to the EVENT that can change
// the answer, not to every caller.
//   * before the app has applied a consent decision, a null answer is
//     provisional and the next caller may re-read (boot ordering);
//   * once a consent decision has been applied, only a fresh GRANT reopens it;
//   * `applyConsent(true)` still produces exactly one fresh read, so opting in
//     later in the same session still initialises the client.
//
// This is not a cache: nothing retains a config BODY. What is retained is the
// module's own resolved `PostHog | null` handle, which is what the non-null
// branch already did.
//
// FantayDesign ships with `FANTAY_AUTOMATIC_REPORTING_ENABLED = false`
// (packages/contracts/src/product.ts), which makes the budget strictly smaller:
// both owners short-circuit before the shared read, so a session reads the
// endpoint ZERO times — at boot, on every `track()`, and across any number of
// consent grants. The cases below pin that zero against the same event
// sequences the per-event budget was written for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const posthogState = vi.hoisted(() => ({ initShouldThrow: false }));

vi.mock('posthog-js', () => {
  const stub = {
    init: (_key: string, config: { loaded?: (i: unknown) => void }) => {
      if (posthogState.initShouldThrow) throw new Error('posthog init failed');
      config.loaded?.(stub);
      return stub;
    },
    register: () => undefined,
    setPersonProperties: () => undefined,
    opt_in_capturing: () => undefined,
    opt_out_capturing: () => undefined,
    reset: () => undefined,
    identify: () => undefined,
  };
  return { default: stub };
});

function createStorageStub(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

const ctx = {
  anonymousId: 'anon-1',
  sessionId: 'sess-1',
  clientType: 'web' as const,
  locale: 'en',
  appVersion: '1.2.3',
};

describe('/api/analytics/config is read once per event that can change it', () => {
  const originalFetch = globalThis.fetch;
  let captureEnabled = false;
  let configReads = 0;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(window, 'localStorage', {
      value: createStorageStub(),
      configurable: true,
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: createStorageStub(),
      configurable: true,
    });
    captureEnabled = false;
    configReads = 0;
    posthogState.initShouldThrow = false;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/api/analytics/config')) {
        configReads += 1;
        const body = captureEnabled
          ? {
              enabled: true,
              env: 'local_development',
              key: 'phc_test_key',
              host: 'https://us.i.posthog.com',
              installationId: 'install-123',
            }
          : { enabled: false, env: 'development', key: null, host: null };
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('issues no read from the exception bootstrap or the client init', async () => {
    const { bootstrapExceptionTracking, getAnalyticsClient } = await import(
      '../../src/analytics/client'
    );
    // Even a daemon that would answer "enabled" is never asked.
    captureEnabled = true;
    const bootstrap = bootstrapExceptionTracking(ctx);
    const init = getAnalyticsClient(ctx);
    const [, client] = await Promise.all([bootstrap, init]);

    expect(client).toBeNull();
    expect(configReads).toBe(0);
  });

  it('does not read on boot or on any track() once consent has been decided', async () => {
    const { applyConsent, getAnalyticsClient } = await import('../../src/analytics/client');
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();

    // App applies the persisted decision (Privacy → metrics off).
    applyConsent(false);
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();

    // Every later track() funnels through getAnalyticsClient; none may cost a
    // request — this is the part that used to grow without bound.
    for (let i = 0; i < 5; i += 1) {
      expect(await getAnalyticsClient(ctx)).toBeNull();
      await Promise.resolve();
    }

    expect(configReads).toBe(0);
  });

  it('stays at zero reads when the user opts in later in the same session', async () => {
    // A grant used to reopen exactly one read. With automatic reporting off it
    // must not reopen anything: the client stays null and the daemon is never
    // asked, however many track() calls follow.
    const { applyConsent, getAnalyticsClient } = await import('../../src/analytics/client');
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    applyConsent(false);
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();

    captureEnabled = true;
    applyConsent(true);
    expect(await getAnalyticsClient(ctx)).toBeNull();
    expect(await getAnalyticsClient(ctx)).toBeNull();
    expect(await getAnalyticsClient(ctx)).toBeNull();
    expect(configReads).toBe(0);
  });

  it('stays at zero reads across an off/on toggle', async () => {
    const { applyConsent, getAnalyticsClient } = await import('../../src/analytics/client');
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    applyConsent(false);

    applyConsent(true);
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();

    applyConsent(false);
    applyConsent(true);
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    expect(configReads).toBe(0);
  });
});
