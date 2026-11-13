import { afterEach, expect, it, vi } from 'vitest';
import { runAgentUpdateCli } from '../../src/runtimes/cli-update-cli.js';
const exitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); process.exitCode = exitCode; });
it('reports a top-level discovery failure as an unsuccessful CLI check', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ checking: false, lastCheckedAt: null, items: [], error: 'check-failed' }))));
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  await runAgentUpdateCli({ base: 'http://127.0.0.1:1', action: 'updates', check: true, wait: true });
  expect(process.exitCode).toBe(1);
  expect(error).toHaveBeenCalledWith('CLI update check failed. Try again.');
});
