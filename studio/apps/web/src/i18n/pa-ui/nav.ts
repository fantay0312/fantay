// SPDX-License-Identifier: AGPL-3.0-only
// Fantay workspace copy, unit-owned (spec §18). Keys live under `pa.`; zh-CN/zh-TW read paNavZh, other locales paNavEn.
export const paNavEn = {
  'pa.nav.running': '{count} running',
  'pa.nav.waiting': '{count} need you',
} as const;
export const paNavZh: { [K in keyof typeof paNavEn]: string } = {
  'pa.nav.running': '{count} 项进行中',
  'pa.nav.waiting': '{count} 项等你处理',
};
