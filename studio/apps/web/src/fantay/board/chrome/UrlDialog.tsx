'use client';
// SPDX-License-Identifier: AGPL-3.0-only
// "Add a web preview" (spec 03 §6.6): one address field checked by `checkWebUrl` (a bare host gets https://,
// localhost http://; Fantay itself is refused), the error inline, Cancel and Add.
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';

import { useT } from '../../../i18n';
import { Button } from '../../ui/button';
import { Modal, ModalActions, ModalTitle } from '../../ui/dialog';
import { Field } from '../../ui/field';
import { Input } from '../../ui/input';
import type { DictKey } from '../model/types';
import { checkWebUrl, currentAppOrigin } from '../nodes/web/url-policy';
import styles from './chrome.module.css';

export interface UrlDialogProps {
  open: boolean;
  onClose(): void;
  /** a checked, normalised http(s) address */
  onSubmit(url: string): void;
}

export function UrlDialog({ open, onClose, onSubmit }: UrlDialogProps) {
  const t = useT();
  const id = useId();
  const input = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<DictKey | null>(null);

  useEffect(() => {
    if (!open) return;
    setValue('');
    setError(null);
  }, [open]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const result = checkWebUrl(value, currentAppOrigin());
    if (!result.ok) {
      setError(result.reasonKey);
      return;
    }
    onSubmit(result.url);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      size="sm"
      aria-describedby={undefined}
      data-testid="board-url-dialog"
      onOpenAutoFocus={(event) => {
        // the address field, not the dialog's close button
        event.preventDefault();
        input.current?.focus();
      }}
    >
      <ModalTitle>{t('board.url.title')}</ModalTitle>
      <form className={styles.dialogForm} onSubmit={submit} noValidate>
        <Field label={t('board.url.label')} htmlFor={`${id}-url`} {...(error ? { error: t(error) } : {})}>
          <Input
            ref={input}
            id={`${id}-url`}
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            placeholder={t('board.url.placeholder')}
            value={value}
            aria-invalid={error ? true : undefined}
            data-testid="board-url-input"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) setError(null);
            }}
          />
        </Field>
        <ModalActions>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" type="submit" disabled={value.trim() === ''} data-testid="board-url-submit">
            {t('board.url.add')}
          </Button>
        </ModalActions>
      </form>
    </Modal>
  );
}
