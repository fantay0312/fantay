'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/popover.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: named widths plus a pixel
 *   width, anchor export, fx surface marker, z ladder, fx-* motion.
 */
import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

import { cn } from './cn';
import { FX } from './fx';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

export type PopoverWidth = 'sm' | 'md' | 'lg' | 'auto' | number;

const WIDTH_CLASS: Record<Exclude<PopoverWidth, number>, string> = {
  sm: 'w-[min(220px,calc(100vw-24px))]',
  md: 'w-[min(280px,calc(100vw-24px))]',
  lg: 'w-[min(340px,calc(100vw-24px))]',
  auto: '',
};

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> {
  /** sm 220 · md 280 (default) · lg 340 · auto (content width) · a number of px. Every width
   *  gives way to a phone's (capped at calc(100vw - 24px)). */
  width?: PopoverWidth;
}

/** A floating editor anchored to its trigger, with keyboard dismissal, focus restoration and
 *  collision handling supplied by Radix. */
export const PopoverContent = React.forwardRef<React.ElementRef<typeof PopoverPrimitive.Content>, PopoverContentProps>(
  function PopoverContent(
    { className, width = 'md', align = 'center', sideOffset = 8, collisionPadding = 12, style, ...props },
    ref,
  ) {
    const pixelWidth = typeof width === 'number' && Number.isFinite(width) && width > 0 ? width : null;
    return (
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          ref={ref}
          data-slot="popover-content"
          data-width={pixelWidth === null ? (typeof width === 'number' ? 'md' : width) : 'px'}
          align={align}
          sideOffset={sideOffset}
          collisionPadding={collisionPadding}
          className={cn(
            FX,
            'z-(--z-fx-floating) max-h-(--radix-popover-content-available-height) overflow-y-auto rounded-panel bg-surface font-ui text-body text-ink shadow-pop outline-none',
            'data-[state=open]:animate-fx-chip-in data-[state=closed]:animate-fx-fade-out',
            pixelWidth === null
              ? typeof width === 'number'
                ? WIDTH_CLASS.md
                : WIDTH_CLASS[width]
              : 'w-[min(var(--fx-popover-width),calc(100vw-24px))]',
            className,
          )}
          style={pixelWidth === null ? style : ({ '--fx-popover-width': `${pixelWidth}px`, ...style } as React.CSSProperties)}
          {...props}
        />
      </PopoverPrimitive.Portal>
    );
  },
);
