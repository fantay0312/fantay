// SPDX-License-Identifier: AGPL-3.0-only
// Reconcile modal (addendum §C): check an interrupted / unconfirmed run automatically; when the adapter
// cannot confirm it (409 PA_RECOVERY_REQUIRED), reveal the owner-confirmed form in the same modal.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { Button, Callout, CheckboxField, Field, Textarea } from '../ui';
import { isExecutorRunning, isRecoveryRequired } from './pa-api';
import { usePa } from './pa-context';
import { PaModalFrame, paErrorText, usePaModalReset } from './PaAgentModal';
import styles from './PaModals.module.css';

const NOTE_MIN = 3;
const NOTE_MAX = 500;

export function PaReconcileModal({ open, onClose, taskId }: { open: boolean; onClose(): void; taskId: string }) {
  const t = useT();
  const { data, index } = usePa();
  const task = index.tasks.get(taskId) ?? null;
  const [manual, setManual] = useState(false);
  // What the last check found: the daemon's own words, shown with the step they lead to.
  const [finding, setFinding] = useState<{ running: boolean; message: string } | null>(null);
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState<'auto' | 'manual' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const noteId = useId();
  usePaModalReset(open, taskId, () => {
    setManual(false);
    setFinding(null);
    setNote('');
    setConfirmed(false);
    setBusy(null);
    setError(null);
  });

  const run = async (mode: 'auto' | 'manual') => {
    if (busy || !task) return;
    setBusy(mode);
    setError(null);
    try {
      await data.actions.reconcileTask(taskId, mode === 'manual' ? { note: note.trim() } : undefined);
      onClose();
    } catch (caught) {
      const message = paErrorText(caught, t);
      if (isExecutorRunning(caught)) {
        // Nothing to confirm while the old run is alive: hide the form and offer another check.
        setManual(false);
        setFinding({ running: true, message });
      } else if (mode === 'auto' && isRecoveryRequired(caught)) {
        setManual(true);
        setFinding({ running: false, message });
      } else setError(message);
    } finally {
      setBusy(null);
    }
  };

  const noteLength = note.trim().length;
  const canConfirm = confirmed && noteLength >= NOTE_MIN && note.length <= NOTE_MAX;

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="md"
      title={t('pa.reconcile')}
      lede={t('pa.reconcileHelp')}
      error={error}
      onSubmit={() => void run(manual ? 'manual' : 'auto')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          {manual ? (
            <>
              <Button variant="default" loading={busy === 'auto'} disabled={!task || busy === 'manual'} onClick={() => void run('auto')}>
                {t('pa.reconcileAuto')}
              </Button>
              <Button type="submit" variant="primary" loading={busy === 'manual'} disabled={!canConfirm || busy === 'auto'}>
                {t('pa.confirmRecovery')}
              </Button>
            </>
          ) : (
            <Button type="submit" variant="primary" loading={busy === 'auto'} disabled={!task}>
              {t('pa.reconcileAuto')}
            </Button>
          )}
        </>
      }
    >
      {task ? <blockquote className={styles.quote}>{task.goal}</blockquote> : null}
      {finding?.running ? (
        <div className={styles.manual}>
          <Callout tone="neutral" role="status" className={styles.notice}>
            {t('pa.reconcileForm.stillRunning')}
            <span className={styles.noticeDetail}>{finding.message}</span>
          </Callout>
        </div>
      ) : null}
      {manual ? (
        <div className={styles.manual}>
          {/* The outcome of the automatic check (the daemon's reason), then what to do about it. */}
          <Callout tone="neutral" role="status" className={styles.notice}>
            {t('pa.reconcileForm.manualLead')}
            {finding ? <span className={styles.noticeDetail}>{finding.message}</span> : null}
          </Callout>
          <Field label={t('pa.reconcileNote')} htmlFor={noteId} labelVariant="form" hint={`${noteLength}/${NOTE_MAX}`}>
            <Textarea
              id={noteId}
              value={note}
              rows={3}
              maxLength={NOTE_MAX}
              autoFocus
              onChange={(event) => setNote(event.target.value)}
            />
          </Field>
          <CheckboxField
            label={t('pa.confirmStopped')}
            checked={confirmed}
            onChange={(event) => setConfirmed(event.target.checked)}
          />
        </div>
      ) : null}
    </PaModalFrame>
  );
}
