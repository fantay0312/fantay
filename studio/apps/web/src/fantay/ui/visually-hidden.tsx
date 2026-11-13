'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 * Fantay-original (plan R14): text for assistive technology only (the Tailwind `sr-only`
 * recipe, which upstream's global `.sr-only` matches exactly). `asChild` hides another element.
 */
import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';

import { cn } from './cn';

export interface VisuallyHiddenProps extends React.ComponentPropsWithoutRef<'span'> {
  asChild?: boolean;
}

export const VisuallyHidden = React.forwardRef<HTMLSpanElement, VisuallyHiddenProps>(function VisuallyHidden(
  { asChild = false, className, ...props },
  ref,
) {
  const Comp = asChild ? Slot : 'span';
  return <Comp ref={ref} data-slot="visually-hidden" className={cn('sr-only', className)} {...props} />;
});
