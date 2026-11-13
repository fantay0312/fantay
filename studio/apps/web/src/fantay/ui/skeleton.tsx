'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/skeleton.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: line shape, fx-skeleton pulse,
 *   decorative by default, Fantay tokens.
 */
import * as React from 'react';
import { cva } from 'class-variance-authority';

import { cn } from './cn';
import { TILE_ASPECTS, type TileAspect } from './tile';

export type SkeletonShape = 'none' | 'line' | 'row' | 'card' | 'tile';

/* The shapes a screen waits on: `line` a text line, `row` a list row, `card` a settings card,
   `tile` a Tile's footprint (cover at its aspect over a one-line body). With `none` the caller
   sizes it. */
export const skeletonVariants = cva('animate-fx-skeleton bg-paper-deep motion-reduce:animate-none', {
  variants: {
    shape: {
      none: 'rounded-control',
      line: 'h-3 rounded-tag',
      row: 'h-14 rounded-card',
      card: 'min-h-[150px] rounded-card',
      tile: 'flex flex-col rounded-panel corner-squircle',
    },
  },
  defaultVariants: { shape: 'none' },
});

export interface SkeletonProps extends React.ComponentPropsWithoutRef<'div'> {
  shape?: SkeletonShape;
  /** Staggers a grid of them so the wait reads as one wave (index × 0.12s). */
  index?: number;
  /** `tile` only: the cover aspect of the Tile it stands in for. */
  aspect?: TileAspect;
}

/** Loading placeholder: the pulse every empty tile and row shares. Decorative (aria-hidden). */
export function Skeleton({ className, shape = 'none', index = 0, aspect = '5/3', style, children, ...props }: SkeletonProps) {
  return (
    <div
      data-slot="skeleton"
      data-shape={shape}
      aria-hidden
      className={cn(skeletonVariants({ shape }), className)}
      style={{ animationDelay: `${index * 0.12}s`, ...style }}
      {...props}
    >
      {shape === 'tile' ? (
        <>
          <div className={TILE_ASPECTS[aspect]} />
          <div className="h-[60px]" />
        </>
      ) : (
        children
      )}
    </div>
  );
}
