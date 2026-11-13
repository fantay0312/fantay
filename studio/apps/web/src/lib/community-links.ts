import type { Locale } from '../i18n/types';
import { FANTAY_FEISHU_COMMUNITY_URL } from '@open-design/contracts';

export const COMMUNITY_FEISHU_URL = FANTAY_FEISHU_COMMUNITY_URL;
export const COMMUNITY_DISCORD_URL = 'https://discord.gg/cPVMctKUjy';

const FEISHU_COMMUNITY = { platform: 'feishu', href: COMMUNITY_FEISHU_URL } as const;
const DISCORD_COMMUNITY = { platform: 'discord', href: COMMUNITY_DISCORD_URL } as const;

/** The owner's Feishu group is the default support community in every locale. */
export function communityForLocale(_locale: Locale): typeof FEISHU_COMMUNITY | typeof DISCORD_COMMUNITY {
  return FEISHU_COMMUNITY;
}
