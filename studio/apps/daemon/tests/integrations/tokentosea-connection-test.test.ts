import { afterEach, expect, it, vi } from 'vitest';
import { configureTokenToSeaRuntime } from '../../src/integrations/tokentosea-runtime.js';
import { testTokenToSeaConnection } from '../../src/integrations/tokentosea-connection-test.js';
afterEach(() => { configureTokenToSeaRuntime(undefined); });
it('does not test a model before TokenToSea authorization', async () => {
  const json = vi.fn(); configureTokenToSeaRuntime({ current: () => null, json } as never);
  expect(await testTokenToSeaConnection()).toMatchObject({ ok: false, kind: 'agent_auth_required' });
  expect(json).not.toHaveBeenCalled();
});
it('uses the listing identity and approved budget for an explicit connection test', async () => {
  const json = vi.fn(async (resource: string) => resource === 'grant' ? { perCallUsd: '0.1', remainingUsd: '1' } : { choices: [{ message: { content: 'OK' } }] });
  configureTokenToSeaRuntime({ current: () => ({ user: { id: 'test' } }), authorizationBudget: async () => 0.1, chatModels: async () => [{ id: 'listing-1', model: 'wire-model', priceVersion: 'revision-1' }], json } as never);
  expect(await testTokenToSeaConnection('wire-model')).toMatchObject({ ok: true, model: 'listing-1', sample: 'OK' });
  expect(json.mock.calls[0]?.[0]).toBe('chat/completions');
});
it('refuses a depleted grant before sending a paid model request', async () => {
  const json = vi.fn(async () => ({ perCallUsd: '0', remainingUsd: '0' }));
  configureTokenToSeaRuntime({ current: () => ({ user: { id: 'test' } }), authorizationBudget: async () => 0, chatModels: async () => [{ id: 'm' }], json } as never);
  expect(await testTokenToSeaConnection('m')).toMatchObject({ ok: false, kind: 'forbidden' });
  expect(json).not.toHaveBeenCalled();
});
