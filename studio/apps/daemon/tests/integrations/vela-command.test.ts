import { beforeEach, expect, it, vi } from 'vitest';
const { command } = vi.hoisted(() => ({ command: vi.fn() }));
vi.mock('../../src/integrations/tokentosea-command.js', () => ({ runTokenToSeaCommand: command }));
import { redactVelaCommandError, runVelaCommand } from '../../src/integrations/vela-command.js';
beforeEach(() => { command.mockReset(); });
it('routes the compatibility entry to TokenToSea without a subprocess', async () => {
  command.mockResolvedValue('{"ok":true}');
  const options = { configuredEnv: { VELA_WORKSPACE_ID: 'team-one' }, timeoutMs: 1000 };
  expect(await runVelaCommand(['resource', 'head', 'one'], options)).toBe('{"ok":true}');
  expect(command).toHaveBeenCalledWith(['resource', 'head', 'one'], options);
});
it('preserves cancellation and provider failures without fabricating success', async () => {
  const failure = Object.assign(new Error('revoked'), { status: 401 }); command.mockRejectedValue(failure);
  await expect(runVelaCommand(['team-projects', 'list'])).rejects.toBe(failure);
});
it('still redacts user-entered identity text from legacy diagnostics', () => {
  const failure = new Error('command --email person@example.com --display-name Alice');
  redactVelaCommandError(failure, ['--email', 'person@example.com', '--display-name', 'Alice']);
  expect(failure.message).not.toContain('person@example.com'); expect(failure.message).not.toContain('Alice');
});
