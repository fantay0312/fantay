// @vitest-environment jsdom
//
// Regression test for "PostHog session replay never records FantayDesign".
//
// OpenDesign's DOM is full of sensitive content — prompts, generated artifacts,
// and BYOK provider keys — and upstream shipped replay only behind three
// redaction layers (mask every text node, mask every input, block iframes).
//
// FantayDesign ships with `FANTAY_AUTOMATIC_REPORTING_ENABLED = false`
// (packages/contracts/src/product.ts). The contract pinned here is stronger
// than masking: even when the daemon reports analytics enabled with a key and
// host, `getAnalyticsClient` never calls `posthog.init`, so no session replay,
// super-property registration or person-property flush can happen at all.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface InitConfig {
  disable_session_recording?: boolean;
  session_recording?: {
    maskAllInputs?: boolean;
    maskTextSelector?: string | null;
    blockSelector?: string | null;
    recordCrossOriginIframes?: boolean;
  };
}

let lastInitConfig: InitConfig | null = null;
let lastRegisterPayload: Record<string, unknown> | null = null;
let lastPersonProperties: Record<string, unknown> | null = null;

vi.mock('posthog-js', () => {
  const stub = {
    init: (_key: string, config: InitConfig) => {
      lastInitConfig = config;
      // posthog-js's loaded() callback fires synchronously enough for the
      // test; invoke it so the register payload path runs too.
      const loaded = (config as unknown as { loaded?: (i: unknown) => void }).loaded;
      loaded?.(stub);
      return stub;
    },
    register: (payload: Record<string, unknown>) => {
      lastRegisterPayload = payload;
    },
    setPersonProperties: (payload: Record<string, unknown>) => {
      lastPersonProperties = payload;
    },
    opt_in_capturing: () => undefined,
    opt_out_capturing: () => undefined,
    reset: () => undefined,
    identify: () => undefined,
  };
  return { default: stub };
});

describe('PostHog session replay configuration', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    lastInitConfig = null;
    lastRegisterPayload = null;
    lastPersonProperties = null;
    vi.resetModules();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url.endsWith('/api/analytics/config')) {
        return new Response(
          JSON.stringify({
            enabled: true,
            env: 'local_development',
            key: 'phc_test_key',
            host: 'https://us.i.posthog.com',
            installationId: 'install-123',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  async function initClient() {
    const { getAnalyticsClient } = await import('../src/analytics/client');
    await getAnalyticsClient({
      anonymousId: 'anon-1',
      sessionId: 'sess-1',
      clientType: 'web',
      locale: 'en',
      appVersion: '1.2.3',
    });
    return lastInitConfig;
  }

  it('never initialises PostHog, so session replay cannot start', async () => {
    const config = await initClient();
    expect(config).toBeNull();
    // The kill switch short-circuits before the daemon config read.
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('registers no telemetry super-properties', async () => {
    await initClient();
    expect(lastRegisterPayload).toBeNull();
  });

  it('never flushes staged person properties to PostHog', async () => {
    const { getAnalyticsClient, setAnalyticsPersonProperties } = await import('../src/analytics/client');
    setAnalyticsPersonProperties({
      od_app_user_id: 'usr_amr_42',
      od_source_resolved: 'social',
    });

    const client = await getAnalyticsClient({
      anonymousId: 'anon-1',
      sessionId: 'sess-1',
      clientType: 'web',
      locale: 'en',
      appVersion: '1.2.3',
    });

    expect(client).toBeNull();
    expect(lastPersonProperties).toBeNull();
  });
});
