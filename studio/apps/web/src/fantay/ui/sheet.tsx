'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/sheet.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: no tw-animate-css (enter via
 *   @starting-style transitions, exit via fx-fade-out), pixel width prop, localized close button,
 *   fx surface marker, z ladder, Fantay tokens.
 */
import * as React from 'react';
import * as SheetPrimitive from '@radix-ui/react-dialog';

import { useT } from '../../i18n';
import { cn } from './cn';
import { FX } from './fx';
import { IconButton } from './icon-button';
import { XIcon } from './icons';

/* A panel that slides in from a screen edge: the phone sidebar (left, 280px), the materials
   drawer (right, non-modal). Built on Radix Dialog, so `modal={false}` drops the overlay and the
   focus trap while keeping Escape. */
export const Sheet = SheetPrimitive.Root;
export const SheetTrigger = SheetPrimitive.Trigger;
export const SheetClose = SheetPrimitive.Close;
export const SheetPortal = SheetPrimitive.Portal;

export const SheetOverlay = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Overlay>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Overlay>
>(function SheetOverlay({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Overlay
      ref={ref}
      data-slot="sheet-overlay"
      className={cn(
        FX,
        'fixed inset-0 z-(--z-fx-overlay) bg-scrim motion-safe:data-[state=open]:animate-fx-fade-in motion-safe:data-[state=closed]:animate-fx-fade-out',
        className,
      )}
      {...props}
    />
  );
});

export type SheetSide = 'top' | 'right' | 'bottom' | 'left';

const SIDE_CLASS: Record<SheetSide, string> = {
  right: 'inset-y-0 right-0 h-full w-[min(var(--fx-sheet-width,384px),calc(100vw-24px))] starting:translate-x-10',
  left: 'inset-y-0 left-0 h-full w-[min(var(--fx-sheet-width,384px),calc(100vw-24px))] starting:-translate-x-10',
  top: 'inset-x-0 top-0 max-h-[85dvh] starting:-translate-y-10',
  bottom: 'inset-x-0 bottom-0 max-h-[85dvh] starting:translate-y-10',
};

export interface SheetContentProps extends React.ComponentPropsWithoutRef<typeof SheetPrimitive.Content> {
  /** The screen edge it slides from (physical). Default right. */
  side?: SheetSide;
  /** The × in the corner (default true), labelled t('fantay.ui.close'). */
  showCloseButton?: boolean;
  /** Width in px for left/right sheets (default 384), capped at calc(100vw - 24px). */
  width?: number;
}

export const SheetContent = React.forwardRef<React.ElementRef<typeof SheetPrimitive.Content>, SheetContentProps>(
  function SheetContent({ className, children, side = 'right', showCloseButton = true, width, style, ...props }, ref) {
    const t = useT();
    const horizontal = side === 'left' || side === 'right';
    const pixelWidth = horizontal && typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null;
    return (
      <SheetPortal>
        <SheetOverlay />
        <SheetPrimitive.Content
          ref={ref}
          data-slot="sheet-content"
          data-side={side}
          className={cn(
            FX,
            'fixed z-(--z-fx-overlay) flex flex-col gap-4 overflow-y-auto bg-surface font-ui text-body text-ink shadow-float outline-none',
            'transition-[translate,opacity] duration-enter ease-out-quint starting:opacity-0 motion-reduce:transition-none',
            'data-[state=closed]:animate-fx-fade-out',
            SIDE_CLASS[side],
            className,
          )}
          style={pixelWidth === null ? style : ({ '--fx-sheet-width': `${pixelWidth}px`, ...style } as React.CSSProperties)}
          {...props}
        >
          {children}
          {showCloseButton ? (
            <SheetPrimitive.Close asChild>
              {/* no tooltip: on open, focus may land here and a tooltip layer would take the first Escape */}
              <IconButton size="sm" aria-label={t('fantay.ui.close')} tooltip={false} className="absolute end-3 top-3">
                <XIcon />
              </IconButton>
            </SheetPrimitive.Close>
          ) : null}
        </SheetPrimitive.Content>
      </SheetPortal>
    );
  },
);

export function SheetHeader({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-header" className={cn('flex flex-col gap-0.5 p-4 pe-12', className)} {...props} />;
}

export function SheetFooter({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="sheet-footer" className={cn('mt-auto flex flex-col gap-2 p-4', className)} {...props} />;
}

export const SheetTitle = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Title>
>(function SheetTitle({ className, ...props }, ref) {
  return <SheetPrimitive.Title ref={ref} data-slot="sheet-title" className={cn('text-lead font-medium text-ink', className)} {...props} />;
});

export const SheetDescription = React.forwardRef<
  React.ElementRef<typeof SheetPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof SheetPrimitive.Description>
>(function SheetDescription({ className, ...props }, ref) {
  return (
    <SheetPrimitive.Description ref={ref} data-slot="sheet-description" className={cn('text-body text-ink-soft', className)} {...props} />
  );
});
