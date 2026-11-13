import { describe, expect, it } from 'vitest';
import { LOCALES } from '../../src/i18n/types';
import { communityForLocale } from '../../src/lib/community-links';

describe('community destinations', () => {
  it.each(LOCALES)('routes the %s UI to its community', (locale) => {
    const entry = communityForLocale(locale);
      expect(entry).toEqual({
        platform: 'feishu',
        href: 'https://applink.feishu.cn/client/chat/chatter/add_by_link?link_token=262i1aad-be96-4bb2-a764-6ab7cc189efa',
      });
  });
});
