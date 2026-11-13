/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/dash.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: rail density only (31 px rows,
 *   11 px gaps); the row and the section caption are Fantay `Button`s (one focus ring, drawn inset so a
 *   collapsing list cannot clip it), the caption is a toggle with aria-expanded and a 12 px label, the
 *   sidebar ground is the `--sidebar` token; dropped Logo, Wordmark, navigate, useRailDrawer, DashBrand,
 *   DashHeader, DashMain, DashContent, DashTitle, DashSubtitle.
 */
import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Button, type ButtonProps } from '../../ui/button';
import { cn } from '../../ui/cn';
import { Icon } from '../../ui/icons';

/* The sidebar column: the app ground, a hairline on its inline end, a flex column the header, the
   scroll body and the rail stack into. */
export const DashSidebar = React.forwardRef<HTMLElement, React.ComponentPropsWithoutRef<'aside'>>(function DashSidebar(
  { className, ...props },
  ref,
) {
  return (
    <aside
      ref={ref}
      data-slot="dash-sidebar"
      className={cn('flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-sidebar text-ink', className)}
      {...props}
    />
  );
});

/* Inside a narrow rail (`[data-rail=narrow]`) a row shrinks to its glyph; the label stays for screen readers. */
const NARROW_ROW =
  '[[data-rail=narrow]_&]:size-8 [[data-rail=narrow]_&]:justify-center [[data-rail=narrow]_&]:gap-0 [[data-rail=narrow]_&]:px-0';

/* The rail's row: 31 px tall, 11 px gaps, regular weight; the paper-deep fill on hover and when active. The
   label slot grows so a trailing status sits at the row's end. */
export const dashNavItemClass = cn(
  'h-[31px] w-full min-w-0 justify-start gap-[11px] rounded-row px-[11px] py-0 text-start text-body font-normal text-ink-soft',
  'not-data-disabled:hover:bg-paper-deep not-data-disabled:hover:text-ink data-active:bg-paper-deep data-active:font-medium data-active:text-ink',
  /* The label leads: glyphs rest one step quieter and join it on hover and when active. */
  '[&_svg]:text-ink-faint [&_svg]:transition-colors [&_svg]:duration-enter not-data-disabled:hover:[&_svg]:text-ink data-active:[&_svg]:text-ink',
  'focus-visible:-outline-offset-2 [&>[data-slot=button-label]]:flex-1',
  NARROW_ROW,
);

export interface DashNavItemProps extends Omit<ButtonProps, 'variant' | 'size' | 'children'> {
  icon?: React.ReactNode;
  /** Anything at the row's end (a status dot), drawn as given. */
  trailing?: React.ReactNode;
  active?: boolean;
  children: React.ReactNode;
}

/** One row of the sidebar (a navigation target). `active` → `data-active` + `aria-current="page"`. */
export const DashNavItem = React.forwardRef<HTMLButtonElement, DashNavItemProps>(function DashNavItem(
  { icon, trailing, active = false, className, children, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="bare"
      size="md"
      data-slot="dash-nav-item"
      data-active={active ? '' : undefined}
      aria-current={active ? 'page' : undefined}
      className={cn(dashNavItemClass, className)}
      {...props}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate text-start [[data-rail=narrow]_&]:sr-only">{children}</span>
      {trailing !== undefined && trailing !== null ? (
        <span className="ms-auto flex flex-none items-center [[data-rail=narrow]_&]:hidden">{trailing}</span>
      ) : null}
    </Button>
  );
});

export interface DashSectionLabelProps extends Omit<ButtonProps, 'variant' | 'size' | 'children' | 'onToggle'> {
  expanded: boolean;
  children: React.ReactNode;
}

/** The caption over a sidebar group: a quiet 12 px toggle whose chevron turns −90° when the group folds. */
export const DashSectionLabel = React.forwardRef<HTMLButtonElement, DashSectionLabelProps>(function DashSectionLabel(
  { expanded, className, children, ...props },
  ref,
) {
  return (
    <Button
      ref={ref}
      variant="bare"
      size="sm"
      data-slot="dash-section-label"
      aria-expanded={expanded}
      className={cn(
        'h-auto min-w-0 flex-1 justify-start gap-[5px] rounded-row px-[11px] pb-1.5 pt-3.5 text-label font-normal leading-4 text-ink-faint',
        'not-data-disabled:hover:bg-transparent not-data-disabled:hover:text-ink-soft focus-visible:-outline-offset-2',
        '[[data-rail=narrow]_&]:hidden',
        className,
      )}
      {...props}
    >
      <span className="truncate">{children}</span>
      <Icon
        icon={ChevronDown}
        size={11}
        className={cn(
          'flex-none text-ink-ghost transition-[transform,opacity] duration-enter ease-out-quint motion-reduce:transition-none',
          /* Open groups keep their caption clean; a folded one always shows why its rows are missing. */
          expanded ? 'opacity-0 group-hover/section:opacity-100 group-focus-within/section:opacity-100' : '-rotate-90 duration-exit',
        )}
      />
    </Button>
  );
});
