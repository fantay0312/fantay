// SPDX-License-Identifier: AGPL-3.0-only
// Pieces the built-in 工具台 tools share: a hairline block with a caption strip, the editor block that takes
// the input, the output block that shows a result or why there is none, and the copy button. Results are
// derived while you type, so nothing here opens or closes; an error replaces the result in place.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, Copy, TriangleAlert, X } from 'lucide-react';

import { copyToClipboard } from '../../../../../lib/copy-to-clipboard';
import { Icon, IconButton, Textarea, cn, toast } from '../../../../ui';
import type { Translate } from '../dictionary';
import styles from './tools.module.css';

const COPIED_MS = 1500;

export function CopyButton({ text, name, t }: { text: string; name: string; t: Translate }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);
  // A new value has not been copied yet.
  useEffect(() => setCopied(false), [text]);

  const copy = async () => {
    if (!(await copyToClipboard(text))) {
      toast({ tone: 'danger', title: t('copyFailed') });
      return;
    }
    setCopied(true);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <IconButton
      size="sm"
      aria-label={copied ? t('copied') : t('copyValue', { name })}
      disabled={!text}
      onClick={() => void copy()}
    >
      <Icon icon={copied ? Check : Copy} size="sm" />
    </IconButton>
  );
}

export interface InputBlockProps {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  placeholder: string;
  invalid: boolean;
  /** The element that explains why the input is invalid. */
  describedBy?: string;
  t: Translate;
}

export function InputBlock({ id, label, value, onChange, placeholder, invalid, describedBy, t }: InputBlockProps) {
  return (
    <section className={styles.block} data-invalid={invalid ? '' : undefined}>
      <header className={styles.blockHead}>
        <label htmlFor={id} className={styles.blockLabel}>
          {label}
        </label>
        <div className={styles.blockTools}>
          <IconButton size="sm" aria-label={t('clear')} disabled={!value} onClick={() => onChange('')}>
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>
      </header>
      <Textarea
        id={id}
        variant="bare"
        className={cn(styles.body, styles.editor)}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? describedBy : undefined}
      />
    </section>
  );
}

export interface OutputError {
  title: string;
  /** The engine's own message, shown in mono under the title. */
  detail?: string;
}

export interface OutputBlockProps {
  id: string;
  label: string;
  value: string;
  error: OutputError | null;
  /** Controls placed before the copy button (an output mode, a swap). */
  tools?: ReactNode;
  t: Translate;
}

export function OutputBlock({ id, label, value, error, tools, t }: OutputBlockProps) {
  const labelId = `${id}-label`;
  return (
    <section className={styles.block} aria-labelledby={labelId}>
      <header className={styles.blockHead}>
        <h3 id={labelId} className={styles.blockLabel}>
          {label}
        </h3>
        <div className={styles.blockTools}>
          {tools}
          <CopyButton text={error ? '' : value} name={label} t={t} />
        </div>
      </header>
      {/* Focusable so the keyboard can scroll a long result. */}
      <div className={cn(styles.body, styles.output)} tabIndex={0} role="group" aria-labelledby={labelId}>
        {error ? (
          <div id={`${id}-error`} className={styles.error}>
            <Icon icon={TriangleAlert} size="sm" className={styles.errorIcon} />
            <div className={styles.errorText}>
              <p className={styles.errorTitle}>{error.title}</p>
              {error.detail ? <p className={styles.errorDetail}>{error.detail}</p> : null}
            </div>
          </div>
        ) : value ? (
          <pre className={styles.code}>{value}</pre>
        ) : (
          <p className={styles.placeholder}>{t('resultEmpty')}</p>
        )}
      </div>
    </section>
  );
}
