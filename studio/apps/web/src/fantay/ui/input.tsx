'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/input.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   source: src/components/ui/search-field.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (the label shell)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: control heights 28/32/40,
 *   brand focus halo, invalid state, InputGroup shell with leading/trailing slots and a localized
 *   clear button, self-sufficient box, Fantay tokens.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { useT } from '../../i18n';
import { cn } from './cn';
import { IconButton } from './icon-button';
import { XIcon } from './icons';

export const inputVariants = cva(
  'w-full min-w-0 border-solid font-ui font-normal text-ink outline-none transform-none transition-[border-color,box-shadow,background-color] duration-micro ease-out-quint placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-accent-ink',
  {
    variants: {
      variant: {
        default:
          'rounded-row border border-line bg-surface px-3 shadow-none focus-visible:border-brand focus-visible:shadow-elevation-1-focus',
        /* a filled well in a modal or form: paper inside a hairline, the surface on focus */
        well: 'rounded-pill border border-line bg-paper px-3 shadow-none focus-visible:border-brand focus-visible:bg-surface',
        /* ids, sizes, coordinates: numeric fields */
        mono: 'rounded-control border border-line bg-surface px-2.25 font-mono shadow-none focus-visible:border-brand',
        /* lives inside another shell (InputGroup, SearchField, a composer) */
        bare: 'rounded-none border-0 bg-transparent p-0 shadow-none',
        /* an editable heading: invisible until hovered or focused */
        title:
          'rounded-control border border-transparent bg-transparent px-2 font-semibold shadow-none hover:border-line focus-visible:border-brand focus-visible:bg-surface',
      },
      inputSize: {
        sm: 'h-7 py-0 text-label',
        md: 'h-8 py-0 text-body',
        lg: 'h-10 py-0 text-copy',
        auto: '',
      },
    },
    defaultVariants: { variant: 'default', inputSize: 'md' },
  },
);

export type InputProps = React.ComponentPropsWithoutRef<'input'> & VariantProps<typeof inputVariants>;

export const Input = React.forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, variant, inputSize, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      data-slot="input"
      data-variant={variant ?? 'default'}
      data-size={inputSize ?? 'md'}
      className={cn(inputVariants({ variant, inputSize }), className)}
      {...props}
    />
  );
});

export type InputGroupSize = 'sm' | 'md' | 'lg';

const GROUP_SIZE: Record<InputGroupSize, string> = {
  sm: 'h-7 text-label',
  md: 'h-8 text-body',
  lg: 'h-10 text-copy',
};

export interface InputGroupProps extends React.ComponentPropsWithoutRef<'label'> {
  leading?: React.ReactNode;
  trailing?: React.ReactNode;
  size?: InputGroupSize;
  invalid?: boolean;
  disabled?: boolean;
}

/**
 * A field shell with leading/trailing slots. The label is the hit area, so a click anywhere
 * focuses the input. Children: `<Input variant="bare" inputSize="auto" className="h-full flex-1" />`.
 */
export function InputGroup({
  leading,
  trailing,
  size = 'md',
  invalid = false,
  disabled = false,
  className,
  children,
  ...props
}: InputGroupProps) {
  return (
    <label
      data-slot="input-group"
      data-size={size}
      data-invalid={invalid ? '' : undefined}
      data-disabled={disabled ? '' : undefined}
      className={cn(
        'flex flex-row min-w-0 cursor-text items-center gap-2 rounded-row border border-solid border-line bg-surface px-2.5 font-ui font-normal text-ink-faint',
        'transition-[border-color,box-shadow] duration-micro ease-out-quint focus-within:border-brand focus-within:shadow-elevation-1-focus',
        'data-invalid:border-accent-ink data-disabled:cursor-not-allowed data-disabled:opacity-45',
        GROUP_SIZE[size],
        className,
      )}
      {...props}
    >
      {leading ? (
        <span data-slot="input-group-leading" className="flex flex-none items-center">
          {leading}
        </span>
      ) : null}
      {children}
      {trailing ? (
        <span data-slot="input-group-trailing" className="flex flex-none items-center gap-1">
          {trailing}
        </span>
      ) : null}
    </label>
  );
}

/** The trailing × that empties an InputGroup / SearchField. */
export function InputGroupClear({ onClear, className }: { onClear(): void; className?: string }) {
  const t = useT();
  return (
    <IconButton size="xs" aria-label={t('fantay.ui.clear')} className={className} onClick={() => onClear()}>
      <XIcon />
    </IconButton>
  );
}
