'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/tile.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: import paths, Fantay tokens
 *   and motion scale, logical text alignment.
 */
import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './cn';

/* A card with a cover over a short body: a project, a template, a material. The shell is the
   raised surface with the panel corner; `frosted` lets the page show through at 72% and lifts
   on hover, `solid` is the plain surface. */
export const tileVariants = cva(
  'group/tile relative z-[2] flex min-w-0 transform-gpu flex-col overflow-hidden rounded-panel corner-squircle text-start font-ui text-ink shadow-elevation-1',
  {
    variants: {
      tone: {
        frosted:
          'bg-surface/72 backdrop-blur-[6px] transition-[box-shadow] duration-enter ease-out-quad hover:shadow-elevation-1-hover',
        solid: 'bg-surface',
      },
    },
    defaultVariants: { tone: 'frosted' },
  },
);

export type TileProps = React.ComponentPropsWithoutRef<'div'> & VariantProps<typeof tileVariants>;

export const Tile = React.forwardRef<HTMLDivElement, TileProps>(function Tile({ className, tone, ...props }, ref) {
  return <div ref={ref} data-slot="tile" className={cn(tileVariants({ tone }), className)} {...props} />;
});

/* the cover's proportions, as literal classes so Tailwind sees them */
export const TILE_ASPECTS = {
  '5/3': 'aspect-[5/3]',
  '16/10': 'aspect-[16/10]',
  '4/3': 'aspect-[4/3]',
} as const;

export type TileAspect = keyof typeof TILE_ASPECTS;

export interface TileCoverProps extends React.ComponentPropsWithoutRef<'div'> {
  aspect?: TileAspect;
}

/** The cover well: a preview centred on the dotted paper, with room for overlays pinned to
 *  its corners. */
export function TileCover({ className, aspect = '5/3', ...props }: TileCoverProps) {
  return (
    <div
      data-slot="tile-cover"
      className={cn(
        'relative grid place-items-center overflow-hidden border-0 border-b border-solid border-line-soft',
        '[background:radial-gradient(circle,var(--dot)_1px,transparent_1px)_0_0/18px_18px,var(--paper-deep)]',
        TILE_ASPECTS[aspect],
        className,
      )}
      {...props}
    />
  );
}

export function TileBody({ className, ...props }: React.ComponentPropsWithoutRef<'div'>) {
  return <div data-slot="tile-body" className={cn('px-3 pb-3 pt-2.5', className)} {...props} />;
}

export interface MetaLineProps extends React.ComponentPropsWithoutRef<'div'> {
  /** A badge or action after the parts, without a separator. */
  trailing?: React.ReactNode;
}

/** The caption line under a title: its parts joined by a quiet `·`. Empty parts (`false`,
 *  `null`) drop out, so a conditional part never leaves a stray separator. */
export function MetaLine({ className, children, trailing, ...props }: MetaLineProps) {
  const parts = React.Children.toArray(children);
  return (
    <div
      data-slot="meta-line"
      className={cn('flex min-w-0 items-center gap-1.5 text-caption text-ink-faint', className)}
      {...props}
    >
      {parts.map((part, index) => (
        <React.Fragment key={React.isValidElement(part) && part.key !== null ? part.key : index}>
          {index > 0 ? (
            <span aria-hidden className="opacity-60">
              ·
            </span>
          ) : null}
          {part}
        </React.Fragment>
      ))}
      {trailing}
    </div>
  );
}
