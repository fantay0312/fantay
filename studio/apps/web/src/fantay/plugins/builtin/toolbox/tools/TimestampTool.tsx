// SPDX-License-Identifier: AGPL-3.0-only
// 工具台 › 时间戳: two blocks, timestamp → date-time and date-time → timestamp, each with a 现在 action that
// fills in the current time. Seconds and milliseconds are told apart by size; date-times without a zone are
// read in the local zone. Every value has its own copy button.
import { useId, useMemo, useState, type ReactNode } from 'react';

import { Button, Input, InputGroup, cn } from '../../../../ui';
import type { ToolboxKey, Translate } from '../dictionary';
import {
  formatLocal,
  formatOffset,
  localZoneName,
  parseDateTime,
  parseTimestamp,
  type TimeError,
} from './logic';
import { CopyButton } from './parts';
import styles from './tools.module.css';

const ERROR_KEY = {
  invalidStamp: 'time.invalidStamp',
  outOfRange: 'time.outOfRange',
  invalidDate: 'time.invalidDate',
} as const satisfies Record<TimeError, ToolboxKey>;

function ValueRow({ label, meta, value, t }: { label: string; meta?: string; value: string; t: Translate }) {
  return (
    <div className={styles.row}>
      <dt className={styles.rowLabel}>
        {label}
        {meta ? <span className={styles.rowMeta}>{meta}</span> : null}
      </dt>
      <dd className={styles.rowValue}>
        <span className={styles.valueText} data-empty={value ? undefined : ''}>
          {value || '—'}
        </span>
        <CopyButton text={value} name={label} t={t} />
      </dd>
    </div>
  );
}

interface ConvertBlockProps {
  title: string;
  onNow(): void;
  field: ReactNode;
  rows: ReactNode;
  t: Translate;
}

function ConvertBlock({ title, onNow, field, rows, t }: ConvertBlockProps) {
  return (
    <section className={styles.block}>
      <header className={styles.blockHead}>
        <h3 className={styles.blockLabel}>{title}</h3>
        <div className={styles.blockTools}>
          <Button size="sm" onClick={onNow}>
            {t('time.now')}
          </Button>
        </div>
      </header>
      <div className={styles.field}>{field}</div>
      <dl className={styles.rows}>{rows}</dl>
    </section>
  );
}

interface TimeFieldProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder: string;
  inputMode?: 'decimal' | 'text';
  /** The detected unit, shown inside the field. */
  tag?: string;
  note: string;
  error: string | null;
}

function TimeField({ id, label, value, onChange, placeholder, inputMode = 'text', tag, note, error }: TimeFieldProps) {
  const noteId = `${id}-note`;
  return (
    <>
      <InputGroup invalid={Boolean(error)} trailing={tag ? <span className={styles.tag}>{tag}</span> : null}>
        <Input
          id={id}
          variant="bare"
          inputSize="auto"
          className={cn('h-full flex-1', styles.mono)}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          inputMode={inputMode}
          spellCheck={false}
          autoComplete="off"
          aria-label={label}
          aria-invalid={error ? true : undefined}
          aria-describedby={noteId}
        />
      </InputGroup>
      <p id={noteId} className={styles.note} data-tone={error ? 'error' : undefined}>
        {error ?? note}
      </p>
    </>
  );
}

export function createTimestampTool(t: Translate) {
  return function TimestampTool() {
    const id = useId();
    const [stamp, setStamp] = useState('');
    const [dateTime, setDateTime] = useState('');
    const zone = useMemo(() => {
      const name = localZoneName();
      const offset = formatOffset(new Date());
      return name ? `${name} (${offset})` : offset;
    }, []);

    const fromStamp = useMemo(() => (stamp.trim() ? parseTimestamp(stamp) : null), [stamp]);
    const fromDate = useMemo(() => (dateTime.trim() ? parseDateTime(dateTime) : null), [dateTime]);
    const stampDate = fromStamp?.ok ? new Date(fromStamp.ms) : null;

    const fillNow = (target: 'stamp' | 'date') => {
      const seconds = Math.floor(Date.now() / 1000);
      if (target === 'stamp') setStamp(String(seconds));
      else setDateTime(formatLocal(new Date(seconds * 1000)));
    };

    return (
      <div className={styles.tool} data-testid="toolbox-timestamp">
        <div className={styles.pair}>
          <ConvertBlock
            title={t('time.toDate')}
            onNow={() => fillNow('stamp')}
            t={t}
            field={(
              <TimeField
                id={`${id}-stamp`}
                label={t('time.stampLabel')}
                value={stamp}
                onChange={setStamp}
                placeholder={t('time.stampPlaceholder')}
                inputMode="decimal"
                tag={fromStamp?.ok ? t(fromStamp.unit === 'seconds' ? 'time.readAsSeconds' : 'time.readAsMillis') : undefined}
                note={t('time.stampHint')}
                error={fromStamp && !fromStamp.ok ? t(ERROR_KEY[fromStamp.error]) : null}
              />
            )}
            rows={(
              <>
                <ValueRow
                  label={t('time.local')}
                  meta={stampDate ? formatOffset(stampDate) : undefined}
                  value={stampDate ? formatLocal(stampDate) : ''}
                  t={t}
                />
                <ValueRow label={t('time.iso')} value={stampDate ? stampDate.toISOString() : ''} t={t} />
              </>
            )}
          />
          <ConvertBlock
            title={t('time.toStamp')}
            onNow={() => fillNow('date')}
            t={t}
            field={(
              <TimeField
                id={`${id}-date`}
                label={t('time.dateLabel')}
                value={dateTime}
                onChange={setDateTime}
                placeholder={t('time.datePlaceholder')}
                note={t('time.dateHint', { zone })}
                error={fromDate && !fromDate.ok ? t(ERROR_KEY[fromDate.error]) : null}
              />
            )}
            rows={(
              <>
                <ValueRow label={t('time.seconds')} value={fromDate?.ok ? String(Math.floor(fromDate.ms / 1000)) : ''} t={t} />
                <ValueRow label={t('time.millis')} value={fromDate?.ok ? String(fromDate.ms) : ''} t={t} />
              </>
            )}
          />
        </div>
      </div>
    );
  };
}
