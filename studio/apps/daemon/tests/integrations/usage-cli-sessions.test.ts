import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/daemon-url.js', () => ({ resolveDaemonUrl: async () => 'http://127.0.0.1:1234' }));
import { runUsageCli } from '../../src/integrations/usage-cli.js';
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('passes the session scope to the same API and preserves complete JSON output', async () => {
  const result = { scope: 'device', sessionId: 'session/with space', sessions: [{ sessionId: 'session/with space', provider: 'muse' }] };
  const fetcher = vi.fn(async () => Response.json(result)); vi.stubGlobal('fetch', fetcher);
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  await runUsageCli(['--scope', 'device', '--provider', 'muse', '--session', result.sessionId, '--json']);
  const query = new URL(String((fetcher.mock.calls as unknown[][])[0]?.[0])).searchParams;
  expect(query.get('sessionId')).toBe(result.sessionId);
  expect(query.get('provider')).toBe('muse');
  expect(query.get('scope')).toBe('device');
  expect(log).toHaveBeenCalledWith(JSON.stringify(result));
});
