'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/switch.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: RTL thumb travel,
 *   self-sufficient root, the one focus ring, disabled per D3, Fantay tokens.
 */
import * as React from 'react';
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { cva } from 'class-variance-authority';

import { cn } from './cn';

/* An on/off setting that applies the moment it flips. Brand fill when on, a line-grey track
   when off, and a surface thumb lifted by the ring shadow, so it reads in both themes.
   `justify-start` is load-bearing: the legacy `button { justify-content: center }` would
   otherwise centre the thumb before its translate, pushing it past the track's end. */
export const switchVariants = cva(
  'peer relative inline-flex flex-none cursor-pointer items-center justify-start rounded-full border-0 border-solid border-transparent p-0 shadow-none transform-none transition-colors duration-micro ease-out-quint focus-ring data-disabled:cursor-not-allowed data-disabled:opacity-45 data-[state=checked]:bg-info data-[state=unchecked]:bg-[var(--switch-off-track,var(--line))]',
  {
    variants: {
      size: {
        sm: 'h-4 w-[26px]',
        md: 'h-5 w-[34px]',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export const switchThumbVariants = cva(
  'pointer-events-none block rounded-full bg-surface shadow-ring transition-transform duration-micro ease-out-quint motion-reduce:transition-none data-[state=unchecked]:translate-x-0.5 rtl:data-[state=unchecked]:-translate-x-0.5',
  {
    variants: {
      size: {
        sm: 'size-3 data-[state=checked]:translate-x-3 rtl:data-[state=checked]:-translate-x-3',
        md: 'size-4 data-[state=checked]:translate-x-4 rtl:data-[state=checked]:-translate-x-4',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface SwitchProps extends React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root> {
  size?: 'sm' | 'md';
}

export const Switch = React.forwardRef<React.ElementRef<typeof SwitchPrimitive.Root>, SwitchProps>(function Switch(
  { className, size = 'md', ...props },
  ref,
) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      data-slot="switch"
      data-size={size}
      className={cn(switchVariants({ size }), className)}
      {...props}
    >
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className={switchThumbVariants({ size })} />
    </SwitchPrimitive.Root>
  );
});
