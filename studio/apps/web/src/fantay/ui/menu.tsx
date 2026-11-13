'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/menu.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: Radix highlight states, key-cap
 *   shortcuts, shared content/label/icon recipes for the dropdown and context menus, Fantay tokens.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { KbdCombo } from './kbd';

/* The row style the dropdown and context menus share. Radix drives hover and keyboard focus
   through data-highlighted, so the two states cannot drift apart. */
export const menuItemVariants = cva(
  "relative flex w-full cursor-pointer select-none items-center gap-2.5 rounded-control border-0 bg-transparent px-2.5 py-[7px] text-start font-ui text-body font-normal leading-normal outline-none transition-colors duration-micro data-highlighted:bg-sub data-disabled:pointer-events-none data-disabled:text-ink-faint [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      tone: {
        default: 'text-ink',
        danger: 'text-accent-ink data-highlighted:bg-accent-ink/10',
      },
    },
    defaultVariants: { tone: 'default' },
  },
);

export type MenuItemTone = 'default' | 'danger';

/** The surface every menu shares (dropdown, context, sub-menus). Portaled, so it carries `fx`. */
export const menuContentClass =
  'fx overflow-x-hidden overflow-y-auto overscroll-contain rounded-card bg-surface p-1.5 font-ui text-body text-ink shadow-pop outline-none data-[state=open]:animate-fx-chip-in data-[state=closed]:animate-fx-fade-out';

/** Trailing keyboard shortcut inside a menu item. */
export function MenuShortcut({ shortcut, className }: { shortcut: string; className?: string }) {
  return <KbdCombo shortcut={shortcut} variant="plain" className={cn('ms-auto ps-3', className)} />;
}

/** Leading glyph of a menu item. */
export function MenuItemIcon({ children }: { children: React.ReactNode }) {
  return (
    <span data-slot="menu-item-icon" className="flex flex-none items-center">
      {children}
    </span>
  );
}

/** A label with a caption-size sub-line that wraps rather than hiding words. */
export function MenuItemText({ children, description }: { children: React.ReactNode; description: React.ReactNode }) {
  return (
    <span data-slot="menu-item-text" className="flex min-w-0 flex-1 flex-col">
      <span className="truncate">{children}</span>
      <span data-slot="menu-item-description" className="text-caption text-ink-faint">
        {description}
      </span>
    </span>
  );
}

export const menuSeparatorClass = 'my-0.5 h-px bg-line-soft';
export const menuCaptionClass = 'px-2.5 pb-1 pt-[7px] text-caption text-ink-faint';
export const menuLabelClass = 'px-2.5 py-1.5 text-body text-ink';
