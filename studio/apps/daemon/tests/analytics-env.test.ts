import { describe, expect, it, vi } from 'vitest';
import { createAnalyticsService, readPosthogConfig, readPublicConfigResponse } from '../src/analytics.js';
const ctor=vi.hoisted(()=>vi.fn());
vi.mock('posthog-node',()=>({PostHog:ctor}));

describe('Fantay analytics policy',()=>{
  it.each(['local_development','qa','production'])('discloses no ingestion configuration in %s',env=>{
    const input={POSTHOG_KEY:'legacy',POSTHOG_HOST:'https://example.test',OD_TELEMETRY_ENV:env};
    expect(readPosthogConfig(input)).toBeNull();
    expect(readPublicConfigResponse(input)).toMatchObject({enabled:false,key:null,host:null});
  });
  it('never constructs an SDK for ordinary, safety, identity or group events',async()=>{
    const analytics=createAnalyticsService({dataDir:'/unused',env:{POSTHOG_KEY:'legacy'}});
    expect(await analytics.capture({eventName:'unit_event',appVersion:'1.0.0',properties:{},insertId:'test',context:{deviceId:'test',sessionId:'test',clientType:'web',locale:'en',requestId:null}})).toMatchObject({status:'not_expected',acknowledgement:'none'});
    await analytics.captureSafety({eventName:'renderer_crash',appVersion:'1.0.0',properties:{}});
    await analytics.shutdown();
    expect(ctor).not.toHaveBeenCalled();
  });
});
