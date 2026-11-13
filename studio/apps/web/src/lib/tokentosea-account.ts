import type { TokenToSeaStatus, WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../collab/workspace-identity';

function tokenToSeaReadSignal(signal: AbortSignal): AbortSignal {
  // Allow for a 15-second OAuth refresh before the read reaches TokenToSea.
  const deadline = AbortSignal.timeout(20_000);
  return AbortSignal.any([signal, deadline]);
}

export async function readTokenToSeaStatus(signal: AbortSignal): Promise<TokenToSeaStatus> {
  const response = await fetch('/api/tokentosea/status', {
    credentials: 'same-origin',
    signal: tokenToSeaReadSignal(signal),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const status = await response.json() as TokenToSeaStatus | null;
  if (typeof status?.signedIn !== 'boolean') throw new Error('Invalid TokenToSea status');
  return status;
}

interface TokenToSeaRequestOptions {
  body?: unknown;
  projectId?: string;
  context?: WorkspaceCollabContext | null;
  readSignal?: AbortSignal;
}

export async function tokenToSeaRequest<T>(
  resource: string,
  { body, projectId, context, readSignal }: TokenToSeaRequestOptions = {},
): Promise<T> {
  const headers = {
    ...(projectId ? { 'x-fantay-project-id': projectId } : {}),
    ...(context ? workspaceProjectHeaders(context) : {}),
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
  };
  const response = await fetch(`/api/tokentosea/service/${resource}`, {
    headers,
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    ...(readSignal ? { signal: tokenToSeaReadSignal(readSignal) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    const message = result?.error ?? result?.message;
    throw new Error(typeof message === 'string' ? message : `服务暂时不可用（${response.status}）`);
  }
  return result as T;
}

/** Save public client configuration through the daemon-owned account boundary. */
export async function configureTokenToSeaClient(clientId: string): Promise<void> {
  const response = await fetch('/api/tokentosea/configure', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientId: clientId.trim() }),
  });
  const body = await response.json().catch(() => null) as { ok?: boolean; error?: string } | null;
  if (!response.ok || body?.ok !== true) {
    throw new Error(body?.error || `HTTP ${response.status}`);
  }
}
