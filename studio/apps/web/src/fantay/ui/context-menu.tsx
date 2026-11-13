'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/context-menu.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: checkbox items, labels,
 *   sub-menus, leading icons and key-cap shortcuts, fx surface marker, z ladder, fx-* motion.
 */
import * as React from 'react';
import * as ContextMenuPrimitive from '@radix-ui/react-context-menu';

import { cn } from './cn';
import { CheckIcon, ChevronRightIcon } from './icons';
import {
  MenuItemIcon,
  MenuShortcut,
  menuCaptionClass,
  menuContentClass,
  menuItemVariants,
  menuSeparatorClass,
  type MenuItemTone,
} from './menu';

/* Right-click menus: Radix owns the pointer anchor, collision flipping, focus, arrow-key roving
   and typeahead. Content is portaled to the body, so it positions in screen coordinates and a
   zoomed board transform underneath never scales it. */
export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuGroup = ContextMenuPrimitive.Group;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

export const ContextMenuContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>
>(function ContextMenuContent({ className, collisionPadding = 8, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content
        ref={ref}
        data-slot="context-menu-content"
        collisionPadding={collisionPadding}
        className={cn(
          menuContentClass,
          'z-(--z-fx-floating) max-h-(--radix-context-menu-content-available-height) min-w-[190px]',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});

export interface ContextMenuItemProps extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> {
  tone?: MenuItemTone;
  /** e.g. `'mod+d'` → trailing key caps. */
  shortcut?: string;
  /** A leading glyph. */
  icon?: React.ReactNode;
}

export const ContextMenuItem = React.forwardRef<React.ElementRef<typeof ContextMenuPrimitive.Item>, ContextMenuItemProps>(
  function ContextMenuItem({ className, tone = 'default', shortcut, icon, asChild, children, ...props }, ref) {
    return (
      <ContextMenuPrimitive.Item
        ref={ref}
        data-slot="context-menu-item"
        data-tone={tone}
        asChild={asChild}
        className={cn(menuItemVariants({ tone }), className)}
        {...props}
      >
        {asChild ? (
          children
        ) : (
          <>
            {icon ? <MenuItemIcon>{icon}</MenuItemIcon> : null}
            {children}
            {shortcut ? <MenuShortcut shortcut={shortcut} /> : null}
          </>
        )}
      </ContextMenuPrimitive.Item>
    );
  },
);

export const ContextMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.CheckboxItem>
>(function ContextMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.CheckboxItem
      ref={ref}
      data-slot="context-menu-checkbox-item"
      className={cn(menuItemVariants(), className)}
      {...props}
    >
      {children}
      <ContextMenuPrimitive.ItemIndicator className="ms-auto flex flex-none text-ink">
        <CheckIcon size="sm" />
      </ContextMenuPrimitive.ItemIndicator>
    </ContextMenuPrimitive.CheckboxItem>
  );
});

export const ContextMenuSeparator = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Separator>
>(function ContextMenuSeparator({ className, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Separator
      ref={ref}
      data-slot="context-menu-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  );
});

/** Caption over a group of rows. */
export const ContextMenuLabel = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Label>
>(function ContextMenuLabel({ className, ...props }, ref) {
  return <ContextMenuPrimitive.Label ref={ref} data-slot="context-menu-label" className={cn(menuCaptionClass, className)} {...props} />;
});

export interface ContextMenuSubTriggerProps extends React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubTrigger> {
  icon?: React.ReactNode;
}

export const ContextMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubTrigger>,
  ContextMenuSubTriggerProps
>(function ContextMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <ContextMenuPrimitive.SubTrigger
      ref={ref}
      data-slot="context-menu-sub-trigger"
      className={cn(menuItemVariants(), 'data-[state=open]:bg-sub', className)}
      {...props}
    >
      {icon ? <MenuItemIcon>{icon}</MenuItemIcon> : null}
      {children}
      <ChevronRightIcon size="sm" className="ms-auto flex-none text-ink-faint rtl:rotate-180" />
    </ContextMenuPrimitive.SubTrigger>
  );
});

export const ContextMenuSubContent = React.forwardRef<
  React.ElementRef<typeof ContextMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.SubContent>
>(function ContextMenuSubContent({ className, collisionPadding = 8, ...props }, ref) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.SubContent
        ref={ref}
        data-slot="context-menu-sub-content"
        collisionPadding={collisionPadding}
        className={cn(
          menuContentClass,
          'z-(--z-fx-floating) max-h-(--radix-context-menu-content-available-height) min-w-[180px]',
          className,
        )}
        {...props}
      />
    </ContextMenuPrimitive.Portal>
  );
});
