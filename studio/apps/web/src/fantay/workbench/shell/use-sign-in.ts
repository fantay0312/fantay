/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — TokenToSea sign-in from inside the workbench. The same flow as the sidebar account
 * button (shell/sidebar/SidebarFooter.tsx): ask the daemon for an authorize URL, open it in the system
 * browser, then poll until the daemon reports a session. On success the app-wide session event fires so
 * the sidebar and Settings ▸ 账户 update too.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { openHostExternalUrl } from '@open-design/host';

import { TOKENTOSEA_SESSION_CHANGED_EVENT } from '../../account/use-tokentosea-session';
import { toast } from '../../ui/toast';
import { getWorkbenchSnapshot, workbench } from '../store';

const POLL_MS = 1800;
const GIVE_UP_MS = 5 * 60 * 1000;

export function useTokenToSeaSignIn(L: (zh: string, en: string) => string, onSignedIn: () => void) {
  const [phase, setPhase] = useState<'idle' | 'starting' | 'waiting'>('idle');
  const latest = useRef(onSignedIn);
  latest.current = onSignedIn;
  const copy = useRef(L);
  copy.current = L;

  useEffect(() => {
    if (phase !== 'waiting') return undefined;
    const startedAt = Date.now();
    const timer = window.setInterval(() => {
      if (Date.now() - startedAt > GIVE_UP_MS) {
        setPhase('idle');
        return;
      }
      void workbench.refresh().then(() => {
        if (!getWorkbenchSnapshot().signedIn) return;
        setPhase('idle');
        window.dispatchEvent(new CustomEvent(TOKENTOSEA_SESSION_CHANGED_EVENT));
        toast({ title: copy.current('已登录 TokenToSea', 'Signed in to TokenToSea'), tone: 'success' });
        latest.current();
      });
    }, POLL_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  const signIn = useCallback(async () => {
    const L = copy.current;
    if (phase === 'starting') return;
    setPhase('starting');
    try {
      const response = await fetch('/api/tokentosea/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      }).catch(() => null);
      const data = response ? ((await response.json().catch(() => null)) as { authorizeUrl?: string } | null) : null;
      if (!response?.ok || !data?.authorizeUrl) {
        setPhase('idle');
        toast({
          title: L('暂时无法发起登录', 'Could not start sign-in'),
          description: L('请用左下角的账户按钮登录 TokenToSea。', 'Use the account button at the bottom of the sidebar to sign in to TokenToSea.'),
          tone: 'danger',
        });
        return;
      }
      const opened = await openHostExternalUrl(data.authorizeUrl);
      if (!opened.ok && typeof window.open === 'function') window.open(data.authorizeUrl, '_blank', 'noopener,noreferrer');
      setPhase('waiting');
    } catch {
      setPhase('idle');
    }
  }, [phase]);

  return { signIn, phase, signingIn: phase !== 'idle' };
}
