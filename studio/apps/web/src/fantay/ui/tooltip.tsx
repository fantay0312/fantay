'use client';
/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ui/tooltip.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: one Provider per tooltip
 *   (works inside upstream trees), key-cap shortcut, Fantay tokens, fx-* animations, z ladder.
 */
import * as React from 'react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

import { cn } from './cn';
import { FX } from './fx';
import { KbdCombo } from './kbd';

export interface TooltipProps {
  /** The text. Falsy → the child renders unchanged, with no tooltip wiring. */
  label: React.ReactNode;
  /** A shortcut such as `'mod+k'`, drawn as key caps after the label. */
  shortcut?: string;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  delayDuration?: number;
  /** A single focusable child that forwards its ref (it becomes the trigger). */
  children: React.ReactElement;
  className?: string;
}

/* Labels for controls that show an icon and nothing else: opens promptly, follows the control,
   and works on keyboard focus (a `title` attribute does none of that). */
export function Tooltip({
  label,
  shortcut,
  side = 'top',
  align = 'center',
  delayDuration = 250,
  children,
  className,
}: TooltipProps) {
  if (!label) return children;
  return (
    <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={300}>
      <TooltipPrimitive.Root>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        <TooltipPrimitive.Portal>
          <TooltipPrimitive.Content
            data-slot="tooltip"
            side={side}
            align={align}
            sideOffset={7}
            collisionPadding={8}
            className={cn(
              FX,
              'z-(--z-fx-tooltip) flex max-w-[260px] items-center gap-2 rounded-row bg-ink px-2 py-[5px] font-ui text-caption font-medium leading-snug text-paper',
              'data-[state=delayed-open]:animate-fx-tooltip-in data-[state=instant-open]:animate-fx-tooltip-in data-[state=closed]:animate-fx-fade-out',
              className,
            )}
          >
            <span data-slot="tooltip-label">{label}</span>
            {shortcut ? <KbdCombo shortcut={shortcut} variant="onInk" /> : null}
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
