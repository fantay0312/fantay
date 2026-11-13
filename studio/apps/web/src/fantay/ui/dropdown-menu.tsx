'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/dropdown-menu.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: groups, checkbox items,
 *   sub-menus, leading icons and key-cap shortcuts, fx surface marker, z ladder, fx-* motion.
 */
import * as React from 'react';
import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { cn } from './cn';
import { CheckIcon, ChevronRightIcon } from './icons';
import {
  MenuItemIcon,
  MenuItemText,
  MenuShortcut,
  menuCaptionClass,
  menuContentClass,
  menuItemVariants,
  menuLabelClass,
  menuSeparatorClass,
  type MenuItemTone,
} from './menu';

/* A menu hanging off a button. Radix moves focus into the menu on open and back to the trigger
   on close, handles arrow keys and typeahead, and keeps the content on screen. */
export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;
export const DropdownMenuRadioGroup = DropdownMenuPrimitive.RadioGroup;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;

export type DropdownMenuWidth = 'auto' | 'sm' | 'md' | 'lg';

/* sm: a short list of verbs; md: rows with a shortcut or sub-line; lg: rows with a name and a
   detail. Unset (auto) sizes to the 340px reading width. Each gives way to a phone's width. */
const WIDTH_CLASS: Record<DropdownMenuWidth, string> = {
  auto: 'w-[min(340px,calc(100vw-24px))]',
  sm: 'w-[min(160px,calc(100vw-24px))]',
  md: 'w-[min(220px,calc(100vw-24px))]',
  lg: 'w-[min(260px,calc(100vw-24px))]',
};

export interface DropdownMenuContentProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content> {
  width?: DropdownMenuWidth;
}

export const DropdownMenuContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Content>,
  DropdownMenuContentProps
>(function DropdownMenuContent(
  { className, width = 'auto', align = 'end', sideOffset = 8, collisionPadding = 12, hideWhenDetached = true, onCloseAutoFocus, ...props },
  ref,
) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        ref={ref}
        data-slot="dropdown-menu-content"
        align={align}
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        hideWhenDetached={hideWhenDetached}
        onCloseAutoFocus={(event) => {
          onCloseAutoFocus?.(event);
          if (
            !event.defaultPrevented &&
            document.activeElement instanceof HTMLElement &&
            document.activeElement.dataset.testid === 'board-root'
          ) {
            event.preventDefault();
          }
        }}
        className={cn(
          menuContentClass,
          'z-(--z-fx-floating) max-h-(--radix-dropdown-menu-content-available-height)',
          WIDTH_CLASS[width],
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> {
  tone?: MenuItemTone;
  /** A caption-size sub-line under the label. */
  description?: React.ReactNode;
  /** e.g. `'mod+d'` → trailing key caps. */
  shortcut?: string;
  /** A leading glyph. */
  icon?: React.ReactNode;
}

export const DropdownMenuItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Item>,
  DropdownMenuItemProps
>(function DropdownMenuItem({ className, tone = 'default', description, shortcut, icon, asChild, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Item
      ref={ref}
      data-slot="dropdown-menu-item"
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
          {description === undefined ? children : <MenuItemText description={description}>{children}</MenuItemText>}
          {shortcut ? <MenuShortcut shortcut={shortcut} /> : null}
        </>
      )}
    </DropdownMenuPrimitive.Item>
  );
});

export const DropdownMenuCheckboxItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.CheckboxItem>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>
>(function DropdownMenuCheckboxItem({ className, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      ref={ref}
      data-slot="dropdown-menu-checkbox-item"
      className={cn(menuItemVariants(), className)}
      {...props}
    >
      {children}
      <DropdownMenuPrimitive.ItemIndicator className="ms-auto flex flex-none text-ink">
        <CheckIcon size="sm" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.CheckboxItem>
  );
});

export interface DropdownMenuRadioItemProps extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.RadioItem> {
  description?: React.ReactNode;
}

/** One of a set where exactly one is on; the chosen row wears a check. */
export const DropdownMenuRadioItem = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.RadioItem>,
  DropdownMenuRadioItemProps
>(function DropdownMenuRadioItem({ className, children, description, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.RadioItem
      ref={ref}
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemVariants(), className)}
      {...props}
    >
      {description === undefined ? children : <MenuItemText description={description}>{children}</MenuItemText>}
      <DropdownMenuPrimitive.ItemIndicator className="ms-auto flex flex-none text-ink">
        <CheckIcon size="sm" />
      </DropdownMenuPrimitive.ItemIndicator>
    </DropdownMenuPrimitive.RadioItem>
  );
});

export const DropdownMenuSeparator = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Separator>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Separator>
>(function DropdownMenuSeparator({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Separator
      ref={ref}
      data-slot="dropdown-menu-separator"
      className={cn(menuSeparatorClass, className)}
      {...props}
    />
  );
});

/** Non-interactive block at the top of a menu (the signed-in identity). */
export const DropdownMenuLabel = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(function DropdownMenuLabel({ className, ...props }, ref) {
  return <DropdownMenuPrimitive.Label ref={ref} data-slot="dropdown-menu-label" className={cn(menuLabelClass, className)} {...props} />;
});

/** Caption over a group of rows further down the menu. */
export const DropdownMenuCaption = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.Label>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Label>
>(function DropdownMenuCaption({ className, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Label ref={ref} data-slot="dropdown-menu-caption" className={cn(menuCaptionClass, className)} {...props} />
  );
});

export interface DropdownMenuSubTriggerProps
  extends React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger> {
  icon?: React.ReactNode;
}

export const DropdownMenuSubTrigger = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubTrigger>,
  DropdownMenuSubTriggerProps
>(function DropdownMenuSubTrigger({ className, icon, children, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      ref={ref}
      data-slot="dropdown-menu-sub-trigger"
      className={cn(menuItemVariants(), 'data-[state=open]:bg-sub', className)}
      {...props}
    >
      {icon ? <MenuItemIcon>{icon}</MenuItemIcon> : null}
      {children}
      <ChevronRightIcon size="sm" className="ms-auto flex-none text-ink-faint rtl:rotate-180" />
    </DropdownMenuPrimitive.SubTrigger>
  );
});

export const DropdownMenuSubContent = React.forwardRef<
  React.ElementRef<typeof DropdownMenuPrimitive.SubContent>,
  React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>
>(function DropdownMenuSubContent({ className, sideOffset = 6, collisionPadding = 12, hideWhenDetached = true, ...props }, ref) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        ref={ref}
        data-slot="dropdown-menu-sub-content"
        sideOffset={sideOffset}
        collisionPadding={collisionPadding}
        hideWhenDetached={hideWhenDetached}
        className={cn(
          menuContentClass,
          'z-(--z-fx-floating) max-h-(--radix-dropdown-menu-content-available-height) min-w-[180px]',
          className,
        )}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
});
