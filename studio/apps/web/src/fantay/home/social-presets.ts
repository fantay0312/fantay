// SPDX-License-Identifier: AGPL-3.0-only
// 社媒设计 platform sizes (amendment C4). Sizes come from the board contract's `social` frame presets
// (`BOARD_FRAME_PRESETS`), so the home brief and the board's frame Size menu can never disagree; the order is
// C4's: 小红书 3:4, 抖音/视频号 9:16, 朋友圈 / Instagram 1:1, Instagram 4:5, 公众号封面 / 横幅 1.91:1. The chosen
// size is written into the brief as one line, `fantayHome.social.briefSize`
// (画布尺寸：{width}×{height}（{platform}）); picking another size replaces that line instead of adding one.
import { boardFramePresetsInGroup } from '@open-design/contracts';

import type { Dict } from '../../i18n/types';

export type SocialPresetId = 'xhs' | 'story' | 'square' | 'portrait' | 'landscape';

export interface SocialPlatformPreset {
  id: SocialPresetId;
  width: number;
  height: number;
  labelKey: keyof Dict;
}

const SOCIAL_PRESET_LABEL_KEYS: Readonly<Record<SocialPresetId, keyof Dict>> = {
  xhs: 'fantayHome.social.preset.xhs',
  story: 'fantayHome.social.preset.story',
  square: 'fantayHome.social.preset.square',
  portrait: 'fantayHome.social.preset.portrait',
  landscape: 'fantayHome.social.preset.landscape',
};

export const SOCIAL_PRESET_ORDER: readonly SocialPresetId[] = ['xhs', 'story', 'square', 'portrait', 'landscape'];

function isSocialPresetId(id: string): id is SocialPresetId {
  return (SOCIAL_PRESET_ORDER as readonly string[]).includes(id);
}

/** The five social presets with their contract sizes, in C4 order. */
export const SOCIAL_PLATFORM_PRESETS: readonly SocialPlatformPreset[] = (() => {
  const byId = new Map<SocialPresetId, SocialPlatformPreset>();
  for (const preset of boardFramePresetsInGroup('social')) {
    if (!isSocialPresetId(preset.id)) continue;
    byId.set(preset.id, { id: preset.id, width: preset.w, height: preset.h, labelKey: SOCIAL_PRESET_LABEL_KEYS[preset.id] });
  }
  return Object.freeze(
    SOCIAL_PRESET_ORDER.map((id) => byId.get(id)).filter((preset): preset is SocialPlatformPreset => Boolean(preset)),
  );
})();

type Translate = (key: keyof Dict, vars?: Record<string, string | number>) => string;

/** `画布尺寸：1242×1660（小红书 3:4）` in the UI locale. */
export function socialBriefSizeLine(t: Translate, preset: SocialPlatformPreset): string {
  return t('fantayHome.social.briefSize', { width: preset.width, height: preset.height, platform: t(preset.labelKey) });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Matches a whole line written from `template` (the raw `fantayHome.social.briefSize` text with its
 * `{width}` / `{height}` / `{platform}` placeholders) in any of its fillings.
 */
export function briefSizeLinePattern(template: string): RegExp {
  const parts = template.split(/(\{width\}|\{height\}|\{platform\})/);
  const body = parts
    .map((part) => {
      if (part === '{width}' || part === '{height}') return '\\d+';
      if (part === '{platform}') return '.+?';
      return escapeRegExp(part);
    })
    .join('');
  return new RegExp(`^\\s*${body}\\s*$`);
}

/**
 * The brief with exactly one size line, first: an earlier size line (from any preset, in this locale's
 * template) is replaced; the rest of the brief is kept as typed. An empty brief becomes the line plus a
 * newline, so typing continues on the next line.
 */
export function mergeBriefSizeLine(prompt: string, line: string, template: string): string {
  const pattern = briefSizeLinePattern(template);
  const kept = prompt.split('\n').filter((row) => !pattern.test(row));
  while (kept.length > 0 && kept[0]?.trim() === '') kept.shift();
  const rest = kept.join('\n');
  return rest.trim().length > 0 ? `${line}\n${rest}` : `${line}\n`;
}
