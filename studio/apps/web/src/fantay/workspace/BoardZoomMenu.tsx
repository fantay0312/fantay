/*
 * SPDX-License-Identifier: AGPL-3.0-only
 *
 * Fantay — derived from Doop (https://github.com/kgoedecke/doop)
 *   source: src/components/ZoomControls.tsx @ d261a85d3f9d87ac0653bb8512915f4e5bdff2b9
 *   Copyright (c) the Doop contributors. Licensed under the GNU Affero General Public License v3.0
 *   (see licenses/doop-AGPL-3.0.txt and THIRD_PARTY_NOTICES.md). "Doop" is a trademark of its
 *   owner and is not used to brand Fantay.
 * Modifications Copyright (c) 2026 Fantay contributors, AGPL-3.0-only: sits in the workspace header
 *   instead of floating over the canvas; the store/ref coupling is replaced by `useBoardViewport` and
 *   `runFantayCommand`; "—" and disabled steps without a published viewport, steps disabled at the
 *   zoom limits; Fantay i18n; selection/ruler items moved to the board context menus (plan R7).
 */
import { Minus, Plus } from 'lucide-react';
import { useRef } from 'react';

import { useT } from '../../i18n';
import { runFantayCommand } from '../shell/commands';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  Toolbar,
  ToolbarButton,
  ToolbarControl,
  cn,
} from '../ui';
import { useBoardViewport, type FantayBoardViewportSnapshot } from './board-viewport-store';

/** Preset zooms of the menu (1 = 100%). */
export const BOARD_ZOOM_PRESETS = [0.5, 1, 2] as const;

const LIMIT_EPSILON = 1e-3;

/* 24px steps in a 28px group: the same height as the root-tab Segmented and the sm Share button that
   share the 44px header row (spec 02 §7.5 says h-8; one control height per row wins). */
const STEP_BUTTON = 'size-6';

/** The percentage the trigger shows, or null when there is no usable snapshot ("—"). */
export function boardZoomPercent(viewport: FantayBoardViewportSnapshot | null): number | null {
  if (!viewport || !Number.isFinite(viewport.zoom) || viewport.zoom <= 0) return null;
  return Math.round(viewport.zoom * 100);
}

export interface BoardZoomMenuProps {
  projectId: string;
  className?: string;
}

/* Step out, the current level, step in. The level opens a menu with the steps, the fit and the
   preset zooms. Every item runs a `fantay.board.*` command; the board registers those only while it
   is mounted and active, so the header never reaches into the board. Without a published viewport
   (board loading, or not the active surface) the level reads "—" and nothing is clickable. */
export function BoardZoomMenu({ projectId, className }: BoardZoomMenuProps) {
  const t = useT();
  const viewport = useBoardViewport(projectId);
  const percent = boardZoomPercent(viewport);
  const lastPercentRef = useRef<number>(100);
  if (percent !== null) {
    lastPercentRef.current = percent;
  }
  const shownPercent = percent ?? lastPercentRef.current;
  const ready = viewport !== null && percent !== null;
  const atMin = ready && viewport.zoom <= viewport.minZoom + LIMIT_EPSILON;
  const atMax = ready && viewport.zoom >= viewport.maxZoom - LIMIT_EPSILON;
  const levelLabel = t('fantayShell.workspace.zoomMenu', { percent: shownPercent });

  return (
    <Toolbar
      aria-label={t('fantayShell.workspace.zoomControls')}
      data-testid="fantay-board-zoom"
      data-ready={ready ? 'true' : 'false'}
      className={cn('h-7 gap-px rounded-pill p-0.5 shadow-ring', className)}
    >
      <ToolbarControl
        label={t('fantayShell.workspace.zoomOut')}
        shortcut="mod+−"
        side="bottom"
        disabled={!ready || atMin}
        className={STEP_BUTTON}
        data-testid="fantay-board-zoom-out"
        onClick={() => {
          runFantayCommand('fantay.board.zoomOut');
        }}
      >
        <Icon icon={Minus} size="sm" />
      </ToolbarControl>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!ready}>
          <ToolbarButton
            aria-label={levelLabel}
            data-testid="fantay-board-zoom-trigger"
            className="size-6 w-auto min-w-12 px-1.5 font-mono text-label font-semibold leading-tight tabular-nums text-ink"
          >
            {`${shownPercent}%`}
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" width="md" data-testid="fantay-board-zoom-menu">
          <DropdownMenuItem
            shortcut="mod++"
            disabled={atMax}
            data-testid="fantay-board-zoom-menu-in"
            onSelect={() => {
              runFantayCommand('fantay.board.zoomIn');
            }}
          >
            {t('fantayShell.workspace.zoomIn')}
          </DropdownMenuItem>
          <DropdownMenuItem
            shortcut="mod+−"
            disabled={atMin}
            data-testid="fantay-board-zoom-menu-out"
            onSelect={() => {
              runFantayCommand('fantay.board.zoomOut');
            }}
          >
            {t('fantayShell.workspace.zoomOut')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            shortcut="shift+1"
            data-testid="fantay-board-zoom-menu-fit"
            onSelect={() => {
              runFantayCommand('fantay.board.zoomFit');
            }}
          >
            {t('fantayShell.workspace.zoomFit')}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          {BOARD_ZOOM_PRESETS.map((zoom) => (
            <DropdownMenuItem
              key={zoom}
              shortcut={zoom === 1 ? 'mod+0' : undefined}
              data-testid={`fantay-board-zoom-menu-${Math.round(zoom * 100)}`}
              onSelect={() => {
                runFantayCommand('fantay.board.zoomTo', { zoom });
              }}
            >
              {t('fantayShell.workspace.zoomTo', { percent: Math.round(zoom * 100) })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarControl
        label={t('fantayShell.workspace.zoomIn')}
        shortcut="mod++"
        side="bottom"
        disabled={!ready || atMax}
        className={STEP_BUTTON}
        data-testid="fantay-board-zoom-in"
        onClick={() => {
          runFantayCommand('fantay.board.zoomIn');
        }}
      >
        <Icon icon={Plus} size="sm" />
      </ToolbarControl>
    </Toolbar>
  );
}
