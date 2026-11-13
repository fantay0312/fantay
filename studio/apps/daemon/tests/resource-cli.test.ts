import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { tokenToSeaCliRequestMock } = vi.hoisted(() => ({
  tokenToSeaCliRequestMock: vi.fn(),
}));

vi.mock('../src/integrations/tokentosea-cli.js', () => ({
  tokenToSeaCliRequest: tokenToSeaCliRequestMock,
}));

import { runResource } from '../src/resource-cli.js';

// `od resource` no longer shells out to a login-backed Vela CLI: the running
// Fantaydesign daemon owns TokenToSea authorization, so the CLI forwards the
// resource command to the daemon's TokenToSea bridge for one explicit
// Workspace.
describe('od resource TokenToSea compatibility entry point', () => {
  beforeEach(() => {
    process.exitCode = undefined;
    tokenToSeaCliRequestMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it('forwards resource arguments to the daemon TokenToSea bridge for the explicit workspace', async () => {
    tokenToSeaCliRequestMock.mockResolvedValue({ stdout: '{"version":3}\n' });
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);

    await runResource([
      'push',
      'project',
      'project-1',
      'relative/project-1',
      '--workspace-id',
      'ws-1',
      '--daemon-url',
      'http://127.0.0.1:7456',
      '--json',
    ]);

    expect(tokenToSeaCliRequestMock).toHaveBeenCalledWith(
      'command',
      {
        args: [
          'resource',
          'push',
          'project',
          'project-1',
          path.resolve('relative/project-1'),
          '--workspace-id',
          'ws-1',
          '--json',
        ],
        workspaceId: 'ws-1',
      },
      'http://127.0.0.1:7456',
    );
    expect(write).toHaveBeenCalledWith('{"version":3}\n');
    expect(process.exitCode).toBeUndefined();
  });

  it('shows local resource help without contacting the daemon when no subcommand is provided', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runResource([]);

    expect(tokenToSeaCliRequestMock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage: od resource'));
  });

  it('refuses to run without an explicit --workspace-id', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runResource(['shared', '--json']);

    expect(tokenToSeaCliRequestMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('An explicit --workspace-id is required');
    expect(process.exitCode).toBe(1);
  });

  it('surfaces TokenToSea bridge errors as a failed od command', async () => {
    tokenToSeaCliRequestMock.mockRejectedValue(new Error('TokenToSea is not signed in'));
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    await runResource(['shared', '--workspace-id', 'ws-1', '--json']);

    expect(error).toHaveBeenCalledWith('TokenToSea is not signed in');
    expect(process.exitCode).toBe(1);
  });
});
