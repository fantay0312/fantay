// SPDX-License-Identifier: AGPL-3.0-only
// The care card under an owner message the safety check marked `crisis` (Soul UI spec §4.4.13): a neutral callout on
// app tokens, never the theme. Dismissal is per device (addendum item 6): a JSON array of message ids in
// localStorage, read and written inside try/catch; without storage the card simply stays.
import { useState } from 'react';

import { useT } from '../../../i18n';
import { SoulCareFrame } from './SoulPrimitives';

const STORAGE_KEY = 'fantay.pa.care.dismissed.v1';
const MAX_REMEMBERED = 200;

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

function writeDismissed(messageId: string): void {
  try {
    const next = [...readDismissed().filter((id) => id !== messageId), messageId].slice(-MAX_REMEMBERED);
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable: the card returns next time */
  }
}

export function SoulCareCard({ messageId }: { messageId: string }) {
  const t = useT();
  const [dismissed, setDismissed] = useState(() => readDismissed().includes(messageId));
  if (dismissed) return null;
  return (
    <SoulCareFrame
      dismissLabel={t('pa.soul.chat.care.dismiss')}
      onDismiss={() => {
        writeDismissed(messageId);
        setDismissed(true);
      }}
    >
      {t('pa.soul.chat.care.body')}
    </SoulCareFrame>
  );
}
