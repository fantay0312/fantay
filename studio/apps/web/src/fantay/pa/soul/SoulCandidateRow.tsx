// SPDX-License-Identifier: AGPL-3.0-only
// The inline 想记下 line under the reply that proposed a memory (Soul UI spec §4.4.9): one row per pending candidate
// (at most two), 想记下：{content} · {date} with 记下 and 忽略. The text wraps, never truncates; a row fades out when its
// candidate leaves the snapshot.
import { useEffect, useRef, useState } from 'react';

import { useI18n, useT } from '../../../i18n';
import { Button, toast } from '../../ui';
import { errorToast } from '../PaTurnTail';
import { usePa } from '../pa-context';
import type { PaMemoryCandidate } from '../pa-types';
import { SoulMetaLine } from './SoulPrimitives';
import { pendingCandidates } from './soul-model';
import styles from './SoulTranscript.module.css';

const MAX_ROWS = 2;
const EXIT_MS = 160;

const dayFormats = new Map<string, Intl.DateTimeFormat>();
function shortDate(locale: string, at: number): string {
  let format = dayFormats.get(locale);
  if (!format) {
    format = new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' });
    dayFormats.set(locale, format);
  }
  return format.format(at);
}

function motionAllowed(): boolean {
  const query = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)');
  return query != null && !query.matches;
}

export function SoulCandidateRow({ messageId, name }: { messageId: string; name: string }) {
  const t = useT();
  const { locale } = useI18n();
  const { index, data } = usePa();
  const live = pendingCandidates(index, messageId).slice(0, MAX_ROWS);
  const liveKey = live.map((candidate) => candidate.id).join('|');
  const previous = useRef<PaMemoryCandidate[]>(live);
  const timers = useRef<number[]>([]);
  const [leaving, setLeaving] = useState<PaMemoryCandidate[]>([]);

  useEffect(() => {
    const gone = previous.current.filter((candidate) => !live.some((item) => item.id === candidate.id));
    previous.current = live;
    if (gone.length === 0 || !motionAllowed()) return;
    setLeaving((rows) => [...rows.filter((row) => !gone.some((item) => item.id === row.id)), ...gone]);
    timers.current.push(
      window.setTimeout(() => setLeaving((rows) => rows.filter((row) => !gone.some((item) => item.id === row.id))), EXIT_MS),
    );
    // `live` is read through its id key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  useEffect(
    () => () => {
      for (const timer of timers.current) window.clearTimeout(timer);
    },
    [],
  );

  const rows = [...live.map((candidate) => ({ candidate, closing: false })), ...leaving.map((candidate) => ({ candidate, closing: true }))];
  if (rows.length === 0) return null;

  const resolve = (candidate: PaMemoryCandidate, accept: boolean) =>
    void data.actions
      .resolveMemoryCandidate(candidate.id, candidate.revision, accept)
      .then(() => {
        if (accept) toast({ tone: 'success', title: t('pa.soul.chat.candidate.saved', { name }) });
      })
      .catch(errorToast);

  return (
    <>
      {rows.map(({ candidate, closing }) => {
        const due = candidate.kind === 'promise' && typeof candidate.dueAt === 'number' ? ` · ${shortDate(locale, candidate.dueAt)}` : '';
        return (
          <div
            key={candidate.id}
            data-testid="pa-soul-candidate"
            data-state={closing ? 'closed' : 'open'}
            className={styles.lineWrap}
            aria-hidden={closing || undefined}
          >
            <SoulMetaLine>
              <span className={styles.lineText}>
                {t('pa.soul.chat.candidate.text', { text: candidate.content })}
                {due}
              </span>
              <span className={styles.lineActions}>
                <Button variant="link" size="sm" onClick={() => resolve(candidate, true)}>
                  {t('pa.soul.chat.candidate.save')}
                </Button>
                <Button variant="link" size="sm" onClick={() => resolve(candidate, false)}>
                  {t('pa.soul.chat.candidate.dismiss')}
                </Button>
              </span>
            </SoulMetaLine>
          </div>
        );
      })}
    </>
  );
}
