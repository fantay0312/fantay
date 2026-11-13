// @vitest-environment jsdom
//
// Regression test for "first-analytics-session marker must be consent-gated"
// (PR #5111 review). `isFirstSession()` is a pure read; the pin is written only
// by `pinFirstSessionForCapture()` on the analytics-init path that every caller
// funnels through `getAnalyticsClient`.
//
// FantayDesign ships with `FANTAY_AUTOMATIC_REPORTING_ENABLED = false`
// (packages/contracts/src/product.ts): `getAnalyticsClient` short-circuits
// before reading `/api/analytics/config`, so no daemon answer — not even an
// enabled one — may initialise PostHog or advance the first-session marker.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIRST_SESSION_KEY = 'open-design:analytics.first_session_id';

const posthogState = vi.hoisted(() => ({ initCalls: 0 }));

vi.mock('posthog-js', () => {
  const stub = {
    init: (_key: string, config: { loaded?: (i: unknown) => void }) => {
      posthogState.initCalls += 1;
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

function analyticsConfigResponse(enabled: boolean): Response {
  const body = enabled
    ? {
        enabled: true,
        env: 'local_development',
        key: 'phc_test_key',
        host: 'https://us.i.posthog.com',
        installationId: 'install-123',
      }
    : { enabled: false };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

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

describe('first-analytics-session pin is consent-gated', () => {
  const originalFetch = globalThis.fetch;
  let captureEnabled = false;

  beforeEach(() => {
    vi.resetModules();
    // jsdom in this suite does not expose a working Storage, so pin the two
    // storage surfaces the analytics identity helpers touch to fresh stubs.
    Object.defineProperty(window, 'localStorage', {
      value: createStorageStub(),
      configurable: true,
    });
    Object.defineProperty(window, 'sessionStorage', {
      value: createStorageStub(),
      configurable: true,
    });
    captureEnabled = false;
    posthogState.initCalls = 0;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/api/analytics/config')) {
        return analyticsConfigResponse(captureEnabled);
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const ctx = {
    anonymousId: 'anon-1',
    sessionId: 'sess-1',
    clientType: 'web' as const,
    locale: 'en',
    appVersion: '1.2.3',
  };

  it('does not pin the first session when capture is disabled at boot', async () => {
    const { getAnalyticsClient } = await import('../src/analytics/client');
    captureEnabled = false;
    expect(await getAnalyticsClient(ctx)).toBeNull();
    // Let getAnalyticsClient reset its cached initPromise after a null result.
    await Promise.resolve();
    expect(window.localStorage.getItem(FIRST_SESSION_KEY)).toBeNull();
  });

  it('never initialises PostHog or pins the first session while automatic reporting is off', async () => {
    const { getAnalyticsClient } = await import('../src/analytics/client');
    const { isFirstSession } = await import('../src/analytics/identity');
    // Even a daemon that reports capture enabled cannot turn reporting on.
    captureEnabled = true;
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(posthogState.initCalls).toBe(0);
    expect(window.localStorage.getItem(FIRST_SESSION_KEY)).toBeNull();
    expect(isFirstSession()).toBe(true);
  });

  it('keeps the marker unset when capture flips on later in the same session', async () => {
    const { getAnalyticsClient } = await import('../src/analytics/client');
    const { isFirstSession } = await import('../src/analytics/identity');
    captureEnabled = false;
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    captureEnabled = true;
    expect(await getAnalyticsClient(ctx)).toBeNull();
    await Promise.resolve();
    expect(posthogState.initCalls).toBe(0);
    expect(window.localStorage.getItem(FIRST_SESSION_KEY)).toBeNull();
    expect(isFirstSession()).toBe(true);
  });

  it('pins the current session once and treats a later browser session as not first', async () => {
    const { getSessionId, isFirstSession, pinFirstSessionForCapture } = await import(
      '../src/analytics/identity'
    );
    const firstSessionId = getSessionId();
    pinFirstSessionForCapture();
    expect(window.localStorage.getItem(FIRST_SESSION_KEY)).toBe(firstSessionId);
    expect(isFirstSession()).toBe(true);
    // A repeat pin in the same session never moves the marker.
    pinFirstSessionForCapture();
    expect(window.localStorage.getItem(FIRST_SESSION_KEY)).toBe(firstSessionId);
    // A later browser session (fresh session id, surviving pin) is not first.
    window.sessionStorage.clear();
    expect(getSessionId()).not.toBe(firstSessionId);
    expect(isFirstSession()).toBe(false);
  });
});
