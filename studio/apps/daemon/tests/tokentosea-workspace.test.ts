import { beforeEach, describe, expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  current: vi.fn(() => ({ user: { id: 'test-user' } })),
  collaboration: vi.fn(),
  rememberWorkspace: vi.fn(),
}));

vi.mock('../src/integrations/tokentosea-runtime.js', () => ({
  tokenToSeaRuntime: () => runtime,
  optionalTokenToSeaRuntime: () => runtime,
}));

import { fetchTokenToSeaWorkspaceDirectory } from '../src/collab/tokentosea-workspace.js';

describe('TokenToSea workspace availability', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    [404, 'unsupported'],
    [401, 'unauthorized'],
    [403, 'unauthorized'],
    [503, 'upstream'],
  ] as const)('classifies the collaboration response %s without inventing an empty directory', async (status, reason) => {
    runtime.collaboration.mockRejectedValueOnce(Object.assign(new Error('unavailable'), { status }));
    await expect(fetchTokenToSeaWorkspaceDirectory()).resolves.toEqual({
      ok: false, items: [], reason, status,
    });
    expect(runtime.rememberWorkspace).not.toHaveBeenCalled();
  });
});
