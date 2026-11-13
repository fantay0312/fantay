import express from 'express';
import { createServer } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import type { TokenToSeaIdentity } from '@fantay/tokentosea';
import { buildWorkspacePermissions, buildWorkspaceSeatSummary, type WorkspaceCollabContext } from '@open-design/contracts';
import { createCollabRuntime } from '../src/collab/runtime.js';
import { registerCollabSyncRoutes, type RegisterCollabSyncRoutesDeps } from '../src/routes/collab-sync.js';
import { tokenToSeaProjectHasPublication } from '../src/routes/tokentosea-share.js';

const cookie = { headers: { cookie: `fantay_session=${'x'.repeat(43)}` } };
function identity(shares: Array<{ documentKey: string; status?: string }> | Response, signedIn = true) {
  const share = vi.fn(async () => shares instanceof Response ? shares : Response.json({ shares }));
  const session = vi.fn(async () => signedIn ? { id: 'issuer|user', name: 'User' } : null);
  return { identity: { session, share } as unknown as Pick<TokenToSeaIdentity, 'session' | 'share'>, share };
}

describe('tokenToSeaProjectHasPublication', () => {
  it('counts an active or stopped publication of any file in the project', async () => {
    for (const status of ['active', 'stopped']) {
      const { identity: id } = identity([{ documentKey: 'project:p1:source-file', status }]);
      expect(await tokenToSeaProjectHasPublication(id, cookie, 'p1')).toBe(true);
    }
  });
  it('ignores other projects, canvases and a failed listing', async () => {
    const other = identity([{ documentKey: 'project:p10:source-file' }, { documentKey: 'canvas:p1' }]);
    expect(await tokenToSeaProjectHasPublication(other.identity, cookie, 'p1')).toBe(false);
    const failed = identity(Response.json({ error: 'outage' }, { status: 502 }));
    expect(await tokenToSeaProjectHasPublication(failed.identity, cookie, 'p1')).toBe(false);
  });
  it('never contacts the share service for a signed-out reader or an invalid project id', async () => {
    const signedOut = identity([{ documentKey: 'project:p1:source-file' }], false);
    expect(await tokenToSeaProjectHasPublication(signedOut.identity, cookie, 'p1')).toBe(false);
    expect(await tokenToSeaProjectHasPublication(signedOut.identity, { headers: {} }, 'p1')).toBe(false);
    const invalid = identity([{ documentKey: 'project:a:b:source-file' }]);
    expect(await tokenToSeaProjectHasPublication(invalid.identity, cookie, 'a:b')).toBe(false);
    expect(signedOut.share).not.toHaveBeenCalled();
    expect(invalid.share).not.toHaveBeenCalled();
  });
});

const context: WorkspaceCollabContext = {
  workspaceId: 'w', workspaceMemberId: 'owner', workspaceType: 'personal', role: 'owner',
  memberStatus: 'active', lifecycleState: 'active', billingState: 'active', planId: null, providerMode: 'platform_credits',
  seatSummary: buildWorkspaceSeatSummary({ seatLimit: 1, usedSeats: 1 }),
  permissions: buildWorkspacePermissions({ role: 'owner', lifecycleState: 'active' }),
};
async function shareState(deps: Omit<RegisterCollabSyncRoutesDeps, 'collab'>, projectId: string) {
  const runtime = createCollabRuntime({ workspaceContext: { current: async () => context } });
  const app = express();
  registerCollabSyncRoutes(app, { collab: runtime, ...deps });
  const server = createServer(app);
  try {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('no listener');
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects/${projectId}/share-state`);
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    runtime.dispose();
  }
}
const localDeps = (read: NonNullable<RegisterCollabSyncRoutesDeps['readTokenToSeaProjectShared']>) => ({
  verifyWorkspaceRequest: async () => { throw new Error('Cloud should not be required'); },
  isUnsharedLocalProject: (id: string) => id === 'local',
  authorizeLocalProjectShareRead: async () => true,
  readTokenToSeaProjectShared: read,
});

describe('GET /api/projects/:id/share-state with TokenToSea publications', () => {
  it('reports a local project shared through TokenToSea as shared, without inventing active links', async () => {
    const read = vi.fn(async () => true);
    const result = await shareState(localDeps(read), 'local');
    expect(result).toEqual({ status: 200, body: { projectId: 'local', bindingExists: true, hasEverShared: true, publications: [] } });
    expect(read).toHaveBeenCalledWith(expect.anything(), 'local');
  });
  it.each([
    ['never shared', async (): Promise<boolean> => false],
    ['an unreachable TokenToSea read', async (): Promise<boolean> => { throw new Error('upstream down'); }],
  ] as const)('keeps a proven-unshared local project unshared for %s', async (_case, read) => {
    const result = await shareState(localDeps(read), 'local');
    expect(result).toEqual({ status: 200, body: { projectId: 'local', bindingExists: false, hasEverShared: false, publications: [] } });
  });
  it('augments a successful workspace history read and keeps its publications', async () => {
    const result = await shareState({
      verifyWorkspaceRequest: async () => context,
      readProjectShareState: async scope => ({ projectId: scope.projectId, bindingExists: false, hasEverShared: false, publications: [] }),
      readTokenToSeaProjectShared: async () => true,
    }, 'p');
    expect(result).toEqual({ status: 200, body: { projectId: 'p', bindingExists: true, hasEverShared: true, publications: [] } });
  });
  it('never turns a failed workspace history read into a known history', async () => {
    const result = await shareState({
      verifyWorkspaceRequest: async () => context,
      readProjectShareState: async () => { throw new Error('unavailable'); },
      readTokenToSeaProjectShared: async () => true,
    }, 'p');
    expect(result).toEqual({ status: 503, body: { error: 'SHARE_STATE_UNAVAILABLE' } });
  });
});
