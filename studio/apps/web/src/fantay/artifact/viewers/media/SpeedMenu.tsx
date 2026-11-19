// SPDX-License-Identifier: AGPL-3.0-only
// Playback speed: the current speed as a quiet text button, the five speeds in a menu. Both players
// use it. The menu is built from the kit's parts; only the portal is its own, because a fullscreen
// film shows nothing outside itself and the menu then has to live inside the film's frame.
'use client';

import * as DropdownMenuPrimitive from '@radix-ui/react-dropdown-menu';

import { useT } from '../../../../i18n';
import {
  Button,
  DropdownMenu,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
  Tooltip,
  cn,
  menuContentClass,
} from '../../../ui';
import { PLAYBACK_RATES, formatRate } from './media-time';

export interface SpeedMenuProps {
  rate: number;
  onRate(rate: number): void;
  /** Where the menu opens. */
  side?: 'top' | 'bottom';
  /** The element the menu is rendered into; the page body when omitted. */
  container?: HTMLElement | null;
  /** True over a film: the menu is drawn dark whatever the theme, like the controls it hangs from. */
  onPicture?: boolean;
  onOpenChange?(open: boolean): void;
  className?: string;
}

export function SpeedMenu({ rate, onRate, side = 'top', container, onPicture = false, onOpenChange, className }: SpeedMenuProps): JSX.Element {
  const t = useT();
  const label = t('artifact.media.speed');
  return (
    <DropdownMenu onOpenChange={onOpenChange}>
      <Tooltip label={label} side={side}>
        <DropdownMenuTrigger asChild>
          <Button
            size="sm"
            variant="bare"
            aria-label={`${label} ${formatRate(rate)}`}
            data-media-speed=""
            className={cn('min-w-11 px-2 tabular-nums', className)}
          >
            {formatRate(rate)}
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuPrimitive.Portal container={container ?? undefined}>
        <DropdownMenuPrimitive.Content
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          aria-label={label}
          data-theme={onPicture ? 'dark' : undefined}
          className={cn(
            menuContentClass,
            'z-(--z-fx-floating) max-h-(--radix-dropdown-menu-content-available-height) w-[min(132px,calc(100vw-24px))]',
          )}
        >
          <DropdownMenuRadioGroup value={String(rate)} onValueChange={(next) => onRate(Number(next))}>
            {PLAYBACK_RATES.map((option) => (
              <DropdownMenuRadioItem key={option} value={String(option)} className="tabular-nums">
                {formatRate(option)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuPrimitive.Content>
      </DropdownMenuPrimitive.Portal>
    </DropdownMenu>
  );
}
