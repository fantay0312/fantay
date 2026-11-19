// SPDX-License-Identifier: AGPL-3.0-only
// Step out, the level, step in: the same control as the board header's zoom (BoardZoomMenu), so the
// two read as one. The level opens the menu with "fit" and the presets. Used by every viewer that
// shows a scalable object (image, PDF, slides, model).
'use client';

import { Minus, Plus } from 'lucide-react';

import { useT } from '../../../i18n';
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
} from '../../ui';

/** The stops the step buttons walk through (1 = 100%). */
export const ARTIFACT_ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 1, 1.25, 1.5, 2, 3, 4, 6, 8] as const;
export const ARTIFACT_ZOOM_PRESETS = [0.5, 1, 2] as const;

const EPSILON = 1e-3;

/** Two zooms the control shows as the same percentage are one level to the reader. */
function sameLevel(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/**
 * The next stop above (`direction` 1) or below (-1) the current zoom, clamped to the range. A stop
 * that reads as the same percentage is skipped: a picture fitted at 66.6% steps to 75%, not to a
 * 67% that looks like nothing happened.
 */
export function nextZoomStep(zoom: number, direction: 1 | -1, min: number, max: number): number {
  const stops = ARTIFACT_ZOOM_STEPS.filter((stop) => stop >= min - EPSILON && stop <= max + EPSILON);
  if (direction === 1) {
    const up = stops.find((stop) => stop > zoom + EPSILON && !sameLevel(stop, zoom));
    return Math.min(max, up ?? max);
  }
  const down = [...stops].reverse().find((stop) => stop < zoom - EPSILON && !sameLevel(stop, zoom));
  return Math.max(min, down ?? min);
}

export interface ArtifactZoomProps {
  /** Current zoom (1 = 100%), or null while the object has no size yet. */
  zoom: number | null;
  min?: number;
  max?: number;
  presets?: readonly number[];
  onZoom(zoom: number): void;
  /** "Fit to window". Omit when the viewer has no fit. */
  onFit?(): void;
  /** Label of the fit item, when it is not the default "fit to window" (a PDF fits to width). */
  fitLabel?: string;
}

export function ArtifactZoom({
  zoom,
  min = 0.1,
  max = 8,
  presets = ARTIFACT_ZOOM_PRESETS,
  onZoom,
  onFit,
  fitLabel,
}: ArtifactZoomProps): JSX.Element {
  const t = useT();
  const ready = zoom !== null && Number.isFinite(zoom) && zoom > 0;
  const percent = ready ? Math.round(zoom * 100) : null;
  const atMin = ready && zoom <= min + EPSILON;
  const atMax = ready && zoom >= max - EPSILON;

  return (
    <Toolbar
      aria-label={t('artifact.zoom.controls')}
      data-artifact-zoom=""
      className="h-7 gap-px rounded-pill p-0.5 shadow-ring"
    >
      <ToolbarControl
        label={t('fantayShell.workspace.zoomOut')}
        side="bottom"
        disabled={!ready || atMin}
        className="size-6"
        onClick={() => {
          if (ready) onZoom(nextZoomStep(zoom, -1, min, max));
        }}
      >
        <Icon icon={Minus} size="sm" />
      </ToolbarControl>
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={!ready}>
          <ToolbarButton
            aria-label={t('fantayShell.workspace.zoomMenu', { percent: percent ?? 100 })}
            className="size-6 w-auto min-w-12 px-1.5 font-mono text-label font-semibold leading-tight tabular-nums text-ink"
          >
            {percent === null ? '—' : `${percent}%`}
          </ToolbarButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" width="sm">
          {onFit ? (
            <>
              <DropdownMenuItem onSelect={onFit}>{fitLabel ?? t('artifact.zoom.fit')}</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          ) : null}
          {presets.map((preset) => (
            <DropdownMenuItem key={preset} onSelect={() => onZoom(Math.min(max, Math.max(min, preset)))}>
              {t('fantayShell.workspace.zoomTo', { percent: Math.round(preset * 100) })}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <ToolbarControl
        label={t('fantayShell.workspace.zoomIn')}
        side="bottom"
        disabled={!ready || atMax}
        className="size-6"
        onClick={() => {
          if (ready) onZoom(nextZoomStep(zoom, 1, min, max));
        }}
      >
        <Icon icon={Plus} size="sm" />
      </ToolbarControl>
    </Toolbar>
  );
}
