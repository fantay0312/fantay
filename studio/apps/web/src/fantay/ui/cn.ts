'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/lib/utils.ts @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: registers Fantay's
 *   text/radius/shadow/ease/font/animate scales and the custom duration and focus-ring utilities
 *   with tailwind-merge v3.
 */
import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/* The merger must know the design system's own scales (styles/theme.css @theme), or it files
   `text-body` under colours and drops the real colour class that sits beside it. */
export const TEXT_SCALE = ['micro', 'caption', 'label', 'body', 'copy', 'lead', 'heading', 'title', 'display'] as const;
export const RADIUS_SHAPES = ['tag', 'row', 'control', 'pill', 'card', 'panel', 'modal'] as const;
export const SHADOW_SCALE = [
  'ring',
  'ring-hover',
  'float',
  'pop',
  'modal',
  'card',
  'elevation-1',
  'elevation-1-hover',
  'elevation-1-focus',
  'elevation-2',
] as const;
export const MOTION_SCALE = ['instant', 'micro', 'fast', 'enter', 'exit', 'slow'] as const;

const twMerge = extendTailwindMerge<'fx-focus-ring'>({
  extend: {
    theme: {
      text: [...TEXT_SCALE],
      radius: [...RADIUS_SHAPES],
      shadow: [...SHADOW_SCALE],
      ease: ['out-quint', 'out-cubic', 'out-quad', 'in-out-cubic'],
      font: ['ui', 'mono'],
      animate: [
        'fx-spin',
        'fx-skeleton',
        'fx-stream',
        'fx-status',
        'fx-chip-in',
        'fx-tooltip-in',
        'fx-fade-in',
        'fx-fade-out',
        'fx-modal-in',
        'fx-modal-out',
      ],
    },
    classGroups: {
      duration: [{ duration: [...MOTION_SCALE] }],
      'fx-focus-ring': ['focus-ring', 'focus-ring-inset', 'focus-ring-within'],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
