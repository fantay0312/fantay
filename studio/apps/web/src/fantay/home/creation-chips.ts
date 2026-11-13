// SPDX-License-Identifier: AGPL-3.0-only
// The Fantay home creation chips (spec 02 §8.2), in their fixed order. Each maps onto an upstream
// HOME_HERO_CHIPS id, so a pick runs the same path as the upstream type pill (HomeHero.handlePickTaskChip →
// HomeView.pickChip). 社媒设计 is the fork's `social` chip (registered in home-hero/chips.ts, not in the
// create-rail order) and offers platform sizes (amendment C4). 更多 lists every other chip HomeHero passes.
import { AudioLines, ChartColumn, Globe, Orbit, Shapes, Sparkles, type LucideIcon } from 'lucide-react';

import type { Dict } from '../../i18n/types';

export interface FantayCreationChipDef {
  /** Fantay id (stable React key), also the chip's feature icon (`FeatureIcon name`). */
  id: 'webApp' | 'image' | 'video' | 'motion' | 'social' | 'deck' | 'document';
  /** The upstream HOME_HERO_CHIPS id the pick resolves to. */
  chipId: string;
  labelKey: keyof Dict;
}

export const FANTAY_CREATION_CHIPS: readonly FantayCreationChipDef[] = [
  { id: 'webApp', chipId: 'prototype', labelKey: 'fantayHome.chip.webApp' },
  { id: 'image', chipId: 'image', labelKey: 'fantayHome.chip.image' },
  { id: 'video', chipId: 'video', labelKey: 'fantayHome.chip.video' },
  { id: 'motion', chipId: 'motion-design', labelKey: 'fantayHome.chip.motion' },
  { id: 'social', chipId: 'social', labelKey: 'fantayHome.chip.social' },
  { id: 'deck', chipId: 'deck', labelKey: 'fantayHome.chip.deck' },
  { id: 'document', chipId: 'document', labelKey: 'fantayHome.chip.document' },
];

/** Upstream chip ids shown inline; every other chip HomeHero passes goes to 更多. */
export const FANTAY_INLINE_CHIP_IDS: ReadonlySet<string> = new Set(FANTAY_CREATION_CHIPS.map((chip) => chip.chipId));

const MORE_CHIP_ICONS: Readonly<Record<string, LucideIcon>> = {
  'web-clone': Globe,
  hyperframes: Orbit,
  'live-artifact': ChartColumn,
  webgl: Sparkles,
  audio: AudioLines,
};

/** The glyph of a chip in the 更多 menu (a neutral shape for ids without one). */
export function moreChipIcon(chipId: string): LucideIcon {
  return MORE_CHIP_ICONS[chipId] ?? Shapes;
}
