'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/toast.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (ToastSpinner, L40-49)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: a standalone spinner in
 *   currentColor with four sizes and an optional screen-reader status label.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

export type SpinnerSize = 'xs' | 'sm' | 'md' | 'lg';

export const spinnerVariants = cva(
  'inline-block flex-none animate-fx-spin rounded-full border-2 border-solid border-current/25 border-t-current',
  {
    variants: {
      size: {
        xs: 'size-3 border-[1.5px]',
        sm: 'size-3.5',
        md: 'size-4',
        lg: 'size-5',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface SpinnerProps {
  size?: SpinnerSize;
  /** Announced text (role="status" + visually hidden label). Absent → decorative (aria-hidden),
   *  e.g. inside a busy Button or Toast that already says what is happening. */
  label?: string;
  className?: string;
}

export function Spinner({ size = 'md', label, className }: SpinnerProps) {
  if (!label) {
    return <span data-slot="spinner" data-size={size} aria-hidden className={cn(spinnerVariants({ size }), className)} />;
  }
  return (
    <span data-slot="spinner" data-size={size} role="status" className={cn('inline-flex flex-none items-center', className)}>
      <span aria-hidden className={spinnerVariants({ size })} />
      <span className="sr-only">{label}</span>
    </span>
  );
}
