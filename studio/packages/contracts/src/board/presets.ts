// SPDX-License-Identifier: Apache-2.0
// Frame size presets for the frame "Size" menu and the social-media design flow (amendment C4).
import { BOARD_DEVICE_SIZES, type BoardDevice } from '../api/board.js';

export type BoardFramePresetGroup = 'device' | 'social';
export type BoardFramePresetId =
  | 'desktop' | 'tablet' | 'mobile'
  | 'square' | 'portrait' | 'story' | 'xhs' | 'landscape';

export interface BoardFramePreset {
  id: BoardFramePresetId;
  group: BoardFramePresetGroup;
  w: number;
  h: number;
  /** Web i18n key (`apps/web/src/i18n/types.ts`), e.g. `board.preset.xhs`. */
  labelKey: string;
}

export interface BoardFramePresetGroupInfo {
  id: BoardFramePresetGroup;
  labelKey: string;
}

export const BOARD_FRAME_PRESET_GROUPS: readonly BoardFramePresetGroupInfo[] = [
  { id: 'device', labelKey: 'board.preset.group.device' },
  { id: 'social', labelKey: 'board.preset.group.social' },
];

/**
 * Device presets mirror `BOARD_DEVICE_SIZES`. Social presets: square 1:1 (朋友圈/Instagram), portrait 4:5
 * (Instagram), story 9:16 (抖音/视频号/Stories), xhs 3:4 (小红书), landscape 1.91:1 (公众号/横幅).
 */
export const BOARD_FRAME_PRESETS: readonly BoardFramePreset[] = [
  { id: 'desktop', group: 'device', ...BOARD_DEVICE_SIZES.desktop, labelKey: 'board.preset.desktop' },
  { id: 'tablet', group: 'device', ...BOARD_DEVICE_SIZES.tablet, labelKey: 'board.preset.tablet' },
  { id: 'mobile', group: 'device', ...BOARD_DEVICE_SIZES.mobile, labelKey: 'board.preset.mobile' },
  { id: 'square', group: 'social', w: 1080, h: 1080, labelKey: 'board.preset.square' },
  { id: 'portrait', group: 'social', w: 1080, h: 1350, labelKey: 'board.preset.portrait' },
  { id: 'story', group: 'social', w: 1080, h: 1920, labelKey: 'board.preset.story' },
  { id: 'xhs', group: 'social', w: 1242, h: 1660, labelKey: 'board.preset.xhs' },
  { id: 'landscape', group: 'social', w: 1200, h: 628, labelKey: 'board.preset.landscape' },
];

export function getBoardFramePreset(id: string): BoardFramePreset | null {
  return BOARD_FRAME_PRESETS.find((preset) => preset.id === id) ?? null;
}

export function boardFramePresetsInGroup(group: BoardFramePresetGroup): BoardFramePreset[] {
  return BOARD_FRAME_PRESETS.filter((preset) => preset.group === group);
}

/** The preset whose size equals w × h exactly (device presets win over social ones), or null. */
export function matchBoardFramePreset(w: number, h: number): BoardFramePreset | null {
  return BOARD_FRAME_PRESETS.find((preset) => preset.w === w && preset.h === h) ?? null;
}

/** Frame `device` for a preset: device presets keep their device, social presets are `custom`. */
export function boardFramePresetDevice(preset: Pick<BoardFramePreset, 'id' | 'group'>): BoardDevice {
  if (preset.group === 'device' && (preset.id === 'desktop' || preset.id === 'tablet' || preset.id === 'mobile')) {
    return preset.id;
  }
  return 'custom';
}
