// SPDX-License-Identifier: AGPL-3.0-only
// Whether TokenToSea is signed in, for Settings ▸ 账户 (spec 07 §8). `TokenToSeaAccount` keeps its own
// status and its props unchanged (amendment B8), so the section reads the same daemon route
// (`GET /api/tokentosea/status`, identity only — no tokens reach the browser) and refreshes when that
// component reports a sign-in, when the window regains focus, and on the session event the account
// component dispatches once the concurrent TokenToSea work merges.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TokenToSeaStatus } from '@open-design/contracts';
import { readTokenToSeaStatus } from '../../lib/tokentosea-account';

/** Mirrors `TOKENTOSEA_SESSION_EVENT` of `apps/web/src/lib/tokentosea-events.ts` in the main checkout (B8:
 *  that module is not created here). Swap for the import after the merge-back. */
export const TOKENTOSEA_SESSION_CHANGED_EVENT = 'fantay:tokentosea-session-changed';

export type TokenToSeaSession =
  | { phase: 'loading' }
  | {
      phase: 'ready';
      signedIn: boolean;
      configured?: boolean;
      pending?: boolean;
      clientId?: string | null;
      redirectUri?: string;
      user?: TokenToSeaStatus['user'];
    }
  | { phase: 'error' };

export interface TokenToSeaSessionState {
  session: TokenToSeaSession;
  refresh: () => void;
}

export function useTokenToSeaSession(): TokenToSeaSessionState {
  const [session, setSession] = useState<TokenToSeaSession>({ phase: 'loading' });
  const requestRef = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    void readTokenToSeaStatus(controller.signal)
      .then((status) => {
        if (controller.signal.aborted) return;
        setSession({
          phase: 'ready',
          signedIn: status?.signedIn === true,
          configured: status?.configured === true,
          pending: status?.pending === true,
          clientId: status?.clientId ?? null,
          ...(typeof status?.redirectUri === 'string' ? { redirectUri: status.redirectUri } : {}),
          user: status?.user,
        });
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        // Keep a known answer through a transient failure; otherwise report the error.
        setSession((previous) => (previous.phase === 'ready' ? previous : { phase: 'error' }));
      });
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener(TOKENTOSEA_SESSION_CHANGED_EVENT, refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      window.removeEventListener(TOKENTOSEA_SESSION_CHANGED_EVENT, refresh);
      requestRef.current?.abort();
    };
  }, [refresh]);

  return { session, refresh };
}
