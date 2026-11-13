// SPDX-License-Identifier: AGPL-3.0-only
// A clock that ticks once a second while `active` (elapsed time of running generations, spec 05 §5.7).
import { useEffect, useState } from 'react';

export function useNow(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
  return now;
}
