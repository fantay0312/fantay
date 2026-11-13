'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/dot.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: fx-status pulse (respects
 *   reduced motion), token radius for the square shape, Fantay tokens.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

/* Status marker. Round for a state (a run's outcome), square for an actor (an agent's colour
   swatch): the shape is how the two read apart at 8px, so it is a variant. */
export const dotVariants = cva('inline-block shrink-0', {
  variants: {
    shape: { round: 'rounded-full', square: 'rounded-[25%]' },
    tone: {
      /* takes its colour from `style` / currentColor (an agent's hue) */
      current: 'bg-current',
      idle: 'bg-ink-faint',
      running: 'bg-brand animate-fx-status motion-reduce:animate-none',
      done: 'bg-success',
      failed: 'bg-accent-ink',
      muted: 'bg-line',
    },
    size: { sm: 'size-1.5', md: 'size-2', lg: 'size-2.5' },
  },
  defaultVariants: { shape: 'round', tone: 'current', size: 'md' },
});

export type DotTone = 'current' | 'idle' | 'running' | 'done' | 'failed' | 'muted';

export type DotProps = React.ComponentPropsWithoutRef<'span'> & VariantProps<typeof dotVariants>;

export function Dot({ className, shape, tone, size, ...props }: DotProps) {
  return (
    <span
      data-slot="dot"
      data-tone={tone ?? 'current'}
      aria-hidden
      className={cn(dotVariants({ shape, tone, size }), className)}
      {...props}
    />
  );
}
