import type { WorkspaceCollabContext } from '@open-design/contracts';
import { tokenToSeaRuntime } from '../integrations/tokentosea-runtime.js';
import type { WorkspaceContextProvider } from './workspace-context.js';
import { mapVelaWorkspaceContext, mapVelaWorkspaceDirectory, type WorkspaceDirectoryFetchResult } from './vela-workspace-context.js';

export async function fetchTokenToSeaWorkspaceDirectory(): Promise<WorkspaceDirectoryFetchResult> {
  const runtime = tokenToSeaRuntime();
  if (!runtime.current()?.user) return { ok: true, items: [] };
  try {
    const value = await runtime.collaboration<{ workspaces: Array<{ workspaceId: string }> }>({ operation: 'workspace.list' });
    for (const workspace of value.workspaces) runtime.rememberWorkspace(workspace.workspaceId);
    return { ok: true, items: mapVelaWorkspaceDirectory({ items: value.workspaces }) };
  } catch (error) {
    const status = (error as { status?: number }).status;
    // A deployment without the optional collaboration endpoint still supports
    // local projects and templates. Keep this distinct from both an outage and
    // a successful empty directory (which could revoke cached memberships).
    const reason = status === 401 || status === 403 ? 'unauthorized'
      : status === 404 ? 'unsupported' : 'upstream';
    return { ok: false, items: [], reason, ...(status ? { status } : {}) };
  }
}

export function createTokenToSeaWorkspaceProvider(options: { getActiveWorkspaceId?: () => string | null | undefined } = {}): WorkspaceContextProvider {
  const resolve = async (workspaceId: string | undefined): Promise<WorkspaceCollabContext | null> => {
    const runtime = tokenToSeaRuntime();
    if (!runtime.current()?.user && !workspaceId) return null;
    try {
      const id = workspaceId || (await fetchTokenToSeaWorkspaceDirectory()).items[0]?.workspaceId;
      if (!id) return null;
      return runtime.inWorkspace(id, async () => {
        const result = await runtime.collaboration({ operation: 'workspace.get', workspaceId: id });
        runtime.rememberWorkspace(id);
        return mapVelaWorkspaceContext(result);
      });
    } catch { return null; }
  };
  return { current: req => resolve(req.workspaceId ?? options.getActiveWorkspaceId?.() ?? undefined), resolveExact: req => resolve(req.workspaceId) };
}
