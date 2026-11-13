'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/callout.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: import paths, Fantay tokens
 *   and radius scale.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

/* A boxed message inside a form or panel: a notice that something was sent, the error a step
   failed with. Bigger than an inline hint, quieter than a modal. */
export const calloutVariants = cva('rounded-control border border-solid px-3 py-2 font-ui text-body', {
  variants: {
    tone: {
      neutral: 'border-line bg-line-soft text-ink',
      error: 'border-accent-ink/35 bg-accent-ink/10 text-accent-ink',
      success: 'border-success/35 bg-success/10 text-success-ink',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export type CalloutTone = 'neutral' | 'error' | 'success';

export type CalloutProps = React.ComponentPropsWithoutRef<'div'> & VariantProps<typeof calloutVariants>;

export function Callout({ className, tone, ...props }: CalloutProps) {
  return <div data-slot="callout" data-tone={tone ?? 'neutral'} className={cn(calloutVariants({ tone }), className)} {...props} />;
}
