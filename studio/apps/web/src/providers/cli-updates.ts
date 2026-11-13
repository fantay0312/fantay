import type { CliUpdatesSnapshot } from '@open-design/contracts';

export async function requestCliUpdates(action: 'status' | 'check' | 'update', options: { force?: boolean; agentIds?: string[]; signal?: AbortSignal } = {}): Promise<CliUpdatesSnapshot> {
  const response = await fetch(`/api/agents/updates${action === 'check' ? '/check' : ''}`, {
    method: action === 'status' ? 'GET' : 'POST',
    signal: options.signal,
    ...(action === 'status' ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force: options.force, agentIds: options.agentIds }) }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    throw new Error(data?.error?.code === 'BUSY' ? 'busy' : 'request-failed');
  }
  return response.json();
}
