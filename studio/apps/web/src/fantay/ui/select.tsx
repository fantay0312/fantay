'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/select.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: control heights 28/32,
 *   menu-row items, localized placeholder, label export, self-sufficient trigger, the one focus
 *   ring, fx surface marker, z ladder, fx-* motion.
 */
import * as React from 'react';
import * as SelectPrimitive from '@radix-ui/react-select';
import { cva } from 'class-variance-authority';

import { useT } from '../../i18n';
import { cn } from './cn';
import { FX } from './fx';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from './icons';
import { menuCaptionClass, menuItemVariants, menuSeparatorClass } from './menu';

/* Pick one value from a short list. The trigger is a field-height ring control and the list
   opens in the same surface as the menus. Radix keeps the keyboard a native select has and
   returns focus to the trigger on close. Radix reserves `""` for "nothing chosen": no
   SelectItem may use it (map a real "none" choice to a sentinel). */
export const Select = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;

/** Native form select for simple settings forms; preserves browser form semantics. */
export const NativeSelect = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(function NativeSelect({ className, ...props }, ref) {
  return <select ref={ref} className={cn('h-8 min-w-0 rounded-control border border-line bg-surface px-2 text-body text-ink focus-ring', className)} {...props} />;
});

export const SelectValue = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Value>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Value>
>(function SelectValue({ placeholder, ...props }, ref) {
  const t = useT();
  return (
    <SelectPrimitive.Value
      ref={ref}
      data-slot="select-value"
      placeholder={placeholder ?? t('fantay.ui.selectPlaceholder')}
      {...props}
    />
  );
});

export type SelectTriggerSize = 'sm' | 'md';

export const selectTriggerVariants = cva(
  [
    'inline-flex min-w-0 cursor-pointer select-none items-center justify-between gap-2 whitespace-nowrap',
    'rounded-control border-0 border-solid border-transparent bg-surface py-0 ps-[11px] pe-2.5 text-start',
    'font-ui font-medium text-ink shadow-ring transform-none outline-none',
    'transition-shadow duration-micro ease-out-quint not-data-disabled:hover:shadow-ring-hover focus-ring',
    'data-disabled:cursor-not-allowed data-disabled:opacity-45 data-placeholder:font-normal data-placeholder:text-ink-faint',
    '*:data-[slot=select-value]:truncate',
  ],
  {
    variants: {
      size: {
        sm: 'h-7 text-label',
        md: 'h-8 text-body',
      },
    },
    defaultVariants: { size: 'md' },
  },
);

export interface SelectTriggerProps extends React.ComponentPropsWithoutRef<typeof SelectPrimitive.Trigger> {
  size?: SelectTriggerSize;
}

export const SelectTrigger = React.forwardRef<React.ElementRef<typeof SelectPrimitive.Trigger>, SelectTriggerProps>(
  function SelectTrigger({ className, size = 'md', children, ...props }, ref) {
    return (
      <SelectPrimitive.Trigger
        ref={ref}
        data-slot="select-trigger"
        data-size={size}
        className={cn(selectTriggerVariants({ size }), className)}
        {...props}
      >
        {children}
        <SelectPrimitive.Icon asChild>
          <ChevronDownIcon size="xs" className="flex-none text-ink-faint" />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
    );
  },
);

/* Radix hides the list's scrollbar; these arrows are the affordance a long list shows instead. */
const scrollButtonClass = 'flex h-6 flex-none cursor-default items-center justify-center bg-surface text-ink-faint';

export const SelectContent = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Content>
>(function SelectContent({ className, children, position = 'popper', sideOffset = 6, collisionPadding = 12, ...props }, ref) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        ref={ref}
        data-slot="select-content"
        position={position}
        sideOffset={position === 'popper' ? sideOffset : undefined}
        collisionPadding={collisionPadding}
        className={cn(
          FX,
          'relative z-(--z-fx-floating) max-h-[min(320px,var(--radix-select-content-available-height))] min-w-(--radix-select-trigger-width) overflow-hidden',
          'rounded-card bg-surface font-ui text-body text-ink shadow-pop',
          'data-[state=open]:animate-fx-chip-in data-[state=closed]:animate-fx-fade-out',
          className,
        )}
        {...props}
      >
        <SelectPrimitive.ScrollUpButton className={scrollButtonClass}>
          <ChevronUpIcon size="xs" />
        </SelectPrimitive.ScrollUpButton>
        <SelectPrimitive.Viewport className="p-1.5">{children}</SelectPrimitive.Viewport>
        <SelectPrimitive.ScrollDownButton className={scrollButtonClass}>
          <ChevronDownIcon size="xs" />
        </SelectPrimitive.ScrollDownButton>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
});

export const SelectItem = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Item>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Item>
>(function SelectItem({ className, children, ...props }, ref) {
  return (
    <SelectPrimitive.Item ref={ref} data-slot="select-item" className={cn(menuItemVariants(), 'pe-8', className)} {...props}>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator className="absolute end-2.5 flex text-ink">
        <CheckIcon size="sm" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
});

export const SelectLabel = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Label>
>(function SelectLabel({ className, ...props }, ref) {
  return <SelectPrimitive.Label ref={ref} data-slot="select-label" className={cn(menuCaptionClass, className)} {...props} />;
});

export const SelectSeparator = React.forwardRef<
  React.ElementRef<typeof SelectPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof SelectPrimitive.Separator>
>(function SelectSeparator({ className, ...props }, ref) {
  return (
    <SelectPrimitive.Separator ref={ref} data-slot="select-separator" className={cn(menuSeparatorClass, className)} {...props} />
  );
});
