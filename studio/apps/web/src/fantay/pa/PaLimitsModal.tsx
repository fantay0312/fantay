// SPDX-License-Identifier: AGPL-3.0-only
// Run limits modal (spec §14.5): concurrency, attempts, minutes per run and waiting expiry → PATCH /control.
import { useId, useState } from 'react';
import { useT } from '../../i18n';
import { Button, Callout, Field, Input, Segmented, SegmentedItem } from '../ui';
import { usePa } from './pa-context';
import { PaModalFrame, usePaModalReset, usePaSubmit } from './PaAgentModal';
import type { PaControl } from './pa-types';
import styles from './PaModals.module.css';

const MINUTE = 60_000;
const HOUR = 3_600_000;
const CONCURRENCY = ['1', '2', '3', '4'] as const;

interface LimitsForm {
  concurrent: string;
  attempts: string;
  minutes: string;
  hours: string;
}

type NumberField = Exclude<keyof LimitsForm, 'concurrent'>;

const RANGES: Record<NumberField, { min: number; max: number; label: 'pa.attemptLimit' | 'pa.minutes' | 'pa.waitHours' }> = {
  attempts: { min: 1, max: 12, label: 'pa.attemptLimit' },
  minutes: { min: 1, max: 30, label: 'pa.minutes' },
  hours: { min: 1, max: 168, label: 'pa.waitHours' },
};

function limitsForm(control: PaControl | null): LimitsForm {
  if (!control) return { concurrent: '2', attempts: '6', minutes: '5', hours: '24' };
  return {
    concurrent: String(Math.min(4, Math.max(1, control.maxConcurrent))),
    attempts: String(control.defaultMaxAttempts),
    minutes: String(Math.max(1, Math.round(control.defaultTimeoutMs / MINUTE))),
    hours: String(Math.max(1, Math.round(control.waitingExpiryMs / HOUR))),
  };
}

function parseIn(value: string, min: number, max: number): number | null {
  if (!/^\d+$/.test(value.trim())) return null;
  const n = Number(value.trim());
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

export function PaLimitsModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const t = useT();
  const { data } = usePa();
  const control = data.control;
  const [form, setForm] = useState<LimitsForm>(() => limitsForm(control));
  const submit = usePaSubmit();
  usePaModalReset(open, 'limits', () => {
    setForm(limitsForm(control));
    submit.clear();
  });
  const ids = { attempts: useId(), minutes: useId(), hours: useId() };

  const values = {
    attempts: parseIn(form.attempts, RANGES.attempts.min, RANGES.attempts.max),
    minutes: parseIn(form.minutes, RANGES.minutes.min, RANGES.minutes.max),
    hours: parseIn(form.hours, RANGES.hours.min, RANGES.hours.max),
  };
  const valid = !!control && values.attempts !== null && values.minutes !== null && values.hours !== null;

  const save = () => {
    if (!valid || submit.busy || values.attempts === null || values.minutes === null || values.hours === null) return;
    const patch = {
      maxConcurrent: Number(form.concurrent),
      defaultMaxAttempts: values.attempts,
      defaultTimeoutMs: values.minutes * MINUTE,
      waitingExpiryMs: values.hours * HOUR,
    };
    void submit.run(() => data.actions.patchControl(patch)).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <PaModalFrame
      open={open}
      onClose={onClose}
      size="sm"
      title={t('pa.limitsForm.title')}
      error={submit.error}
      onSubmit={save}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('pa.cancel')}
          </Button>
          <Button type="submit" variant="primary" disabled={!valid} loading={submit.busy}>
            {t('pa.save')}
          </Button>
        </>
      }
    >
      {!control ? <Callout tone="neutral">{t('pa.error')}</Callout> : null}

      <Field label={t('pa.concurrency')} labelVariant="form">
        <Segmented
          size="md"
          className="flex w-full"
          aria-label={t('pa.concurrency')}
          value={form.concurrent}
          onValueChange={(concurrent) => setForm((current) => ({ ...current, concurrent }))}
          disabled={!control}
        >
          {CONCURRENCY.map((value) => (
            <SegmentedItem key={value} value={value} className="min-w-0 flex-1 tabular-nums">
              {value}
            </SegmentedItem>
          ))}
        </Segmented>
      </Field>

      <div className={styles.group}>
        {(Object.keys(RANGES) as NumberField[]).map((field) => {
          const range = RANGES[field];
          const invalid = values[field] === null;
          return (
            <div key={field} className={styles.row}>
              <div className={styles.rowText}>
                <label htmlFor={ids[field]} className={styles.rowLabel}>
                  {t(range.label)}
                </label>
                {invalid ? (
                  <div className={styles.rowError} role="alert">
                    {t('pa.limitsForm.invalid', { min: range.min, max: range.max })}
                  </div>
                ) : (
                  <div className={styles.rowHint}>
                    {range.min}–{range.max}
                  </div>
                )}
              </div>
              <div className={styles.rowControl}>
                <Input
                  id={ids[field]}
                  variant="mono"
                  inputMode="numeric"
                  className={styles.number}
                  value={form[field]}
                  aria-invalid={invalid || undefined}
                  disabled={!control}
                  onChange={(event) => {
                    const value = event.target.value.replace(/[^\d]/g, '').slice(0, 3);
                    setForm((current) => ({ ...current, [field]: value }));
                  }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </PaModalFrame>
  );
}
