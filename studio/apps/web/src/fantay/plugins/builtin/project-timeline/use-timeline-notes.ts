// SPDX-License-Identifier: AGPL-3.0-only
import { useEffect, useState } from 'react';

import type { TimelineNote } from './timeline-model';
import { readTimelineNotes } from './timeline-storage';

const NOTES_CHANGED = 'fantay:project-timeline-notes-changed';
const EMPTY_NOTES: readonly TimelineNote[] = [];

export function notifyTimelineNotesChanged(prefix: string): void {
  window.dispatchEvent(new CustomEvent(NOTES_CHANGED, { detail: prefix }));
}

export function useTimelineNotes(prefix: string | null): { notes: readonly TimelineNote[]; error: boolean } {
  const [snapshot, setSnapshot] = useState<{ prefix: string; notes: readonly TimelineNote[]; error: boolean } | null>(null);
  useEffect(() => {
    if (!prefix) return;
    const read = () => {
      try {
        setSnapshot({ prefix, notes: readTimelineNotes(window.localStorage, prefix), error: false });
      } catch {
        setSnapshot({ prefix, notes: EMPTY_NOTES, error: true });
      }
    };
    const onStorage = (event: StorageEvent) => { if (!event.key || event.key.startsWith(prefix)) read(); };
    const onLocalChange = (event: Event) => { if ((event as CustomEvent).detail === prefix) read(); };
    read();
    window.addEventListener('storage', onStorage);
    window.addEventListener(NOTES_CHANGED, onLocalChange);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener(NOTES_CHANGED, onLocalChange);
    };
  }, [prefix]);
  return snapshot && snapshot.prefix === prefix ? snapshot : { notes: EMPTY_NOTES, error: false };
}
