// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

import { TIMELINE_ORDERS, type TimelineOrder } from './timeline-model';

const DEFAULT_FOLLOWS: ReadonlySet<string> = new Set();

export function useTimelinePreferences(scope: string) {
  const prefix = `fantay.project-timeline-preferences.v1:${scope}`;
  const orderKey = `${prefix}order`;
  const followPrefix = `${prefix}follow:`;
  const [order, setOrder] = useState<TimelineOrder>('newest');
  const [follows, setFollows] = useState(DEFAULT_FOLLOWS);
  const [error, setError] = useState(false);

  useEffect(() => {
    const read = () => {
      try {
        const storage = window.localStorage;
        const storedOrder = TIMELINE_ORDERS.find(candidate => storage.getItem(orderKey) === candidate);
        const next = new Set<string>();
        for (let index = 0; index < storage.length; index += 1) {
          const key = storage.key(index);
          if (key?.startsWith(followPrefix) && storage.getItem(key) === '1') next.add(key.slice(followPrefix.length));
        }
        setOrder(storedOrder ?? 'newest');
        setFollows(next);
        setError(false);
      } catch {
        setError(true);
      }
    };
    const onStorage = (event: StorageEvent) => {
      if (!event.key || event.key === orderKey || event.key.startsWith(followPrefix)) read();
    };
    read();
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [orderKey, followPrefix]);

  function changeOrder(next: TimelineOrder) {
    setOrder(next);
    try {
      window.localStorage.setItem(orderKey, next);
      setError(false);
    } catch {
      setError(true);
    }
  }

  function toggleFollow(target: string) {
    try {
      const storage = window.localStorage;
      const key = followPrefix + target;
      const following = storage.getItem(key) !== '1';
      if (following) storage.setItem(key, '1');
      else storage.removeItem(key);
      setFollows(previous => {
        const next = new Set(previous);
        if (following) next.add(target);
        else next.delete(target);
        return next;
      });
      setError(false);
    } catch {
      setError(true);
    }
  }

  return { order, follows, error, changeOrder, toggleFollow };
}
