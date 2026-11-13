// SPDX-License-Identifier: AGPL-3.0-only
// Fantay chip labels for the upstream chip ids (spec 02 §8.2). `home-hero/chip-labels.ts` asks here first, so
// with the shell on the active-type pill inside the composer reads the same words as the chip that set it
// (网页/应用设计, 图片, 视频, 代码动画, 社媒设计, 演示, 文档). Shell off → null, upstream labels stay.
import type { Dict } from '../../i18n/types';
import { isFantayShellEnabled } from '../shell/flags';
import { FANTAY_CREATION_CHIPS } from './creation-chips';

type Translate = (key: keyof Dict) => string;

const LABEL_KEY_BY_CHIP_ID: ReadonlyMap<string, keyof Dict> = new Map(
  FANTAY_CREATION_CHIPS.map((chip) => [chip.chipId, chip.labelKey] as const),
);

/** The Fantay label for `chipId` when the shell is on and the chip is one of the seven; else null. */
export function fantayHomeChipLabel(chipId: string, t: Translate, enabled: boolean = isFantayShellEnabled()): string | null {
  if (!enabled) return null;
  const key = LABEL_KEY_BY_CHIP_ID.get(chipId);
  return key ? t(key) : null;
}
