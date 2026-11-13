// SPDX-License-Identifier: AGPL-3.0-only
// Board defaults (spec 03 §4.0, §4.6, §4.7 with plan R1): sizes come from the contract (`BOARD_DEFAULT_SIZES`,
// `BOARD_DEVICE_SIZES`, `defaultBoardNodeSize`), colours from `BOARD_PALETTE` (UI swatches: notes
// yellow/violet/green/blue/gray where gray is the "paper" look; shapes ink/gray/violet/green/orange/red).
import {
  BOARD_DEFAULT_SIZES,
  BOARD_DEVICE_SIZES,
  BOARD_PALETTE,
  type BoardColor,
  type BoardDevice,
  type BoardNoteSize,
  type BoardPaletteColor,
  type BoardTextStyle,
} from '@open-design/contracts';

import type { DictKey, Size } from './types';

export interface ColorSwatch {
  color: BoardPaletteColor;
  labelKey: DictKey;
}

/** Note colours offered in the UI (03 §4.6, R1). `gray` is the paper-coloured note. */
export const NOTE_SWATCHES: readonly ColorSwatch[] = [
  { color: 'yellow', labelKey: 'board.color.yellow' },
  { color: 'violet', labelKey: 'board.color.violet' },
  { color: 'green', labelKey: 'board.color.green' },
  { color: 'blue', labelKey: 'board.color.blue' },
  { color: 'gray', labelKey: 'board.color.gray' },
];

/**
 * Shape fill/stroke colours offered in the UI (R1). `gray` has no own W0 key yet: it reuses
 * `board.color.paper` (i18n-extra `board.color.gray`, see notes).
 */
export const SHAPE_SWATCHES: readonly ColorSwatch[] = [
  { color: 'ink', labelKey: 'board.color.ink' },
  { color: 'gray', labelKey: 'board.color.gray' },
  { color: 'violet', labelKey: 'board.color.violet' },
  { color: 'green', labelKey: 'board.color.green' },
  { color: 'orange', labelKey: 'board.color.orange' },
  { color: 'red', labelKey: 'board.color.red' },
];

export const NOTE_DEFAULT_COLOR: BoardPaletteColor = 'yellow';
export const NOTE_DEFAULT_SIZE: BoardNoteSize = 'md';
/** Note text size per `size` (world px, 03 §4.6). */
export const NOTE_FONT_SIZES: Readonly<Record<BoardNoteSize, number>> = { sm: 13, md: 16, lg: 22 };
export const NOTE_SIZE_OPTIONS: ReadonlyArray<{ size: BoardNoteSize; labelKey: DictKey }> = [
  { size: 'sm', labelKey: 'board.size.sm' },
  { size: 'md', labelKey: 'board.size.md' },
  { size: 'lg', labelKey: 'board.size.lg' },
];

/** Shape text sizes S/M/L/XL (03 §4.7). */
export const SHAPE_TEXT_SIZES: ReadonlyArray<{ fontSize: number; labelKey: DictKey }> = [
  { fontSize: 16, labelKey: 'board.size.sm' },
  { fontSize: 24, labelKey: 'board.size.md' },
  { fontSize: 40, labelKey: 'board.size.lg' },
  { fontSize: 64, labelKey: 'board.size.xl' },
];
export const SHAPE_FONT_WEIGHTS: readonly BoardTextStyle['fontWeight'][] = [400, 600];
/** Rect corner radii offered in the UI; "full" uses the contract maximum. */
export const SHAPE_RADII: readonly number[] = [0, 8, 16, 1000];

export const DEFAULT_SHAPE_TEXT_STYLE: BoardTextStyle = { fontSize: 24, fontWeight: 500, align: 'left', color: 'ink' };
export const DEFAULT_SHAPE_FILL: BoardPaletteColor = 'gray';
export const DEFAULT_SHAPE_RADIUS = 8;

/** Size used when a draw tool is clicked instead of dragged (03 §4.0). */
export const CLICK_SHAPE_SIZE: Size = { w: 160, h: 120 };
export const CLICK_TEXT_WIDTH = 240;
export const NOTE_SIZE: Size = { w: BOARD_DEFAULT_SIZES.note.w, h: BOARD_DEFAULT_SIZES.note.h };

export type FrameDevice = Exclude<BoardDevice, 'custom'>;
export const FRAME_DEVICES: ReadonlyArray<{ device: FrameDevice; size: Size; labelKey: DictKey }> = [
  { device: 'desktop', size: { w: BOARD_DEVICE_SIZES.desktop.w, h: BOARD_DEVICE_SIZES.desktop.h }, labelKey: 'board.preset.desktop' },
  { device: 'tablet', size: { w: BOARD_DEVICE_SIZES.tablet.w, h: BOARD_DEVICE_SIZES.tablet.h }, labelKey: 'board.preset.tablet' },
  { device: 'mobile', size: { w: BOARD_DEVICE_SIZES.mobile.w, h: BOARD_DEVICE_SIZES.mobile.h }, labelKey: 'board.preset.mobile' },
];

export function isPaletteColor(value: unknown): value is BoardPaletteColor {
  return typeof value === 'string' && (BOARD_PALETTE as readonly string[]).includes(value);
}

/** CSS value of a contract colour: palette → `var(--board-color-<name>)`, `#hex` → itself, none → transparent. */
export function boardColorCss(color: BoardColor | 'none' | null | undefined, fallback?: string): string | undefined {
  if (color === 'none') return 'transparent';
  if (color === null || color === undefined) return fallback;
  if (isPaletteColor(color)) return `var(--board-color-${color})`;
  return /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(color) ? color : fallback;
}

/** Note background (`--board-note-<color>`), defaulting to yellow. */
export function noteColorCss(color: BoardPaletteColor | undefined): string {
  return `var(--board-note-${color ?? NOTE_DEFAULT_COLOR})`;
}
