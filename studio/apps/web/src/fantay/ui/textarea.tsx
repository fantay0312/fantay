'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/textarea.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: copy size without the
 *   mobile 16px step, brand focus halo, invalid state, self-sufficient box, Fantay tokens.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

export const textareaVariants = cva(
  'block w-full min-w-0 resize-none border-solid font-ui text-copy font-normal leading-5 text-ink outline-none transform-none placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-45 aria-invalid:border-accent-ink',
  {
    variants: {
      variant: {
        default:
          'rounded-row border border-line bg-surface px-3 py-2.5 shadow-none transition-[border-color,box-shadow] duration-micro ease-out-quint focus-visible:border-brand focus-visible:shadow-elevation-1-focus',
        /* the Input well: paper inside a hairline, the surface on focus */
        well: 'rounded-pill border border-line bg-paper px-3 py-2.5 shadow-none transition-[border-color,background-color] duration-micro ease-out-quint focus-visible:border-brand focus-visible:bg-surface',
        /* an HTML/code editor: the dark code well at the caption step, tabs two wide */
        code: 'rounded-control border-0 bg-code p-3 font-mono text-caption leading-normal text-code-ink shadow-none [tab-size:2] focus-visible:shadow-elevation-1-focus',
        /* composers: the surrounding card is the field, this is just the text */
        bare: 'rounded-none border-0 bg-transparent p-0 shadow-none',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export type TextareaProps = React.ComponentPropsWithoutRef<'textarea'> & VariantProps<typeof textareaVariants>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, variant, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      data-slot="textarea"
      data-variant={variant ?? 'default'}
      className={cn(textareaVariants({ variant }), className)}
      {...props}
    />
  );
});
