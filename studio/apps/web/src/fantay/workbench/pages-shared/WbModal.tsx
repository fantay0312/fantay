/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay 工作台 — the dialog frame for the 内容 / 排期 / 复盘 / 风格 pages: a fixed header and
 * footer around one scrolling body; with `onSubmit` the frame is a form (Enter submits).
 * Also the inline one-of-N chip group used by the platform pickers.
 */
import { type FormEvent, type ReactNode } from 'react';
import { Chip, Modal, ModalLede, ModalTitle, cn, type ModalSize } from '../../ui';
import page from './page.module.css';
import styles from './WbModal.module.css';

export interface WbModalProps {
  open: boolean;
  onClose(): void;
  title: ReactNode;
  lede?: ReactNode;
  size?: ModalSize;
  onSubmit?(): void;
  footer?: ReactNode;
  bodyClassName?: string;
  children: ReactNode;
}

export function WbModal({ open, onClose, title, lede, size = 'md', onSubmit, footer, bodyClassName, children }: WbModalProps) {
  const inner = (
    <>
      <header className={styles.header}>
        <ModalTitle>{title}</ModalTitle>
        {lede ? <ModalLede className={styles.lede}>{lede}</ModalLede> : null}
      </header>
      <div className={cn(styles.body, bodyClassName)}>{children}</div>
      {footer ? <footer className={styles.footer}>{footer}</footer> : null}
    </>
  );
  return (
    <Modal open={open} onClose={onClose} size={size} className={styles.modal} {...(lede ? {} : { 'aria-describedby': undefined })}>
      {onSubmit ? (
        <form
          className={styles.form}
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            onSubmit();
          }}
        >
          {inner}
        </form>
      ) : (
        <div className={styles.form}>{inner}</div>
      )}
    </Modal>
  );
}

/** A small titled group inside a dialog body. */
export function WbSection({ title, hint, children }: { title: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h3 className={styles.sectionTitle}>
        {title}
        {hint ? <span className={styles.sectionHint}>{hint}</span> : null}
      </h3>
      {children}
    </section>
  );
}

export interface ChoiceOption { value: string; label: ReactNode }

/** Inline radio chips: every option visible, the chosen one fully on. Arrow keys move the choice. */
export function Choices({
  value,
  options,
  onChange,
  label,
  className,
}: {
  value: string;
  options: ChoiceOption[];
  onChange(value: string): void;
  label: string;
  className?: string;
}) {
  const move = (from: number, step: number) => {
    const next = options[(from + step + options.length) % options.length];
    if (next) onChange(next.value);
  };
  return (
    <div role="radiogroup" aria-label={label} className={cn(page.choices, className)}>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <Chip
            key={option.value}
            size="sm"
            variant="suggestion"
            on={checked}
            role="radio"
            aria-checked={checked}
            tabIndex={checked || (!options.some((o) => o.value === value) && index === 0) ? 0 : -1}
            onClick={() => onChange(option.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
                event.preventDefault();
                move(index, 1);
                (event.currentTarget.nextElementSibling as HTMLElement | null)?.focus();
              } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
                event.preventDefault();
                move(index, -1);
                (event.currentTarget.previousElementSibling as HTMLElement | null)?.focus();
              }
            }}
          >
            {option.label}
          </Chip>
        );
      })}
    </div>
  );
}
