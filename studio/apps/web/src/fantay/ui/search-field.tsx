'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/search-field.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: 32px ring field (control
 *   height), brand focus halo, body text size without the mobile 16px step, Fantay tokens.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { SearchIcon } from './icons';
import { Input, type InputProps } from './input';

export type SearchFieldVariant = 'ring' | 'bar';
export type SearchFieldSize = 'default' | 'header';

/* A leading glyph, a bare input, room for a shortcut hint or a clear button. `ring` is the pill
   in a page header; `bar` is a palette's top line closed by a hairline. The label is the hit
   area, so a click anywhere in the field focuses the input. `size="header"`: its own full-width
   40px row on a phone, the 32px field (≤ 320px) beside the title from md up. */
export const searchFieldVariants = cva('flex flex-row min-w-0 cursor-text items-center font-ui text-body text-ink-faint', {
  variants: {
    variant: {
      ring: 'h-8 gap-[7px] rounded-control bg-surface px-2.5 shadow-ring transition-shadow duration-micro ease-out-quint focus-within:shadow-elevation-1-focus',
      bar: 'h-12 gap-2.5 border-0 border-b border-solid border-line-soft px-4',
    },
    size: {
      default: '',
      header: 'order-2 h-10 max-w-none flex-1 basis-full md:order-none md:h-8 md:max-w-[320px] md:basis-auto',
    },
  },
  defaultVariants: { variant: 'ring', size: 'default' },
});

export interface SearchFieldProps extends Omit<InputProps, 'variant' | 'inputSize' | 'size'> {
  variant?: SearchFieldVariant;
  size?: SearchFieldSize;
  /** Classes for the input itself (`className` styles the shell). */
  inputClassName?: string;
  /** A shortcut hint (Kbd) or a clear button after the input. */
  trailing?: React.ReactNode;
}

export const SearchField = React.forwardRef<HTMLInputElement, SearchFieldProps>(function SearchField(
  { className, inputClassName, variant = 'ring', size = 'default', trailing, type, ...props },
  ref,
) {
  return (
    <label data-slot="search-field" data-variant={variant} className={cn(searchFieldVariants({ variant, size }), className)}>
      <SearchIcon size={variant === 'bar' ? 'md' : 'sm'} className="flex-none" />
      <Input
        ref={ref}
        type={type ?? 'text'}
        variant="bare"
        inputSize="auto"
        className={cn('h-full flex-1 text-ink', inputClassName)}
        {...props}
      />
      {trailing}
    </label>
  );
});
