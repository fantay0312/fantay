import { useEffect, useState } from 'react';
import type { AiUsageSession, AiUsageSummary, WorkspaceCollabContext } from '@open-design/contracts';
import { workspaceProjectHeaders } from '../../collab/workspace-identity';

/** Read the selected session from the ledger, never from the dashboard's truncated recent list. */
export function useSessionUsage(base: AiUsageSummary, session: AiUsageSession | null, context?: WorkspaceCollabContext | null) {
  const [state, setState] = useState<{ key: string; data?: AiUsageSummary; error?: string } | null>(null);
  const key = JSON.stringify([base.scope, base.from, base.to, base.timeZone, session?.provider, session?.sessionId]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    let active = true;
    const query = new URLSearchParams({ scope: base.scope ?? 'fantay', from: base.from, to: base.to,
      timeZone: base.timeZone, provider: session.provider, sessionId: session.sessionId, limit: '1000' });
    setState(null);
    void fetch(`/api/usage?${query}`, { signal: controller.signal, headers: context ? workspaceProjectHeaders(context) : {} })
      .then(async response => {
        const data = await response.json() as AiUsageSummary & { error?: string };
        if (!response.ok) throw new Error(data.error ?? 'Usage is unavailable');
        if (active) setState({ key, data });
      })
      .catch(error => { if (active) setState({ key, error: String(error?.message ?? error) }); });
    return () => { active = false; controller.abort(); };
  }, [key, base, session, context]);
  return state?.key === key ? state : null;
}
