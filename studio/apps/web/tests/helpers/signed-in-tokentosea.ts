// Opt-in isolation for App tests whose subject is not account access.
// entry-chrome-flows.test.ts exercises the real session hook and status endpoint.
import { vi } from 'vitest';

vi.mock('../../src/fantay/account/use-tokentosea-session', () => {
  const state = { session: { phase: 'ready', signedIn: true }, refresh: () => {} };
  return { useTokenToSeaSession: () => state };
});
