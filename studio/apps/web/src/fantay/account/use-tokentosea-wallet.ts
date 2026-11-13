import { useCallback, useEffect, useRef, useState } from 'react';
import { tokenToSeaRequest } from '../../lib/tokentosea-account';

type Wallet =
  | { state: 'loading' }
  | { state: 'ready'; usd: string }
  | { state: 'error'; message: string };

export function useTokenToSeaWallet() {
  const [wallet, setWallet] = useState<Wallet>({ state: 'loading' });
  const request = useRef<AbortController | null>(null);

  const refresh = useCallback(() => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setWallet({ state: 'loading' });
    void tokenToSeaRequest<{ availableUsd: string }>('wallet', { readSignal: controller.signal })
      .then(({ availableUsd }) => {
        if (typeof availableUsd !== 'string' || !availableUsd.trim() || !Number.isFinite(Number(availableUsd))) {
          throw new Error('Invalid TokenToSea balance');
        }
        if (!controller.signal.aborted) setWallet({ state: 'ready', usd: availableUsd });
      })
      .catch((reason: unknown) => {
        if (!controller.signal.aborted) {
          setWallet({ state: 'error', message: reason instanceof Error ? reason.message : String(reason) });
        }
      });
  }, []);

  useEffect(() => {
    refresh();
    window.addEventListener('focus', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      request.current?.abort();
    };
  }, [refresh]);

  return { wallet, refresh };
}
