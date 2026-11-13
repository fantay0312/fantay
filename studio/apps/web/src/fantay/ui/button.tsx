'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/button.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: Fantay tokens and control
 *   heights (28/32/40), filled danger and brand variants, self-sufficient box, the one focus ring,
 *   disabledReason (aria-disabled + tooltip) and loading states.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';
import { guardActivation, hasReason } from './interaction';
import { Spinner } from './spinner';
import { Tooltip } from './tooltip';

/* A surface drawn by a 1px shadow ring rather than a border, with one ink primary per region.
   Pressing deepens the fill instead of sinking the control. The base sets every box property
   the legacy `button` rules touch, so the look is identical inside or outside `.fx`. */
export const buttonVariants = cva(
  [
    'relative inline-flex shrink-0 select-none items-center justify-center gap-1.75 whitespace-nowrap',
    'border border-solid font-ui font-semibold transform-none',
    'transition-[background-color,border-color,color,box-shadow,opacity] duration-micro ease-out-quint',
    'cursor-pointer focus-ring',
    'data-disabled:cursor-not-allowed data-disabled:opacity-45 aria-busy:cursor-progress',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        default:
          'rounded-sm border-transparent bg-surface text-ink shadow-ring not-data-disabled:hover:shadow-ring-hover not-data-disabled:active:bg-paper-deep',
        primary: 'rounded-pill border-transparent bg-ink text-paper shadow-none not-data-disabled:hover:bg-ink/85 not-data-disabled:active:bg-ink',
        secondary:
          'rounded-pill border-line bg-paper text-ink shadow-none not-data-disabled:hover:border-ink/20 not-data-disabled:hover:text-ink not-data-disabled:active:bg-paper-deep',
        ghost:
          'rounded-sm border-transparent bg-transparent text-ink shadow-ring not-data-disabled:hover:bg-paper-deep not-data-disabled:hover:shadow-ring-hover',
        danger: 'rounded-sm border-transparent bg-danger text-on-danger shadow-none not-data-disabled:hover:bg-danger-hover',
        bare: 'rounded-sm border-transparent bg-transparent text-ink-soft shadow-none not-data-disabled:hover:bg-paper-deep not-data-disabled:hover:text-ink',
        link: 'border-transparent bg-transparent text-ink shadow-none underline-offset-4 not-data-disabled:hover:underline',
        brand: 'rounded-pill border-transparent bg-brand text-on-brand shadow-none not-data-disabled:hover:bg-brand-hover',
      },
      size: {
        sm: "h-7 px-2.5 py-0 text-label leading-4 [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 px-3 py-0 text-body leading-4 [&_svg:not([class*='size-'])]:size-4",
        lg: "h-10 px-4 py-0 text-copy leading-5 [&_svg:not([class*='size-'])]:size-[18px]",
        icon: "size-8 p-0 text-body leading-none [&_svg:not([class*='size-'])]:size-4",
        'icon-sm': "size-7 p-0 text-label leading-none [&_svg:not([class*='size-'])]:size-3.5",
      },
      block: { true: 'w-full', false: '' },
    },
    compoundVariants: [{ variant: 'link', className: 'h-auto px-0' }],
    defaultVariants: { variant: 'default', size: 'md', block: false },
  },
);

export interface ButtonProps
  extends Omit<React.ComponentPropsWithoutRef<'button'>, 'disabled'>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
  disabled?: boolean;
  /** Tooltip explaining why it is disabled; switches to aria-disabled so the reason stays reachable. */
  disabledReason?: React.ReactNode;
  /** Busy: spinner over the (invisible) label, width preserved, aria-busy, activation blocked. */
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    block,
    asChild = false,
    type,
    disabled = false,
    disabledReason,
    loading = false,
    children,
    onClick,
    onPointerDown,
    onKeyDown,
    ...props
  },
  ref,
) {
  const explained = disabled && hasReason(disabledReason);
  /* A native `disabled` only on a real <button> without a reason; everything else stays
     focusable and is guarded here instead. */
  const nativeDisabled = disabled && !explained && !asChild;
  const softDisabled = disabled && !nativeDisabled;
  const handlers = guardActivation<HTMLButtonElement>(softDisabled || loading, { onClick, onPointerDown, onKeyDown });
  const Comp = asChild ? Slot : 'button';

  /* `data-disabled` follows the spread: a Radix trigger rendering this `asChild` passes
     `data-disabled: undefined`, which would otherwise erase the disabled look. */
  const element = (
    <Comp
      ref={ref}
      data-slot="button"
      data-variant={variant ?? 'default'}
      data-size={size ?? 'md'}
      {...(asChild ? {} : { type: type ?? 'button', disabled: nativeDisabled || undefined })}
      aria-disabled={softDisabled ? true : undefined}
      aria-busy={loading ? true : undefined}
      className={cn(buttonVariants({ variant, size, block }), className)}
      {...props}
      data-disabled={disabled || loading ? '' : undefined}
      {...handlers}
    >
      {asChild ? (
        children
      ) : (
        <>
          <span
            data-slot="button-label"
            className={cn('inline-flex min-w-0 items-center gap-[inherit]', loading && 'invisible')}
          >
            {children}
          </span>
          {loading ? <Spinner size="sm" className="absolute" /> : null}
        </>
      )}
    </Comp>
  );

  return explained ? <Tooltip label={disabledReason}>{element}</Tooltip> : element;
});
