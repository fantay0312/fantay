'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/panel.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (PanelTabsRoot/PanelTabs/PanelTab L144-176, PanelIconTab L181-210)
 *   source: src/components/ui/tabs.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9 (line variant)
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: one Tabs family with pill and
 *   line lists in two sizes, Fantay tokens, self-sufficient triggers, the one focus ring.
 */
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from './cn';

export const Tabs = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root>
>(function Tabs({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Root
      ref={ref}
      data-slot="tabs"
      className={cn('flex min-h-0 flex-col data-[orientation=vertical]:flex-row', className)}
      {...props}
    />
  );
});

export type TabsListVariant = 'pill' | 'line';
export type TabsListSize = 'sm' | 'md';

export interface TabsListProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.List> {
  /** pill (default): a filled active tab; line: an underline (the workspace root tabs). */
  variant?: TabsListVariant;
  /** sm: 26px tabs (default), md: 32px tabs. */
  size?: TabsListSize;
}

export const TabsList = React.forwardRef<React.ElementRef<typeof TabsPrimitive.List>, TabsListProps>(function TabsList(
  { className, variant = 'pill', size = 'sm', ...props },
  ref,
) {
  return (
    <TabsPrimitive.List
      ref={ref}
      data-slot="tabs-list"
      data-variant={variant}
      data-size={size}
      className={cn(
        'group/tabs-list min-w-0',
        variant === 'pill'
          ? 'inline-flex items-center gap-0.5'
          : 'inline-flex items-end gap-4 border-0 border-b border-solid border-line-soft',
        className,
      )}
      {...props}
    />
  );
});

const triggerBase = [
  'relative inline-flex cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap',
  'border-0 border-solid border-transparent bg-transparent py-0 font-ui font-semibold leading-tight text-ink-soft shadow-none transform-none',
  'transition-colors duration-micro ease-out-quint not-data-disabled:hover:text-ink focus-ring',
  'data-disabled:cursor-not-allowed data-disabled:opacity-45 data-[state=active]:font-semibold data-[state=active]:text-ink',
  "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  /* pill */
  'group-data-[variant=pill]/tabs-list:rounded-row group-data-[variant=pill]/tabs-list:px-2 group-data-[variant=pill]/tabs-list:data-[state=active]:bg-paper-deep',
  /* line */
  'group-data-[variant=line]/tabs-list:px-0.5',
  'after:pointer-events-none after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-ink after:opacity-0',
  'group-data-[variant=line]/tabs-list:data-[state=active]:after:opacity-100',
  /* sizes */
  'group-data-[size=sm]/tabs-list:h-[26px] group-data-[size=sm]/tabs-list:text-label',
  'group-data-[size=md]/tabs-list:h-8 group-data-[size=md]/tabs-list:text-body',
];

export const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(function TabsTrigger({ className, ...props }, ref) {
  return <TabsPrimitive.Trigger ref={ref} data-slot="tabs-trigger" className={cn(triggerBase, className)} {...props} />;
});

export interface TabsIconTriggerProps extends React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger> {
  icon: React.ReactNode;
  /** A count pinned beside the tab, outside the folding label. */
  badge?: React.ReactNode;
}

/** A tab with an icon whose label unfolds while it is the active one (an icon strip). The label
 *  stays in the DOM when folded, so the tab keeps its accessible name. */
export const TabsIconTrigger = React.forwardRef<React.ElementRef<typeof TabsPrimitive.Trigger>, TabsIconTriggerProps>(
  function TabsIconTrigger({ className, icon, badge, children, ...props }, ref) {
    return (
      <TabsPrimitive.Trigger
        ref={ref}
        data-slot="tabs-icon-trigger"
        className={cn(triggerBase, 'group/tab shrink-0 gap-0', className)}
        {...props}
      >
        <span className="grid size-3.5 shrink-0 place-items-center">{icon}</span>
        {/* a 0fr → 1fr grid track animates the label width without measuring it */}
        <span className="grid grid-cols-[0fr] opacity-0 transition-[grid-template-columns,opacity] duration-enter ease-out-quint group-data-[state=active]/tab:grid-cols-[1fr] group-data-[state=active]/tab:opacity-100 motion-reduce:transition-none">
          <span className="min-w-0 overflow-hidden">
            <span className="block whitespace-nowrap ps-[7px]">{children}</span>
          </span>
        </span>
        {badge}
      </TabsPrimitive.Trigger>
    );
  },
);

export const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(function TabsContent({ className, ...props }, ref) {
  return (
    <TabsPrimitive.Content ref={ref} data-slot="tabs-content" className={cn('min-h-0 flex-1 outline-none focus-ring-inset', className)} {...props} />
  );
});
