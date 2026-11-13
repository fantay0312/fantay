'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/checkbox.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: 16px box, indeterminate
 *   state, glyph shown by the input's own state (uncontrolled works too), CheckboxField, the one
 *   focus ring, Fantay tokens.
 */
import * as React from 'react';

import { cn } from './cn';
import { CheckIcon, MinusIcon } from './icons';

export interface CheckboxProps extends Omit<React.ComponentPropsWithoutRef<'input'>, 'type'> {
  /** Mixed state: sets `input.indeterminate` and shows a dash. */
  indeterminate?: boolean;
  boxClassName?: string;
}

/* A square that fills with ink when checked. The real input stays in the DOM (visually hidden,
   not display:none) so the control keeps native keyboard behaviour and form semantics; the
   `peer-*` states draw the box and the focus ring. Place it inside a positioned label. */
export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, boxClassName, indeterminate = false, ...props },
  forwardedRef,
) {
  const innerRef = React.useRef<HTMLInputElement | null>(null);
  const setRef = React.useCallback(
    (node: HTMLInputElement | null) => {
      innerRef.current = node;
      if (typeof forwardedRef === 'function') forwardedRef(node);
      else if (forwardedRef) forwardedRef.current = node;
    },
    [forwardedRef],
  );

  React.useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = indeterminate;
  }, [indeterminate]);

  return (
    <>
      <input
        ref={setRef}
        type="checkbox"
        data-slot="checkbox"
        className={cn('peer pointer-events-none absolute m-0 size-4 opacity-0', className)}
        {...props}
      />
      <span
        aria-hidden="true"
        data-slot="checkbox-box"
        className={cn(
          'grid size-4 flex-none place-items-center rounded-tag border border-solid border-ink-faint bg-surface text-transparent',
          'transition-colors duration-micro ease-out-quint',
          'peer-checked:border-ink peer-checked:bg-ink peer-checked:text-paper',
          'peer-indeterminate:border-ink peer-indeterminate:bg-ink peer-indeterminate:text-paper',
          'peer-disabled:opacity-45',
          'peer-focus-visible:[outline:var(--focus-ring-width)_solid_var(--focus-ring-color)] peer-focus-visible:[outline-offset:var(--focus-ring-offset)]',
          boxClassName,
        )}
      >
        {indeterminate ? <MinusIcon size="xs" /> : <CheckIcon size="xs" />}
      </span>
    </>
  );
});

export interface CheckboxFieldProps extends CheckboxProps {
  label: React.ReactNode;
  description?: React.ReactNode;
}

/** A checkbox with its label (and an optional sub-line); the whole row is the hit area. */
export const CheckboxField = React.forwardRef<HTMLInputElement, CheckboxFieldProps>(function CheckboxField(
  { label, description, className, ...props },
  ref,
) {
  return (
    <label
      data-slot="checkbox-field"
      className={cn(
        'relative inline-flex cursor-pointer items-start gap-2 font-ui text-body text-ink has-disabled:cursor-not-allowed',
        className,
      )}
    >
      <Checkbox ref={ref} boxClassName="mt-px" {...props} />
      <span className="min-w-0">
        <span className="block">{label}</span>
        {description ? <span className="mt-0.5 block text-label text-ink-soft">{description}</span> : null}
      </span>
    </label>
  );
});

export interface CheckboxCardProps {
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  title: React.ReactNode;
  description?: React.ReactNode;
  className?: string;
}

/** A checkbox with a title and supporting copy, framed as a selectable card. */
export function CheckboxCard({ checked, disabled, onChange, title, description, className }: CheckboxCardProps) {
  return (
    <label
      data-slot="checkbox-card"
      data-checked={checked ? '' : undefined}
      className={cn(
        'relative grid cursor-pointer grid-cols-[22px_1fr] items-start gap-3 rounded-card border border-solid border-line bg-surface p-3.75 font-ui',
        'transition-[border-color,background] duration-fast ease-out-quint hover:border-ink-faint has-disabled:cursor-not-allowed',
        checked &&
          'border-ink hover:border-ink [background:linear-gradient(110deg,color-mix(in_srgb,var(--brand)_5%,transparent),transparent_72%),var(--surface)]',
        className,
      )}
    >
      <Checkbox checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} boxClassName="mt-0.5" />
      <span>
        <span className="block text-copy font-semibold leading-4 text-ink">{title}</span>
        {description ? <span className="mt-1 block text-label text-ink-soft">{description}</span> : null}
      </span>
    </label>
  );
}
