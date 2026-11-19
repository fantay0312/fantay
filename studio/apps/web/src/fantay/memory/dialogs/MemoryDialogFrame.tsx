// SPDX-License-Identifier: AGPL-3.0-only
// The frame every Memory Center dialog uses: a Fantay Modal with a fixed header and footer around one
// scrolling body (the management-modal recipe of the PA workspace). Radix brings the focus trap and
// Escape; this frame also sends focus back to whatever opened the dialog, because these dialogs are
// controlled without a Radix trigger and Radix alone would leave focus on the page body.
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';

import { Modal, ModalActions, ModalLede, ModalTitle, cn, type ModalSize } from '../../ui';
import styles from './MemoryDialogFrame.module.css';

export interface MemoryDialogFrameProps {
  open: boolean;
  onClose(): void;
  size: ModalSize;
  title: ReactNode;
  lede?: ReactNode;
  testId: string;
  /** Footer row; omitted → no footer. */
  footer?: ReactNode;
  footerClassName?: string;
  bodyClassName?: string;
  /** When set, the frame is a <form>: Enter in a field and the submit button call it. */
  onSubmit?(): void;
  /** Focused when the dialog opens, if it is rendered by then; else the first control is. */
  initialFocusRef?: RefObject<HTMLElement | null>;
  children: ReactNode;
}

/** The opener of each open dialog, by test id. A dialog opened from inside another one (编辑 in the detail
 *  dialog, which then closes) falls back to that dialog's opener once its own opener is gone. */
const openers = new Map<string, HTMLElement>();

function focusedElement(): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  const active = document.activeElement;
  return active instanceof HTMLElement && active !== document.body ? active : null;
}

export function MemoryDialogFrame({
  open,
  onClose,
  size,
  title,
  lede,
  testId,
  footer,
  footerClassName,
  bodyClassName,
  onSubmit,
  initialFocusRef,
  children,
}: MemoryDialogFrameProps) {
  const returnTo = useRef<HTMLElement[]>([]);
  // Layout effect: runs before Radix's focus scope moves focus into the dialog.
  useLayoutEffect(() => {
    if (!open) return;
    const opener = focusedElement();
    const hostId = opener?.closest('[role="dialog"]')?.getAttribute('data-testid');
    const hostOpener = hostId ? openers.get(hostId) : undefined;
    returnTo.current = [opener, hostOpener].filter((element): element is HTMLElement => Boolean(element));
    if (opener) openers.set(testId, opener);
    else openers.delete(testId);
  }, [open, testId]);

  const inner = (
    <>
      <header className={styles.header}>
        <ModalTitle>{title}</ModalTitle>
        {lede ? <ModalLede className={styles.lede}>{lede}</ModalLede> : null}
      </header>
      <div className={cn(styles.body, bodyClassName)}>{children}</div>
      {footer ? <ModalActions className={cn(styles.footer, footerClassName)}>{footer}</ModalActions> : null}
    </>
  );

  return (
    <Modal
      open={open}
      onClose={onClose}
      size={size}
      className={styles.modal}
      data-testid={testId}
      {...(lede ? {} : { 'aria-describedby': undefined })}
      onOpenAutoFocus={(event) => {
        const target = initialFocusRef?.current;
        if (!target) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        const targets = returnTo.current;
        returnTo.current = [];
        openers.delete(testId);
        // Another dialog has taken over (it opened as this one closed): focus stays with it.
        if (focusedElement()?.closest('[role="dialog"][data-state="open"]')) return;
        const target = targets.find((element) => element.isConnected);
        if (target) {
          target.focus({ preventScroll: true });
          return;
        }
        // The opener is gone (a resolved inbox card): land in the dialog underneath, if any.
        const below = document.querySelectorAll<HTMLElement>('[role="dialog"][data-state="open"]');
        below[below.length - 1]?.focus({ preventScroll: true });
      }}
    >
      {onSubmit ? (
        <form
          className={styles.form}
          noValidate
          onSubmit={(event) => {
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
