import { useEffect, useState } from 'react';
import { TOKENTOSEA_SESSION_EVENT } from '../../lib/tokentosea-events';

/** A TokenToSea account hint, never an authority assertion or a Vela membership. */
export function useShareGuideAppUserId() {
  const [account, setAccount] = useState<string | null>(null);
  useEffect(() => {
    let request = 0, disposed = false;
    const refresh = (event?: Event) => {
      // A focus re-read keeps the known hint until it settles: native save dialogs
      // restore focus before their completion, and a transient null would reset the
      // after-export guide's scope mid-save. Only an account change clears it first.
      const attempt = ++request; if (event?.type !== 'focus') setAccount(null);
      void fetch('/api/tokentosea/status', { credentials: 'same-origin' }).then(async response => {
        const status = response.ok ? await response.json() : null;
        if (disposed || attempt !== request) return;
        setAccount(status?.signedIn && typeof status.user?.id === 'string' ? status.user.id.trim() || null : null);
      }).catch(() => { if (!disposed && attempt === request) setAccount(null); });
    };
    refresh(); window.addEventListener(TOKENTOSEA_SESSION_EVENT, refresh); window.addEventListener('focus', refresh);
    return () => { disposed = true; ++request; window.removeEventListener(TOKENTOSEA_SESSION_EVENT, refresh); window.removeEventListener('focus', refresh); };
  }, []);
  return account;
}
