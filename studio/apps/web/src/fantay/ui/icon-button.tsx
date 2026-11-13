'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/icon-button.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: sizes 24/28/32/40, brand
 *   variant, self-sufficient box, the one focus ring, tooltip (label + key caps) instead of
 *   `title`, explicit toggle state, disabledReason.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';
import { guardActivation, hasReason } from './interaction';
import { Tooltip } from './tooltip';

/* A glyph in a square: a row's "more", a panel's close, a toolbar toggle. Quiet by default:
   no ring, the paper-deep fill appears on hover and stays while it is `on`. */
export const iconButtonVariants = cva(
  [
    'relative inline-grid flex-none place-items-center border-0 border-solid border-transparent p-0',
    'font-ui text-body font-semibold leading-tight transform-none',
    'transition-[background-color,color,box-shadow,opacity] duration-micro ease-out-quint',
    'cursor-pointer focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-45',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        quiet:
          'bg-transparent text-ink-soft shadow-none not-data-disabled:hover:bg-paper-deep not-data-disabled:hover:text-ink data-on:bg-paper-deep data-on:text-ink',
        danger:
          'bg-transparent text-ink-soft shadow-none not-data-disabled:hover:bg-accent-ink/10 not-data-disabled:hover:text-accent-ink',
        primary: 'bg-ink text-paper shadow-[inset_0_1px_0_rgba(255,255,255,0.65)] not-data-disabled:hover:bg-ink/85',
        brand: 'bg-brand text-on-brand shadow-none not-data-disabled:hover:bg-brand-hover',
        frosted:
          'bg-surface/72 text-ink shadow-elevation-1 backdrop-blur-[6px] corner-squircle not-data-disabled:hover:shadow-elevation-1-hover',
      },
      size: {
        xs: "size-6 rounded-row [&_svg:not([class*='size-'])]:size-3.5",
        sm: "size-7 rounded-row [&_svg:not([class*='size-'])]:size-3.5",
        md: "size-8 rounded-row [&_svg:not([class*='size-'])]:size-4",
        lg: "size-10 rounded-control [&_svg:not([class*='size-'])]:size-[18px]",
      },
      shape: { square: '', round: 'rounded-full' },
    },
    defaultVariants: { variant: 'quiet', size: 'md', shape: 'square' },
  },
);

export interface IconButtonProps
  extends Omit<React.ComponentPropsWithoutRef<'button'>, 'aria-label' | 'disabled'>,
    VariantProps<typeof iconButtonVariants> {
  /** Required: the glyph has no text of its own. Also the default tooltip. */
  'aria-label': string;
  /** Toggle state → `data-on` + `aria-pressed`; leave undefined for a plain action. */
  on?: boolean;
  /** Default: the aria-label. `false` = no tooltip. */
  tooltip?: React.ReactNode | false;
  /** e.g. `'mod+k'` → key caps in the tooltip. */
  shortcut?: string;
  tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
  disabled?: boolean;
  /** Same contract as Button: aria-disabled, focusable, activation blocked, reason as tooltip. */
  disabledReason?: React.ReactNode;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    className,
    variant,
    size,
    shape,
    on,
    tooltip,
    shortcut,
    tooltipSide,
    type,
    disabled = false,
    disabledReason,
    onClick,
    onPointerDown,
    onKeyDown,
    children,
    ...props
  },
  ref,
) {
  const explained = disabled && hasReason(disabledReason);
  const nativeDisabled = disabled && !explained;
  const handlers = guardActivation<HTMLButtonElement>(explained, { onClick, onPointerDown, onKeyDown });
  const label = explained ? disabledReason : tooltip === false ? null : (tooltip ?? props['aria-label']);

  /* `data-disabled` follows the spread: a Radix trigger rendering this `asChild` passes
     `data-disabled: undefined`, which would otherwise erase the disabled look. */
  const element = (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="icon-button"
      data-variant={variant ?? 'quiet'}
      data-size={size ?? 'md'}
      data-on={on ? '' : undefined}
      aria-pressed={on === undefined ? undefined : on}
      aria-disabled={explained ? true : undefined}
      disabled={nativeDisabled || undefined}
      className={cn(iconButtonVariants({ variant, size, shape }), className)}
      {...props}
      data-disabled={disabled ? '' : undefined}
      {...handlers}
    >
      {children}
    </button>
  );

  return (
    <Tooltip label={label} shortcut={explained ? undefined : shortcut} side={tooltipSide}>
      {element}
    </Tooltip>
  );
});
