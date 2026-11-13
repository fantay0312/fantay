'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original (plan R14): a native role="progressbar" meter — no @radix-ui/react-progress.
 * Brand indicator on a paper-deep track; `value={null}` is indeterminate (pulsing, no valuenow).
 */
import * as React from 'react';

import { cn } from './cn';

export interface ProgressProps extends Omit<React.ComponentPropsWithoutRef<'div'>, 'role' | 'children'> {
  /** Current value; `null`/`undefined` = indeterminate. Clamped to [0, max]. */
  value?: number | null;
  /** Default 100. */
  max?: number;
  indicatorClassName?: string;
}

export const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(function Progress(
  { value, max = 100, className, indicatorClassName, ...props },
  ref,
) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const determinate = typeof value === 'number' && Number.isFinite(value);
  const clamped = determinate ? Math.max(0, Math.min(safeMax, value)) : 0;
  const percent = (clamped / safeMax) * 100;
  const state = !determinate ? 'indeterminate' : clamped >= safeMax ? 'complete' : 'loading';
  return (
    <div
      ref={ref}
      role="progressbar"
      data-slot="progress"
      data-state={state}
      aria-valuemin={0}
      aria-valuemax={safeMax}
      aria-valuenow={determinate ? clamped : undefined}
      className={cn('relative h-[5px] w-full flex-none overflow-hidden rounded-full bg-paper-deep', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className={cn(
          'h-full rounded-full bg-brand',
          determinate
            ? 'transition-[width] duration-slow ease-out-quint motion-reduce:transition-none'
            : 'w-full animate-fx-skeleton motion-reduce:animate-none',
          indicatorClassName,
        )}
        style={determinate ? { width: `${percent}%` } : undefined}
      />
    </div>
  );
});
