'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/segmented.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: sm/md sizes passed to the
 *   items through context, required aria-label, self-sufficient items, the inset focus ring, the
 *   Settings trough (sub track, concentric corners, a chip that is raised in both themes).
 */
import * as React from 'react';
import * as ToggleGroupPrimitive from '@radix-ui/react-toggle-group';

import { cn } from './cn';

export type SegmentedSize = 'sm' | 'md';

const SegmentedSizeContext = React.createContext<SegmentedSize>('md');

type ToggleGroupRootProps = React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Root>;

export type SegmentedProps = Omit<ToggleGroupRootProps, 'type' | 'value' | 'defaultValue' | 'onValueChange'> & {
  value: string;
  onValueChange: (value: string) => void;
  /** md: 32px row (default), sm: 28px row. */
  size?: SegmentedSize;
  'aria-label': string;
};

/* One-of-N switches (canvas/board views, grid/list, theme). Radix ToggleGroup makes the row a
   single tab stop that the arrow keys move through. Deselection is swallowed: these switches
   always have exactly one answer.
   The trough is one step off its surface (`sub`); its radius is the chip's plus the 3px inset, so
   the two corners stay concentric. */
export const Segmented = React.forwardRef<HTMLDivElement, SegmentedProps>(function Segmented(
  { className, value, onValueChange, size = 'md', ...props },
  ref,
) {
  return (
    <SegmentedSizeContext.Provider value={size}>
      <ToggleGroupPrimitive.Root
        ref={ref}
        type="single"
        data-slot="segmented"
        data-size={size}
        value={value}
        onValueChange={(next: string) => {
          if (next) onValueChange(next);
        }}
        className={cn(
          'inline-flex flex-none items-center gap-px rounded-[calc(var(--radius-row)+3px)] border-0 border-solid border-transparent bg-sub p-0.75 font-ui text-label font-medium leading-tight text-ink-soft',
          className,
        )}
        {...props}
      />
    </SegmentedSizeContext.Provider>
  );
});

const ITEM_HEIGHT: Record<SegmentedSize, string> = { md: 'h-[26px]', sm: 'h-[22px]' };

export type SegmentedItemProps = React.ComponentPropsWithoutRef<typeof ToggleGroupPrimitive.Item>;

export const SegmentedItem = React.forwardRef<HTMLButtonElement, SegmentedItemProps>(function SegmentedItem(
  { className, ...props },
  ref,
) {
  const size = React.useContext(SegmentedSizeContext);
  return (
    <ToggleGroupPrimitive.Item
      ref={ref}
      data-slot="segmented-item"
      className={cn(
        'inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-row border-0 border-solid border-transparent bg-transparent px-3 py-0',
        'font-ui text-label font-medium leading-tight text-ink-soft shadow-none transform-none',
        'transition-colors duration-micro ease-out-quint not-data-disabled:hover:text-ink focus-ring-inset',
        /* The chosen segment stands proud of the trough: by a hairline shadow on white, by tone on dark, where
           `surface` would sink below `sub` and a shadow cannot show. One weight in both states, so choosing
           never reflows the row. Keyed on aria-checked, which a single ToggleGroup always sets: a Tooltip
           trigger wrapping an item overwrites Radix's data-state with its own open state. */
        'aria-checked:bg-surface aria-checked:text-ink aria-checked:shadow-[0_0_0_0.5px_rgba(24,24,27,0.06),0_1px_2px_rgba(24,24,27,0.08)]',
        'dark:aria-checked:bg-[color-mix(in_srgb,var(--ink)_12%,var(--sub))] dark:aria-checked:shadow-none',
        "data-disabled:cursor-not-allowed data-disabled:opacity-45 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
        ITEM_HEIGHT[size],
        className,
      )}
      {...props}
    />
  );
});

/** Icon-only variant (grid / list): a surface shell of square items; the chosen one fills. */
export const SegmentedIcons = React.forwardRef<HTMLDivElement, SegmentedProps>(function SegmentedIcons(
  { className, ...props },
  ref,
) {
  return <Segmented ref={ref} className={cn('gap-0 overflow-hidden bg-surface', className)} {...props} />;
});

export interface SegmentedIconItemProps extends SegmentedItemProps {
  /** Required: the item shows only a glyph. */
  'aria-label': string;
}

export const SegmentedIconItem = React.forwardRef<HTMLButtonElement, SegmentedIconItemProps>(function SegmentedIconItem(
  { className, ...props },
  ref,
) {
  return (
    <SegmentedItem
      ref={ref}
      className={cn(
        'px-2.75 text-ink-faint aria-checked:bg-paper-deep aria-checked:text-ink aria-checked:shadow-none dark:aria-checked:bg-paper-deep',
        className,
      )}
      {...props}
    />
  );
});
