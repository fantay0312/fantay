'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/chip.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: suggestion/solid variants,
 *   sm/md sizes, warning/danger tones, removable chips (a sibling remove button, never a button
 *   inside a button), self-sufficient box, the one focus ring, Fantay tokens.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { useT } from '../../i18n';
import { cn } from './cn';
import { IconButton } from './icon-button';
import { XIcon } from './icons';

export type ChipVariant = 'suggestion' | 'solid';
export type ChipSize = 'sm' | 'md';
export type ChipTone = 'default' | 'warning' | 'danger';

/* A ring pill with an optional icon tile and a short label. A suggestion chip rests faded and
   comes fully on under the pointer, under keyboard focus, or when `on`; only colour, opacity and
   shadow change, so a row of them never jitters. */
export const chipVariants = cva(
  [
    'relative inline-flex flex-none cursor-pointer items-center gap-2 whitespace-nowrap rounded-pill border-0 border-solid border-transparent',
    'ps-[11px] pe-[13px] py-0 font-ui text-body font-semibold leading-tight transform-none',
    'transition-[opacity,box-shadow,color,background-color] duration-fast ease-out-quad focus-ring',
    'data-disabled:cursor-not-allowed data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        suggestion: 'not-data-on:opacity-60 hover:opacity-100 focus-visible:opacity-100',
        solid: '',
      },
      size: {
        sm: "h-7 [&_svg:not([class*='size-'])]:size-3.5",
        md: "h-8 [&_svg:not([class*='size-'])]:size-3.5",
      },
      tone: {
        default: 'bg-surface text-ink-soft shadow-ring not-data-disabled:hover:shadow-ring-hover data-on:text-ink',
        warning: 'bg-warning/12 text-warning-ink shadow-none',
        danger: 'bg-accent-ink/10 text-accent-ink shadow-none',
      },
    },
    defaultVariants: { variant: 'solid', size: 'md', tone: 'default' },
  },
);

export interface ChipProps extends React.ComponentPropsWithoutRef<'button'> {
  /** A glyph rendered in the 18px ChipIcon tile. */
  icon?: React.ReactNode;
  /** Highlighted (data-on). */
  on?: boolean;
  /** suggestion: rests at 60% until hover/focus/on; solid (default): always full. */
  variant?: ChipVariant;
  /** h-7 | h-8 (default). */
  size?: ChipSize;
  /** warning / danger tint a status chip (always full opacity). */
  tone?: ChipTone;
  /** Adds a trailing remove button, labelled t('fantay.ui.remove'). */
  onRemove?: () => void;
}

export const Chip = React.forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { className, icon, on = false, variant = 'solid', size = 'md', tone = 'default', onRemove, type, disabled, children, ...props },
  ref,
) {
  const t = useT();
  /* A toned chip is a status: it never rests faded. */
  const effectiveVariant: ChipVariant = tone === 'default' ? variant : 'solid';
  /* `data-disabled` follows the spread: a Radix trigger rendering this `asChild` passes
     `data-disabled: undefined`, which would otherwise erase the disabled look. */
  const chip = (
    <button
      ref={ref}
      type={type ?? 'button'}
      data-slot="chip"
      data-variant={effectiveVariant}
      data-size={size}
      data-tone={tone}
      data-on={on ? '' : undefined}
      disabled={disabled}
      className={cn(
        chipVariants({ variant: effectiveVariant, size, tone }),
        onRemove && (size === 'sm' ? 'pe-7' : 'pe-8'),
        className,
      )}
      {...props}
      data-disabled={disabled ? '' : undefined}
    >
      {icon ? <ChipIcon>{icon}</ChipIcon> : null}
      {children}
    </button>
  );
  if (!onRemove) return chip;
  return (
    <span data-slot="chip-group" className="relative inline-flex flex-none">
      {chip}
      <IconButton
        size="xs"
        shape="round"
        aria-label={t('fantay.ui.remove')}
        disabled={disabled}
        className={cn('absolute inset-y-0 my-auto', size === 'sm' ? 'end-0.5' : 'end-1')}
        onClick={() => onRemove()}
      >
        <XIcon />
      </IconButton>
    </span>
  );
});

/** The 18px tile a chip's glyph sits on: a faint ink wash with a hairline inset. */
export function ChipIcon({ className, ...props }: React.ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      data-slot="chip-icon"
      className={cn(
        'grid size-[18px] flex-none place-items-center rounded-row bg-ink/[0.06] text-ink-soft shadow-[inset_0_0_0_0.75px_var(--line)]',
        className,
      )}
      {...props}
    />
  );
}
