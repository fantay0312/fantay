import { describe, expect, it } from 'vitest';

import { BOARD_DEVICE_SIZES } from '../src/api/board.js';
import {
  BOARD_FRAME_PRESET_GROUPS,
  BOARD_FRAME_PRESETS,
  boardFramePresetDevice,
  boardFramePresetsInGroup,
  getBoardFramePreset,
  matchBoardFramePreset,
} from '../src/board/index.js';

describe('BOARD_FRAME_PRESETS (amendment C4)', () => {
  it('lists the device and social presets with fixed sizes', () => {
    expect(BOARD_FRAME_PRESETS.map((preset) => [preset.id, preset.group, preset.w, preset.h])).toEqual([
      ['desktop', 'device', 1440, 900],
      ['tablet', 'device', 834, 1112],
      ['mobile', 'device', 390, 844],
      ['square', 'social', 1080, 1080],
      ['portrait', 'social', 1080, 1350],
      ['story', 'social', 1080, 1920],
      ['xhs', 'social', 1242, 1660],
      ['landscape', 'social', 1200, 628],
    ]);
  });

  it('keeps device presets equal to BOARD_DEVICE_SIZES', () => {
    for (const preset of boardFramePresetsInGroup('device')) {
      const device = boardFramePresetDevice(preset);
      expect(device).toBe(preset.id);
      expect(BOARD_DEVICE_SIZES[device as keyof typeof BOARD_DEVICE_SIZES]).toEqual({ w: preset.w, h: preset.h });
    }
    for (const preset of boardFramePresetsInGroup('social')) expect(boardFramePresetDevice(preset)).toBe('custom');
  });

  it('uses board.preset.* i18n keys', () => {
    for (const preset of BOARD_FRAME_PRESETS) expect(preset.labelKey).toBe(`board.preset.${preset.id}`);
    expect(BOARD_FRAME_PRESET_GROUPS).toEqual([
      { id: 'device', labelKey: 'board.preset.group.device' },
      { id: 'social', labelKey: 'board.preset.group.social' },
    ]);
    expect(new Set(BOARD_FRAME_PRESETS.map((preset) => preset.id)).size).toBe(BOARD_FRAME_PRESETS.length);
  });

  it('looks presets up by id and by size', () => {
    expect(getBoardFramePreset('xhs')).toMatchObject({ w: 1242, h: 1660 });
    expect(getBoardFramePreset('nope')).toBeNull();
    expect(matchBoardFramePreset(1080, 1920)?.id).toBe('story');
    expect(matchBoardFramePreset(390, 844)?.id).toBe('mobile');
    expect(matchBoardFramePreset(100, 100)).toBeNull();
  });
});
