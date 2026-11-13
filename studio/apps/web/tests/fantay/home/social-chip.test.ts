// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0
// 社媒设计 (spec 02 §8.2 + amendment C4): the `social` chip is registered but stays off the create-rail order,
// its automatic default is truthful, the platform presets come from the board contract's social frame
// presets in C4 order, and the chosen size is written into the brief as one replaceable line.
import { BOARD_FRAME_PRESETS, defaultScenarioPluginIdForProjectMetadata } from '@open-design/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const seed = vi.hoisted(() => vi.fn());
vi.mock('../../../src/components/HomeView', () => ({ seedHomeComposerPrompt: seed }));

import { homeHeroChipLabel } from '../../../src/components/home-hero/chip-labels';
import {
  CREATE_RAIL_ORDER,
  HOME_TYPE_ROW_IDS,
  HOME_TYPE_ROW_MORE_IDS,
  findChip,
  orderedCreateChips,
} from '../../../src/components/home-hero/chips';
import { fantayHomeChipLabel } from '../../../src/fantay/home/chip-label-overrides';
import {
  HOME_COMPOSER_PROMPT_DRAFT_KEY,
  applySocialBriefSize,
  readHomeComposerBrief,
} from '../../../src/fantay/home/home-composer-brief';
import {
  SOCIAL_PLATFORM_PRESETS,
  briefSizeLinePattern,
  mergeBriefSizeLine,
  socialBriefSizeLine,
} from '../../../src/fantay/home/social-presets';
import { en } from '../../../src/i18n/locales/en';
import { zhCN } from '../../../src/i18n/locales/zh-CN';
import type { Dict } from '../../../src/i18n/types';

function translator(dict: Dict) {
  return (key: keyof Dict, vars?: Record<string, string | number>) => {
    const raw = dict[key];
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (_, name: string) => String(vars[name] ?? `{${name}}`));
  };
}

const tEn = translator(en);
const tZh = translator(zhCN);

describe('the social chip', () => {
  it('exists, claims a truthful automatic default and stays off the create-rail and type-row orders', () => {
    const chip = findChip('social');
    expect(chip).toBeDefined();
    expect(chip?.group).toBe('create');
    if (chip?.action.kind !== 'apply-scenario') throw new Error('social must be a scenario chip');
    expect(chip.action.automaticDefault).toBe(true);
    expect(chip.action.projectMetadata).toEqual({ kind: 'prototype', intent: 'marketing', fidelity: 'high-fidelity' });
    expect(
      defaultScenarioPluginIdForProjectMetadata({ kind: chip.action.projectKind, ...chip.action.projectMetadata }),
    ).toBe(chip.action.pluginId);
    expect(CREATE_RAIL_ORDER).not.toContain('social');
    expect(HOME_TYPE_ROW_IDS).not.toContain('social');
    expect(HOME_TYPE_ROW_MORE_IDS).not.toContain('social');
    expect(orderedCreateChips().map((entry) => entry.id)).not.toContain('social');
  });
});

describe('chip labels', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    window.localStorage.clear();
  });

  it('reads the upstream labels with the shell off (vitest default) and has a social label', () => {
    expect(homeHeroChipLabel('social', tZh)).toBe(zhCN['homeHero.chip.social']);
    expect(homeHeroChipLabel('prototype', tZh)).toBe(zhCN['homeHero.chip.prototype']);
    expect(fantayHomeChipLabel('prototype', tZh)).toBeNull();
  });

  it('reads the Fantay labels with the shell on, so the active-type pill matches the chip', () => {
    vi.stubEnv('NEXT_PUBLIC_FANTAY_SHELL', '1');
    expect(homeHeroChipLabel('prototype', tZh)).toBe('网页/应用设计');
    expect(homeHeroChipLabel('social', tZh)).toBe('社媒设计');
    expect(homeHeroChipLabel('motion-design', tZh)).toBe(zhCN['fantayHome.chip.motion']);
    expect(homeHeroChipLabel('deck', tZh)).toBe(zhCN['fantayHome.chip.deck']);
    // chips the Fantay row does not show inline keep their upstream names
    expect(homeHeroChipLabel('web-clone', tZh)).toBe(zhCN['homeHero.chip.webClone']);
  });
});

describe('platform presets (C4)', () => {
  it('uses the contract social frame presets in C4 order', () => {
    expect(SOCIAL_PLATFORM_PRESETS.map((preset) => preset.id)).toEqual(['xhs', 'story', 'square', 'portrait', 'landscape']);
    for (const preset of SOCIAL_PLATFORM_PRESETS) {
      const contract = BOARD_FRAME_PRESETS.find((entry) => entry.id === preset.id);
      expect(contract?.group).toBe('social');
      expect([preset.width, preset.height]).toEqual([contract?.w, contract?.h]);
      expect(preset.labelKey).toBe(`fantayHome.social.preset.${preset.id}`);
    }
    expect(SOCIAL_PLATFORM_PRESETS.find((preset) => preset.id === 'xhs')).toMatchObject({ width: 1242, height: 1660 });
  });

  it('formats the brief size line from fantayHome.social.briefSize', () => {
    const xhs = SOCIAL_PLATFORM_PRESETS[0]!;
    expect(socialBriefSizeLine(tZh, xhs)).toBe('画布尺寸：1242×1660（小红书 3:4）');
    expect(socialBriefSizeLine(tEn, xhs)).toBe('Canvas size: 1242×1660 (Xiaohongshu 3:4)');
  });

  it('puts exactly one size line first and replaces an earlier one', () => {
    const template = zhCN['fantayHome.social.briefSize'];
    const [xhs, story] = SOCIAL_PLATFORM_PRESETS;
    const first = socialBriefSizeLine(tZh, xhs!);
    const second = socialBriefSizeLine(tZh, story!);
    expect(briefSizeLinePattern(template).test(first)).toBe(true);
    expect(briefSizeLinePattern(template).test('画布尺寸是什么')).toBe(false);
    expect(mergeBriefSizeLine('', first, template)).toBe(`${first}\n`);
    const withBrief = mergeBriefSizeLine('做一张秋季新品海报\n突出折扣', first, template);
    expect(withBrief).toBe(`${first}\n做一张秋季新品海报\n突出折扣`);
    expect(mergeBriefSizeLine(withBrief, second, template)).toBe(`${second}\n做一张秋季新品海报\n突出折扣`);
    expect(mergeBriefSizeLine(`${first}\n`, second, template)).toBe(`${second}\n`);
  });
});

describe('writing the size into the Home brief', () => {
  beforeEach(() => {
    seed.mockClear();
    window.localStorage.clear();
  });

  it('reads the page composer draft under HOME_COMPOSER_PROMPT_DRAFT_KEY', () => {
    window.localStorage.setItem(HOME_COMPOSER_PROMPT_DRAFT_KEY, '现有的需求');
    expect(readHomeComposerBrief()).toBe('现有的需求');
  });

  it('seeds the merged brief through HomeView', async () => {
    window.localStorage.setItem(HOME_COMPOSER_PROMPT_DRAFT_KEY, '画布尺寸：1080×1080（朋友圈 / Instagram 1:1）\n春季上新');
    const next = await applySocialBriefSize(tZh, SOCIAL_PLATFORM_PRESETS[0]!);
    expect(next).toBe('画布尺寸：1242×1660（小红书 3:4）\n春季上新');
    expect(seed).toHaveBeenCalledWith(next, 'page');
  });
});
