'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/collapsible.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: self-sufficient trigger, the
 *   one focus ring, RTL chevron, Fantay tokens and motion.
 */
import * as React from 'react';
import * as CollapsiblePrimitive from '@radix-ui/react-collapsible';

import { cn } from './cn';
import { ChevronRightIcon } from './icons';

/* A disclosure whose trigger is wired to its panel: Radix sets aria-controls and aria-expanded on
   the trigger and hides the content from the accessibility tree when closed. */
export const Collapsible = CollapsiblePrimitive.Root;
export const CollapsibleContent = CollapsiblePrimitive.Content;

/** The row you click: the label, then a chevron that turns. */
export const CollapsibleTrigger = React.forwardRef<
  React.ElementRef<typeof CollapsiblePrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Trigger>
>(function CollapsibleTrigger({ className, children, type, ...props }, ref) {
  return (
    <CollapsiblePrimitive.Trigger
      ref={ref}
      type={type ?? 'button'}
      data-slot="collapsible-trigger"
      className={cn(
        'group/collapsible-trigger inline-flex cursor-pointer items-center justify-between gap-2 rounded-row border-0 border-solid border-transparent bg-transparent p-0',
        'text-start font-ui text-label font-normal leading-4 text-ink-soft shadow-none transform-none',
        'transition-colors duration-micro ease-out-quint not-data-disabled:hover:text-ink focus-ring',
        'data-disabled:cursor-not-allowed data-disabled:opacity-45',
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon
        size="xs"
        className="flex-none transition-transform duration-fast ease-out-quint motion-reduce:transition-none rtl:rotate-180 group-data-[state=open]/collapsible-trigger:rotate-90!"
      />
    </CollapsiblePrimitive.Trigger>
  );
});

export interface DisclosureProps extends Omit<React.ComponentPropsWithoutRef<typeof CollapsiblePrimitive.Root>, 'children'> {
  label: React.ReactNode;
  triggerClassName?: string;
  contentClassName?: string;
  children: React.ReactNode;
}

/** The fold-away aside in place of a `<details>`: a quiet label that turns its chevron, and the
 *  body under it. The body stays mounted while folded (hidden by its closed state), so a command
 *  or link inside it exists before anyone opens it. */
export function Disclosure({ label, className, triggerClassName, contentClassName, children, ...props }: DisclosureProps) {
  return (
    <Collapsible data-slot="disclosure" className={className} {...props}>
      <CollapsibleTrigger className={cn('justify-start', triggerClassName)}>{label}</CollapsibleTrigger>
      <CollapsibleContent forceMount className={cn('mt-2 data-[state=closed]:hidden', contentClassName)}>
        {children}
      </CollapsibleContent>
    </Collapsible>
  );
}
