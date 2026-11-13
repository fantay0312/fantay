'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/modal.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   source: src/components/ui/alert-dialog.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: controlled `open` (the
 *   unmount "ghost" is not ported), 2xl size, localized close/confirm/cancel labels, filled danger
 *   confirm with busy state, fx surface marker, z ladder, fx-* motion, Fantay tokens.
 */
import * as React from 'react';
import * as AlertDialogPrimitive from '@radix-ui/react-alert-dialog';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva } from 'class-variance-authority';

import { useT } from '../../i18n';
import { Button } from './button';
import { cn } from './cn';
import { FX } from './fx';
import { XIcon } from './icons';

export type ModalSize = 'sm' | 'md' | 'lg' | 'xl' | '2xl';

/* A surface card with the modal corner on a half-pixel ring and a short layered shadow, over a
   dimmed canvas: 20px padding, a medium lead title with a lede under it, the × a 24px soft
   circle in the corner, the actions bottom-end. Radix brings the focus trap, Escape and scroll
   locking. */
export const modalVariants = cva(
  [
    FX,
    'fixed left-1/2 top-1/2 z-(--z-fx-overlay) w-full -translate-x-1/2 -translate-y-1/2 overflow-y-auto',
    'rounded-modal bg-surface p-5 font-ui text-body text-ink shadow-modal outline-none max-h-[calc(100dvh-24px)]',
    'motion-safe:data-[state=open]:animate-fx-modal-in motion-safe:data-[state=closed]:animate-fx-modal-out',
  ],
  {
    variants: {
      size: {
        sm: 'max-w-[min(460px,calc(100vw-24px))]',
        md: 'max-w-[min(520px,calc(100vw-24px))]',
        lg: 'max-w-[min(620px,calc(100vw-24px))]',
        xl: 'max-w-[min(760px,calc(100vw-24px))]',
        '2xl': 'max-w-[min(960px,calc(100vw-24px))]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export const overlayClass = cn(
  FX,
  'fixed inset-0 z-(--z-fx-overlay) bg-scrim motion-safe:data-[state=open]:animate-fx-fade-in motion-safe:data-[state=closed]:animate-fx-fade-out',
);

export interface ModalProps extends Omit<React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>, 'onOpenChange'> {
  /** Required: keep the Modal mounted and toggle `open`, so Radix plays the exit. */
  open: boolean;
  onClose: () => void;
  /** 460 / 520 / 620 / 760 / 960, each capped at calc(100vw - 24px). Default md. */
  size?: ModalSize;
  /** The × in the corner (default true), labelled t('fantay.ui.close'). */
  showClose?: boolean;
}

export const Modal = React.forwardRef<React.ElementRef<typeof DialogPrimitive.Content>, ModalProps>(function Modal(
  { open, onClose, size = 'md', showClose = true, className, children, ...props },
  ref,
) {
  const t = useT();
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay data-slot="modal-overlay" className={overlayClass} />
        <DialogPrimitive.Content
          ref={ref}
          data-slot="modal"
          data-size={size}
          className={cn(modalVariants({ size }), className)}
          {...props}
        >
          {showClose ? (
            <DialogPrimitive.Close
              data-slot="modal-close"
              aria-label={t('fantay.ui.close')}
              className="absolute end-2.5 top-2.5 z-[1] grid size-6 cursor-pointer place-items-center rounded-full border-0 border-solid border-transparent bg-ink/[0.06] p-0 text-ink/50 transition-colors duration-micro ease-out-quint hover:bg-ink/10 hover:text-ink focus-ring"
            >
              <XIcon size="xs" />
            </DialogPrimitive.Close>
          ) : null}
          {children}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
});

/** The small caption above a modal title. */
export function ModalEyebrow({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      data-slot="modal-eyebrow"
      className={cn('text-caption font-medium uppercase leading-none tracking-[0.08em] text-ink-faint', className)}
      {...props}
    />
  );
}

export const ModalTitle = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(function ModalTitle({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Title
      ref={ref}
      data-slot="modal-title"
      className={cn('pe-8 text-lead font-medium leading-5 text-ink', className)}
      {...props}
    />
  );
});

export const ModalLede = React.forwardRef<
  React.ElementRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(function ModalLede({ className, ...props }, ref) {
  return (
    <DialogPrimitive.Description
      ref={ref}
      data-slot="modal-lede"
      className={cn('mt-1 text-copy text-ink-soft', className)}
      {...props}
    />
  );
});

/** Footer action row: buttons go full-width side by side on small phones. */
export function ModalActions({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      data-slot="modal-actions"
      className={cn('mt-6 flex flex-wrap justify-end gap-2.5 max-xs:*:flex-1', className)}
      {...props}
    />
  );
}

/** Pushes the actions after it to the other end of the row. */
export function ModalSpacer() {
  return <span data-slot="modal-spacer" aria-hidden className="flex-1" />;
}

export interface ConfirmDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Default t('fantay.ui.confirm'). Name the action ("Delete board") whenever possible. */
  confirmLabel?: string;
  /** Default t('fantay.ui.cancel'). */
  cancelLabel?: string;
  /** Confirm uses the filled danger Button, else primary. */
  destructive?: boolean;
  /** Confirm Button loading. The confirm click still requests close through onOpenChange(false);
   *  a caller running async work keeps `open` true until it settles. */
  busy?: boolean;
  onConfirm(): void;
}

/* "Are you sure?" as a real dialog: it names its action instead of an anonymous OK, focuses the
   safe action, and Escape/outside click both mean cancel. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel,
  destructive = false,
  busy = false,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useT();
  return (
    <AlertDialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialogPrimitive.Portal>
        <AlertDialogPrimitive.Overlay data-slot="confirm-dialog-overlay" className={cn(overlayClass, 'z-(--z-fx-confirm)')} />
        <AlertDialogPrimitive.Content
          data-slot="confirm-dialog"
          className={cn(modalVariants({ size: 'sm' }), 'z-(--z-fx-confirm)')}
          {...(description ? {} : { 'aria-describedby': undefined })}
        >
          <AlertDialogPrimitive.Title className="text-lead font-medium leading-5 text-ink">{title}</AlertDialogPrimitive.Title>
          {description ? (
            <AlertDialogPrimitive.Description className="mt-1 text-copy text-ink-soft">{description}</AlertDialogPrimitive.Description>
          ) : null}
          <div className="mt-6 flex flex-wrap justify-end gap-2.5 max-xs:*:flex-1">
            <AlertDialogPrimitive.Cancel asChild>
              <Button variant="ghost">{cancelLabel ?? t('fantay.ui.cancel')}</Button>
            </AlertDialogPrimitive.Cancel>
            <AlertDialogPrimitive.Action asChild>
              <Button variant={destructive ? 'danger' : 'primary'} loading={busy} onClick={() => onConfirm()}>
                {confirmLabel ?? t('fantay.ui.confirm')}
              </Button>
            </AlertDialogPrimitive.Action>
          </div>
        </AlertDialogPrimitive.Content>
      </AlertDialogPrimitive.Portal>
    </AlertDialogPrimitive.Root>
  );
}
