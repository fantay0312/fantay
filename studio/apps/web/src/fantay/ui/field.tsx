'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/field.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: error line (role="alert"),
 *   Fantay type scale for hint/error, Fantay tokens.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

/* A control is labelled three ways, all sentence case in the UI sans: a quiet caption over a
   field in a dense panel, the label step over a form row, or a bolder body line heading a group. */
export const labelVariants = cva('block font-ui', {
  variants: {
    variant: {
      caption: 'mb-1 text-caption text-ink-faint',
      form: 'mb-1.5 text-label font-medium text-ink-soft',
      plain: 'mb-1 text-body font-semibold text-ink',
    },
  },
  defaultVariants: { variant: 'caption' },
});

export type LabelVariant = 'caption' | 'form' | 'plain';

export type LabelProps = React.ComponentPropsWithoutRef<'label'> & VariantProps<typeof labelVariants>;

export const Label = React.forwardRef<HTMLLabelElement, LabelProps>(function Label({ className, variant, ...props }, ref) {
  return <label ref={ref} data-slot="label" className={cn(labelVariants({ variant }), className)} {...props} />;
});

export interface FieldProps extends React.ComponentPropsWithoutRef<'div'> {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  htmlFor?: string;
  labelVariant?: LabelVariant;
}

/** A label, a control and an optional hint/error, stacked. */
export function Field({ label, hint, error, htmlFor, labelVariant, className, children, ...props }: FieldProps) {
  return (
    <div data-slot="field" data-invalid={error ? '' : undefined} className={cn('min-w-0', className)} {...props}>
      {label ? (
        <Label variant={labelVariant} htmlFor={htmlFor}>
          {label}
        </Label>
      ) : null}
      {children}
      {hint ? (
        <p data-slot="field-hint" className="mb-0 mt-1.5 text-caption leading-snug text-ink-faint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p data-slot="field-error" role="alert" className="mb-0 mt-1.5 text-caption text-accent-ink">
          {error}
        </p>
      ) : null}
    </div>
  );
}
